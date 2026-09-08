import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer as createViteServer } from "vite";
import { MAX_ATTACHMENT_SIZE_BYTES } from "@handrail/chat";

import { startChatLabBackend } from "./chat-lab-backend.mjs";
import { buildFlutterChatLab } from "./build-flutter-chat-lab.mjs";
import { createChatLabWebRtcServer } from "./chat-lab-webrtc-server.mjs";
import { chatLabBackendProvenance } from "./chat-lab-provenance.mjs";
import { flutterWebRoot as defaultFlutterWebRoot } from "../../../scripts/sdk-repositories.mjs";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const loopbackStoragePrefix = "/__chat-lab/storage";
const loopbackStorageMaxObjectBytes = MAX_ATTACHMENT_SIZE_BYTES;
const loopbackStorageMaxTotalBytes = 256 * 1024 * 1024;
const uploadCapabilityTtlMs = 15 * 60_000;
const downloadCapabilityTtlMs = 5 * 60_000;

const loopbackHostname = (hostname) =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";

const capabilityToken = () => randomBytes(32).toString("base64url");

const storageObjectKey = (tenantId, attachmentId) =>
  `chat-lab/${Buffer.from(tenantId, "utf8").toString("base64url")}/${Buffer.from(attachmentId, "utf8").toString("base64url")}`;

const exactStorageQuery = (url) => {
  const allowed = new Set(["key", "tenant", "token"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return undefined;
  const values = {};
  for (const name of allowed) {
    const entries = url.searchParams.getAll(name);
    if (
      entries.length !== 1 ||
      entries[0].length === 0 ||
      entries[0].length > 2_048 ||
      /[\p{Cc}\p{Cf}]/u.test(entries[0])
    ) return undefined;
    values[name] = entries[0];
  }
  return values;
};

const storageError = (response, statusCode, message, allow) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (allow !== undefined) response.setHeader("allow", allow);
  response.end(message);
};

const safeDownloadName = (value) => {
  const sanitized = value.replace(/[^\x20-\x7e]|["\\]/gu, "_").slice(0, 180);
  return sanitized.length === 0 ? "attachment" : sanitized;
};

export const createChatLabLoopbackStorage = ({ now = Date.now } = {}) => {
  if (typeof now !== "function") throw new TypeError("Chat Lab storage now must be a function");
  const objects = new Map();
  const uploads = new Map();
  const downloads = new Map();
  let origin;
  let closed = false;

  const instant = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError("Chat Lab storage now must return milliseconds");
    return value;
  };
  const reservedBytes = () => [...objects.values()].reduce(
    (total, record) => total + record.sizeBytes,
    0,
  );
  const requireOrigin = () => {
    if (closed || origin === undefined) throw new Error("Chat Lab storage is unavailable");
    return origin;
  };
  const capabilityUrl = (kind, record, token) => {
    const url = new URL(`${loopbackStoragePrefix}/${kind}`, requireOrigin());
    url.searchParams.set("tenant", record.tenantId);
    url.searchParams.set("key", record.objectKey);
    url.searchParams.set("token", token);
    return url.toString();
  };
  const removeDownload = (token) => {
    const entry = downloads.get(token);
    downloads.delete(token);
    objects.get(entry?.objectKey)?.downloadTokens.delete(token);
  };
  const pruneExpired = () => {
    const current = instant();
    for (const [token, entry] of uploads) {
      if (entry.expiresAtMs <= current) uploads.delete(token);
    }
    for (const [token, entry] of downloads) {
      if (entry.expiresAtMs <= current) removeDownload(token);
    }
  };
  const matches = (entry, record, query) =>
    entry !== undefined &&
    record !== undefined &&
    entry.tenantId === query.tenant &&
    entry.objectKey === query.key &&
    record.tenantId === query.tenant &&
    record.objectKey === query.key &&
    entry.attachmentId === record.attachmentId;

  const adapter = {
    async createUploadUrl(input) {
      requireOrigin();
      if (
        !Number.isSafeInteger(input.contentLengthBytes) ||
        input.contentLengthBytes < 0 ||
        input.contentLengthBytes > loopbackStorageMaxObjectBytes
      ) throw new Error("Chat Lab attachment exceeds the in-memory storage bound");
      const objectKey = storageObjectKey(input.actor.tenantId, input.attachmentId);
      let record = objects.get(objectKey);
      if (record === undefined) {
        if (reservedBytes() + input.contentLengthBytes > loopbackStorageMaxTotalBytes) {
          throw new Error("Chat Lab attachment storage capacity is exhausted");
        }
        record = {
          objectKey,
          tenantId: input.actor.tenantId,
          attachmentId: input.attachmentId,
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: input.contentLengthBytes,
          bytes: undefined,
          uploadToken: undefined,
          downloadTokens: new Set(),
        };
        objects.set(objectKey, record);
      } else if (
        record.tenantId !== input.actor.tenantId ||
        record.attachmentId !== input.attachmentId ||
        record.fileName !== input.fileName ||
        record.contentType !== input.contentType ||
        record.sizeBytes !== input.contentLengthBytes
      ) {
        throw new Error("Chat Lab attachment metadata changed after preparation");
      }
      if (record.uploadToken !== undefined) uploads.delete(record.uploadToken);
      const token = capabilityToken();
      const expiresAtMs = instant() + uploadCapabilityTtlMs;
      record.uploadToken = token;
      uploads.set(token, {
        tenantId: record.tenantId,
        attachmentId: record.attachmentId,
        objectKey,
        expiresAtMs,
      });
      return {
        objectKey,
        method: "PUT",
        url: capabilityUrl("upload", record, token),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    async verifyObject(input) {
      const record = objects.get(input.objectKey);
      if (
        record === undefined ||
        record.tenantId !== input.actor.tenantId ||
        record.attachmentId !== input.attachmentId ||
        record.bytes === undefined
      ) return { status: "rejected", reason: "missing_object" };
      if (record.bytes.length !== record.sizeBytes) {
        return { status: "rejected", reason: "size_mismatch" };
      }
      return {
        status: "verified",
        exists: true,
        sizeBytes: record.bytes.length,
        checksum: `sha256:${createHash("sha256").update(record.bytes).digest("hex")}`,
        contentType: record.contentType,
        safetyDisposition: "accepted",
      };
    },
    async createDownloadUrl(input) {
      pruneExpired();
      const record = objects.get(input.objectKey);
      if (
        record === undefined ||
        record.bytes === undefined ||
        record.tenantId !== input.actor.tenantId ||
        record.attachmentId !== input.attachmentId ||
        record.fileName !== input.fileName ||
        input.contentDisposition !== "attachment"
      ) throw new Error("Chat Lab attachment is unavailable");
      while (record.downloadTokens.size >= 16) {
        removeDownload(record.downloadTokens.values().next().value);
      }
      const token = capabilityToken();
      const expiresAtMs = instant() + downloadCapabilityTtlMs;
      record.downloadTokens.add(token);
      downloads.set(token, {
        tenantId: record.tenantId,
        attachmentId: record.attachmentId,
        objectKey: record.objectKey,
        fileName: record.fileName,
        expiresAtMs,
      });
      return {
        url: capabilityUrl("download", record, token),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    async deleteObject(input) {
      const record = objects.get(input.objectKey);
      if (
        record === undefined ||
        record.tenantId !== input.actor.tenantId ||
        record.attachmentId !== input.attachmentId
      ) return;
      if (record.uploadToken !== undefined) uploads.delete(record.uploadToken);
      for (const token of record.downloadTokens) downloads.delete(token);
      objects.delete(record.objectKey);
    },
    setOrigin(value) {
      if (closed) throw new Error("Chat Lab storage is closed");
      const parsed = new URL(value);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        !loopbackHostname(parsed.hostname) ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) throw new TypeError("Chat Lab storage origin must be an HTTP loopback origin");
      origin = parsed.origin;
    },
    snapshot() {
      return Object.freeze({
        objectCount: objects.size,
        byteCount: [...objects.values()].reduce(
          (total, record) => total + (record.bytes?.length ?? 0),
          0,
        ),
        uploadCapabilityCount: uploads.size,
        downloadCapabilityCount: downloads.size,
      });
    },
    async handle(request, response, next) {
      const url = new URL(request.url ?? "/", "http://chat-lab.invalid");
      const kind = url.pathname === `${loopbackStoragePrefix}/upload`
        ? "upload"
        : url.pathname === `${loopbackStoragePrefix}/download`
          ? "download"
          : undefined;
      if (kind === undefined) {
        next();
        return;
      }
      const query = exactStorageQuery(url);
      if (query === undefined) {
        storageError(response, 400, "Malformed storage capability");
        return;
      }
      pruneExpired();
      const record = objects.get(query.key);
      const capabilities = kind === "upload" ? uploads : downloads;
      const entry = capabilities.get(query.token);
      if (!matches(entry, record, query)) {
        storageError(response, 404, "Storage capability unavailable");
        return;
      }
      if (entry.expiresAtMs <= instant()) {
        if (kind === "upload") uploads.delete(query.token);
        else removeDownload(query.token);
        storageError(response, 410, "Storage capability expired");
        return;
      }
      if (kind === "upload") {
        if (request.method !== "PUT") {
          storageError(response, 405, "Upload method not allowed", "PUT");
          return;
        }
        if (request.headers["content-type"] !== record.contentType) {
          storageError(response, 415, "Upload content type does not match preparation");
          return;
        }
        if (
          (request.headers["content-encoding"] !== undefined &&
            request.headers["content-encoding"] !== "identity") ||
          request.headers["content-range"] !== undefined
        ) {
          storageError(response, 400, "Encoded or partial uploads are not accepted");
          return;
        }
        const declaredLength = request.headers["content-length"];
        if (
          declaredLength !== undefined &&
          (typeof declaredLength !== "string" ||
            !/^\d+$/u.test(declaredLength) ||
            Number(declaredLength) !== record.sizeBytes)
        ) {
          storageError(response, 400, "Upload size does not match preparation");
          return;
        }
        const chunks = [];
        let received = 0;
        for await (const chunk of request) {
          received += chunk.length;
          if (received > record.sizeBytes || received > loopbackStorageMaxObjectBytes) {
            storageError(response, 413, "Upload exceeds prepared size");
            return;
          }
          chunks.push(chunk);
        }
        if (received !== record.sizeBytes) {
          storageError(response, 400, "Upload size does not match preparation");
          return;
        }
        record.bytes = Buffer.concat(chunks, received);
        record.uploadToken = undefined;
        uploads.delete(query.token);
        response.statusCode = 204;
        response.setHeader("cache-control", "no-store");
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        storageError(response, 405, "Download method not allowed", "GET, HEAD");
        return;
      }
      if (record.bytes === undefined || entry.fileName !== record.fileName) {
        storageError(response, 404, "Storage capability unavailable");
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", record.contentType);
      response.setHeader("content-length", record.bytes.length);
      response.setHeader(
        "content-disposition",
        `${record.contentType.startsWith("image/") ? "inline" : "attachment"}; filename="${safeDownloadName(record.fileName)}"`,
      );
      response.setHeader("cache-control", "private, no-store");
      response.setHeader("cross-origin-resource-policy", "same-origin");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-content-type-options", "nosniff");
      if (request.method === "HEAD") response.end();
      else response.end(record.bytes);
    },
    async teardown() {
      if (closed) return;
      closed = true;
      origin = undefined;
      uploads.clear();
      downloads.clear();
      for (const record of objects.values()) {
        record.bytes = undefined;
        record.downloadTokens.clear();
      }
      objects.clear();
    },
  };
  return Object.freeze(adapter);
};

const flutterContentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

const parsePort = (value) => {
  const port = Number(value ?? 4167);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("CHAT_LAB_PORT/PORT must be a valid TCP port");
  }
  return port;
};

const stripChatPrefix = (path) => {
  const stripped = path.replace(/^\/api\/chat/u, "");
  return stripped.length === 0 ? "/" : stripped;
};

const serveFlutterChatLab = async (
  request,
  response,
  flutterWebRoot,
  flutterReady,
  next,
) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    next();
    return;
  }
  const url = new URL(request.url ?? "/", "http://chat-lab.invalid");
  let relativePath;
  if (url.pathname === "/__flutter-chat-lab/") {
    relativePath = "index.html";
  } else if (url.pathname.startsWith("/__flutter-chat-lab/")) {
    try {
      relativePath = decodeURIComponent(
        url.pathname.slice("/__flutter-chat-lab/".length),
      );
    } catch {
      response.statusCode = 400;
      response.end();
      return;
    }
  } else {
    next();
    return;
  }

  const root = path.resolve(flutterWebRoot);
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.statusCode = 404;
    response.end();
    return;
  }

  try {
    await flutterReady;
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    response.statusCode = 200;
    response.setHeader(
      "content-type",
      flutterContentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
    );
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-length", fileStat.size);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.statusCode = 503;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(
      "Flutter Chat Lab assets are unavailable. Run npm run build:flutter:lab.",
    );
  }
};

const chatLabHostPlugin = (
  backend,
  storage,
  flutterWebRoot,
  flutterReady,
  instanceId,
) => ({
  name: "handrail-chat-lab-host",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://chat-lab.invalid");
      if (url.pathname.startsWith(`${loopbackStoragePrefix}/`)) {
        void storage.handle(request, response, next).catch(() => {
          if (!response.headersSent) {
            storageError(response, 500, "Storage request failed");
          } else if (!response.writableEnded) {
            response.end();
          }
        });
        return;
      }
      if (
        url.pathname === "/" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        response.statusCode = 302;
        response.setHeader("location", `/chat-lab.html${url.search}`);
        response.setHeader("cache-control", "no-store");
        response.end();
        return;
      }
      if (url.pathname === "/__chat-lab/health") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify({ status: "ready" }));
        return;
      }
      if (url.pathname === "/__chat-lab/instance") {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify({ instanceId, seedProfile: backend.seedProfile, backend: chatLabBackendProvenance,
          ...(backend.prerequisites ? { prerequisites: backend.prerequisites.snapshot() } : {}) }));
        return;
      }
      if (url.pathname === "/__chat-lab/reply-styles") {
        if (!backend.prerequisites) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        if (request.method === "GET") {
          response.end(JSON.stringify(backend.prerequisites.snapshot()));
          return;
        }
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.setHeader("allow", "GET, POST");
          response.end();
          return;
        }
        // These controls only operate on this disposable lab schema. Require
        // JSON and reject browser cross-site requests before any mutation.
        if (request.headers["sec-fetch-site"] === "cross-site" ||
            request.headers["content-type"]?.split(";")[0] !== "application/json") {
          response.statusCode = 403;
          response.end();
          return;
        }
        void (async () => {
          try {
            let body = "";
            for await (const chunk of request) {
              body += chunk.toString();
              if (body.length > 1_024) {
                response.statusCode = 413;
                response.end();
                return;
              }
            }
            const input = JSON.parse(body);
            const result = await backend.prerequisites.execute(input);
            response.end(JSON.stringify(result));
          } catch (error) {
            response.statusCode = error instanceof TypeError || error instanceof SyntaxError ? 400 : 500;
            response.end(JSON.stringify({ error: "Reply-styles control failed" }));
          }
        })();
        return;
      }
      if (url.pathname === "/__chat-lab/direct-message-visual-read-state") {
        if (backend.directMessageVisualReadState === undefined) {
          response.statusCode = 404;
          response.end("Direct-message visual read state is unavailable");
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify(backend.directMessageVisualReadState));
        return;
      }
      if (url.pathname.startsWith("/__flutter-chat-lab/")) {
        void serveFlutterChatLab(
          request,
          response,
          flutterWebRoot,
          flutterReady,
          next,
        );
        return;
      }
      if (url.pathname !== "/__chat-lab/session") {
        next();
        return;
      }
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("allow", "GET");
        response.end();
        return;
      }
      const actor = backend.actors.find(({ id }) => id === url.searchParams.get("actor"));
      if (actor === undefined) {
        response.statusCode = 404;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("Unknown chat lab actor");
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(actor.credential);
    });
  },
});

export async function startChatLab(options = {}) {
  const bindHost = options.host ?? process.env.CHAT_LAB_HOST ?? "127.0.0.1";
  const storage = createChatLabLoopbackStorage({ now: options.storageNow });
  let backend;
  const media = createChatLabWebRtcServer({
    trustHandrailLoopbackProxy: ["127.0.0.1", "::1", "localhost"].includes(bindHost),
    iceServers: options.iceServers ?? JSON.parse(process.env.CHAT_LAB_ICE_SERVERS ?? "[]"),
    authorizeParticipant: async ({ roomId, tenantId, userId }) => {
      if (!backend) return false;
      const schema = `"${backend.harness.schema}"`;
      const result = await backend.harness.pool.query(
        `SELECT 1 FROM ${schema}.chat_huddle_sessions AS session
         JOIN ${schema}.chat_huddle_participants AS participant
           ON participant.tenant_id = session.tenant_id AND participant.huddle_session_id = session.id
         JOIN ${schema}.chat_conversation_members AS member
           ON member.tenant_id = session.tenant_id AND member.conversation_id = session.conversation_id
           AND member.user_id = participant.user_id
         WHERE session.provider_room_reference = $1 AND session.tenant_id = $2
           AND participant.user_id = $3 AND participant.left_at IS NULL
           AND session.status IN ('starting', 'active') AND member.state = 'active'`,
        [roomId, tenantId, userId],
      );
      return result.rowCount > 0;
    },
  });
  try {
    backend = await startChatLabBackend({ ...options, storage, media: media.adapter });
  } catch (error) {
    await media.close();
    throw error;
  }
  const instanceId = randomBytes(16).toString("hex");
  const flutterWebRoot = options.flutterWebRoot ??
    process.env.CHAT_LAB_FLUTTER_WEB_ROOT ??
    defaultFlutterWebRoot;
  const flutterReady = options.flutterReady ?? Promise.resolve();
  let vite;
  try {
    vite = await createViteServer({
      configFile: false,
      root: exampleRoot,
      appType: "spa",
      optimizeDeps: {
        noDiscovery: true,
        include: ["react", "react-dom/client", "react/jsx-dev-runtime", "react/jsx-runtime"],
      },
      plugins: [
        chatLabHostPlugin(
          backend,
          storage,
          flutterWebRoot,
          flutterReady,
          instanceId,
        ),
      ],
      resolve: {
        dedupe: ["react", "react-dom"],
      },
      server: {
        host: bindHost,
        port: parsePort(options.port ?? process.env.CHAT_LAB_PORT ?? process.env.PORT),
        strictPort: (options.port ?? process.env.CHAT_LAB_PORT ?? process.env.PORT) !== undefined,
        allowedHosts: [".dev.handrail-daas.com"],
        proxy: {
          "/api/chat": {
            target: backend.harness.endpoint,
            changeOrigin: false,
            ws: true,
            rewrite: stripChatPrefix,
          },
        },
      },
    });
    media.attach(vite.httpServer);
    await vite.listen();
  } catch (error) {
    await media.close();
    await vite?.close();
    await backend.harness.teardown();
    throw error;
  }

  const address = vite.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    await media.close();
    await vite.close();
    await backend.harness.teardown();
    throw new Error("The chat lab web server did not expose a TCP address");
  }
  const configuredHost = options.host ?? process.env.CHAT_LAB_HOST ?? "127.0.0.1";
  const browserHost = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost;
  const origin = `http://${browserHost}:${address.port}`;
  try {
    storage.setOrigin(origin);
  } catch (error) {
    await media.close();
    await vite.close();
    await backend.harness.teardown();
    throw error;
  }
  let closePromise;
  return Object.freeze({
    ...backend,
    instanceId,
    origin,
    storageSnapshot: () => storage.snapshot(),
    async close() {
      closePromise ??= (async () => {
        await media.close();
        await vite.close();
        await backend.harness.teardown();
      })();
      return closePromise;
    },
  });
}

const isMain = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));

if (isMain) {
  const flutterReady = buildFlutterChatLab();
  void flutterReady.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
  });
  const lab = await startChatLab({ flutterReady });
  console.log(`Chat Lab backend provenance ${JSON.stringify({ instanceId: lab.instanceId, backend: chatLabBackendProvenance })}`);
  console.log(`React real-stack Chat Lab ready at ${lab.origin}/chat-lab.html`);
  console.log(`Default React message renderer Lab ready at ${lab.origin}/reminder-chat-lab.html`);
  console.log(`Legacy React Chat Lab alias ready at ${lab.origin}/react-chat-lab.html`);
  void flutterReady.then(() => {
    console.log(`Flutter HandrailMessageTimeline Lab ready at ${lab.origin}/__flutter-chat-lab/`);
  }, () => {});

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void lab.close().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
