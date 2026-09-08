import {
  parseAbortAttachmentInput,
  parseAbortAttachmentResult,
  parseAttachmentMetadata,
  parseFinalizeAttachmentInput,
  parseFinalizeAttachmentResult,
  parsePrepareAttachmentInput,
  parsePrepareAttachmentResult,
  type AttachmentMetadata,
  type AttachmentLifecycleState,
  type AttachmentUploadDescriptor,
  type FinalizedAttachmentState,
  type PendingAttachmentState,
  type RejectedAttachmentState,
} from "../contracts/attachment-transport.js";
import type { ConversationId } from "../contracts/identifiers.js";
import type { MessageAttachmentMetadata } from "../contracts/message-timeline.js";
import {
  createChatCommandDispatcher,
  type ChatClientFetch,
  type ChatCommandDescriptor,
  type ChatCommandRuntimeOptions,
} from "./command-dispatcher.js";
import type {
  ClientAttachmentUploadState,
  NormalizedChatCache,
} from "./normalized-cache.js";

export type ChatAttachmentByteSource = Blob | ArrayBuffer | ArrayBufferView;

export interface ChatAttachmentUploadTransportRequest {
  /** Opaque and ephemeral: transports may consume this value but must never retain or expose it. */
  readonly upload: AttachmentUploadDescriptor;
  readonly source: ChatAttachmentByteSource;
  readonly metadata: AttachmentMetadata;
  readonly signal: AbortSignal;
  /** Reports cumulative transferred bytes. Regressions and values above the declared size are clamped. */
  readonly onProgress: (uploadedBytes: number) => void;
}

export type ChatAttachmentUploadTransportResult =
  | { readonly status: "uploaded" }
  | {
      readonly status: "failed";
      /** The transport must opt in only when replaying the byte transfer is demonstrably safe. */
      readonly retry: "safe" | "never";
    };

export type ChatAttachmentUploadTransport = (
  request: ChatAttachmentUploadTransportRequest,
) => Promise<ChatAttachmentUploadTransportResult>;

export interface ChatAttachmentTemporaryResource {
  /** Idempotency is recommended; client code invokes this at most once. */
  revoke(): void;
}

export interface ChatAttachmentUploadInput {
  readonly conversationId: ConversationId;
  readonly metadata: AttachmentMetadata;
  readonly source: ChatAttachmentByteSource;
  readonly signal?: AbortSignal;
  /** Optional SDK-owned preview/object resource kept outside canonical state. */
  readonly temporaryResource?: ChatAttachmentTemporaryResource;
}

export type ChatAttachmentUploadFailurePhase =
  | "prepare"
  | "transfer"
  | "finalize"
  | "abort";

export type ChatAttachmentUploadResult =
  | {
      readonly status: "finalized";
      readonly attachment: FinalizedAttachmentState;
    }
  | {
      readonly status: "rejected";
      readonly attachment: RejectedAttachmentState;
    }
  | { readonly status: "cancelled" }
  | {
      readonly status: "failed";
      readonly phase: ChatAttachmentUploadFailurePhase;
    };

export interface ChatAttachmentUploadHandle {
  readonly uploadId: string;
  readonly state: ClientAttachmentUploadState;
  readonly completion: Promise<ChatAttachmentUploadResult>;
  cancel(): void;
}

export interface ChatAttachmentUploadOptions {
  readonly transport?: ChatAttachmentUploadTransport;
  readonly generateUploadId?: () => string;
  readonly generateIdempotencyKey?: (
    phase: "prepare" | "finalize" | "abort",
    uploadId: string,
  ) => string;
  /** Maximum attempts for transfers whose transport result explicitly says `retry: "safe"`. */
  readonly maxSafeTransferAttempts?: number;
  readonly cleanupTimeoutMs?: number;
}

interface AttachmentUploadManagerConfig {
  readonly endpoint: string;
  readonly getAccessToken: () => string | Promise<string>;
  readonly fetch: ChatClientFetch;
  readonly commands?: ChatCommandRuntimeOptions;
  readonly cache: NormalizedChatCache;
  readonly options?: ChatAttachmentUploadOptions;
  readonly generateIdentity: (prefix: string) => string;
}

export interface ChatAttachmentUploadManager {
  upload(input: ChatAttachmentUploadInput): ChatAttachmentUploadHandle;
  closeActive(): void;
}

interface ActiveUpload {
  readonly uploadId: string;
  readonly conversationId: ConversationId;
  readonly metadata: AttachmentMetadata;
  readonly source: ChatAttachmentByteSource;
  readonly controller: AbortController;
  readonly prepareKey: string;
  readonly finalizeKey: string;
  readonly abortKey: string;
  readonly temporaryResource?: ChatAttachmentTemporaryResource;
  pending?: PendingAttachmentState;
  uploadDescriptor?: AttachmentUploadDescriptor;
  uploadedBytes: number;
  transferSettled: boolean;
  resourceRevoked: boolean;
  abortPromise?: Promise<boolean>;
}

const ABORTED = Symbol("attachment-upload-aborted");

interface AttachmentUploadInstructions {
  readonly url: string;
  readonly method: "PUT" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
}

const canonicalUploadInstructions = (
  descriptor: string,
): AttachmentUploadInstructions | undefined => {
  if (!/^[0-9A-Za-z_-]+$/u.test(descriptor) || typeof globalThis.atob !== "function") {
    return undefined;
  }
  try {
    const base64 = descriptor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = globalThis.atob(padded);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    const value = JSON.parse(decoded) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const allowed = new Set(["url", "method", "headers"]);
    if (
      Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record.url !== "string" ||
      (record.method !== "PUT" && record.method !== "POST")
    ) return undefined;
    if (record.headers === undefined) {
      return Object.freeze({ url: record.url, method: record.method });
    }
    if (
      typeof record.headers !== "object" ||
      record.headers === null ||
      Array.isArray(record.headers)
    ) return undefined;
    const headers: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(record.headers)) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name) ||
        typeof headerValue !== "string" ||
        headerValue.length > 2_048 ||
        /[\r\n]/u.test(headerValue)
      ) return undefined;
      headers[name] = headerValue;
    }
    return Object.freeze({
      url: record.url,
      method: record.method,
      headers: Object.freeze(headers),
    });
  } catch {
    return undefined;
  }
};

const uploadInstructions = (descriptor: string): AttachmentUploadInstructions =>
  canonicalUploadInstructions(descriptor) ?? Object.freeze({
    url: descriptor,
    method: "PUT",
  });

const defaultUploadTransport: ChatAttachmentUploadTransport = async ({
  upload,
  source,
  signal,
  onProgress,
}) => {
  const instructions = uploadInstructions(upload.descriptor);
  let target: URL;
  try {
    target = new URL(
      instructions.url,
      typeof (globalThis as { location?: { href?: unknown } }).location?.href === "string"
        ? (globalThis as { location: { href: string } }).location.href
        : undefined,
    );
  } catch {
    return Object.freeze({ status: "failed", retry: "never" });
  }
  if (
    (target.protocol !== "https:" && target.protocol !== "http:") ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    typeof globalThis.fetch !== "function"
  ) return Object.freeze({ status: "failed", retry: "never" });
  try {
    const response = await globalThis.fetch(target, {
      method: instructions.method,
      ...(instructions.headers === undefined ? {} : { headers: instructions.headers }),
      body: source as never,
      signal,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return Object.freeze({ status: "failed", retry: "never" });
    onProgress(sourceSize(source));
    return Object.freeze({ status: "uploaded" });
  } catch {
    return Object.freeze({ status: "failed", retry: "never" });
  }
};

const sourceSize = (source: ChatAttachmentByteSource): number => {
  if (typeof Blob !== "undefined" && source instanceof Blob) return source.size;
  if (source instanceof ArrayBuffer) return source.byteLength;
  if (ArrayBuffer.isView(source)) return source.byteLength;
  return -1;
};

const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof value === "object" &&
  value !== null &&
  "aborted" in value &&
  typeof (value as AbortSignal).addEventListener === "function" &&
  typeof (value as AbortSignal).removeEventListener === "function";

const raceWithAbort = <Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(ABORTED);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(undefined);
      },
    );
  });
};

const createFinalizeDescriptor = (
  expectedInput: ReturnType<typeof parseFinalizeAttachmentInput>,
  previousState: PendingAttachmentState,
): ChatCommandDescriptor<
  typeof expectedInput,
  typeof expectedInput,
  ReturnType<typeof parseFinalizeAttachmentResult>
> => Object.freeze({
  name: "attachment.finalize",
  method: "PATCH",
  path: `/attachments/${encodeURIComponent(expectedInput.attachmentId)}/lifecycle`,
  retry: "safe",
  validateInput: (input: typeof expectedInput) => parseFinalizeAttachmentInput(input),
  parseResult: (value: unknown) => parseFinalizeAttachmentResult(value, expectedInput, { previousState }),
});

const createAbortDescriptor = (
  expectedInput: ReturnType<typeof parseAbortAttachmentInput>,
  previousState: PendingAttachmentState,
): ChatCommandDescriptor<
  typeof expectedInput,
  typeof expectedInput,
  ReturnType<typeof parseAbortAttachmentResult>
> => Object.freeze({
  name: "attachment.abort",
  method: "PATCH",
  path: `/attachments/${encodeURIComponent(expectedInput.attachmentId)}/lifecycle`,
  retry: "safe",
  validateInput: (input: typeof expectedInput) => parseAbortAttachmentInput(input),
  parseResult: (value: unknown) => parseAbortAttachmentResult(value, expectedInput, { previousState }),
});

export function createChatAttachmentUploadManager(
  config: AttachmentUploadManagerConfig,
): ChatAttachmentUploadManager {
  const dispatcher = createChatCommandDispatcher({
    endpoint: config.endpoint,
    getAccessToken: config.getAccessToken,
    fetch: config.fetch,
    ...(config.commands === undefined ? {} : { options: config.commands }),
  });
  const transport = config.options?.transport ?? defaultUploadTransport;
  if (typeof transport !== "function") throw new TypeError("Invalid attachment upload transport");
  const maxSafeTransferAttempts = config.options?.maxSafeTransferAttempts ?? 2;
  const cleanupTimeoutMs = config.options?.cleanupTimeoutMs ?? 1_000;
  if (!Number.isSafeInteger(maxSafeTransferAttempts) || maxSafeTransferAttempts < 1 || maxSafeTransferAttempts > 5) {
    throw new TypeError("Invalid safe attachment transfer attempt limit");
  }
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 10_000) {
    throw new TypeError("Invalid attachment cleanup timeout");
  }
  const active = new Map<string, ActiveUpload>();
  const generateUploadId = config.options?.generateUploadId ?? (() => config.generateIdentity("upload"));
  const generateIdempotencyKey = config.options?.generateIdempotencyKey ??
    ((phase: "prepare" | "finalize" | "abort") => config.generateIdentity(`attachment-${phase}`));

  const revokeResource = (record: ActiveUpload): void => {
    if (record.resourceRevoked) return;
    record.resourceRevoked = true;
    try {
      record.temporaryResource?.revoke();
    } catch {
      // Resource cleanup is intentionally best effort and never leaks thrown values.
    }
  };

  const setState = (
    record: ActiveUpload,
    status: ClientAttachmentUploadState["status"],
    attachment: AttachmentLifecycleState | undefined = record.pending,
    messageMetadata?: MessageAttachmentMetadata,
  ): ClientAttachmentUploadState => {
    const state: ClientAttachmentUploadState = Object.freeze({
      uploadId: record.uploadId,
      conversationId: record.conversationId,
      metadata: record.metadata,
      status,
      progress: Object.freeze({
        uploadedBytes: record.uploadedBytes,
        totalBytes: record.metadata.sizeBytes,
      }),
      ...(attachment === undefined ? {} : { attachment }),
    });
    config.cache.setAttachmentUploadState(state, messageMetadata);
    return state;
  };

  const abortPrepared = (record: ActiveUpload): Promise<boolean> => {
    if (record.pending === undefined) return Promise.resolve(true);
    if (record.abortPromise !== undefined) return record.abortPromise;
    const pending = record.pending;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), cleanupTimeoutMs);
    const input = parseAbortAttachmentInput({
      operation: "abort_attachment",
      attachmentId: pending.attachmentId,
      idempotencyKey: record.abortKey,
    });
    record.abortPromise = dispatcher.dispatch(
      createAbortDescriptor(input, pending),
      input,
      { idempotencyKey: input.idempotencyKey, signal: controller.signal },
    ).then((result) => {
      if (result.status !== "success") return false;
      setState(record, "abandoned", result.value.attachment);
      return true;
    }).finally(() => globalThis.clearTimeout(timer));
    return record.abortPromise;
  };

  const run = async (record: ActiveUpload): Promise<ChatAttachmentUploadResult> => {
    try {
      const prepareInput = parsePrepareAttachmentInput({
        operation: "prepare_attachment",
        metadata: record.metadata,
        idempotencyKey: record.prepareKey,
      });
      const prepareDescriptor = Object.freeze({
        name: "attachment.prepare",
        method: "POST" as const,
        path: `/conversations/${encodeURIComponent(record.conversationId)}/attachments`,
        retry: "safe" as const,
        validateInput: (input: typeof prepareInput) => parsePrepareAttachmentInput(input),
        parseResult: (value: unknown) => parsePrepareAttachmentResult(value, prepareInput),
      });
      const prepared = await dispatcher.dispatch(prepareDescriptor, prepareInput, {
        idempotencyKey: prepareInput.idempotencyKey,
        signal: record.controller.signal,
      });
      if (prepared.status !== "success") {
        setState(record, record.controller.signal.aborted ? "cancelled" : "failed", undefined);
        return record.controller.signal.aborted
          ? Object.freeze({ status: "cancelled" })
          : Object.freeze({ status: "failed", phase: "prepare" });
      }
      record.pending = prepared.value.attachment;
      const uploadDescriptor = prepared.value.upload;
      record.uploadDescriptor = uploadDescriptor;
      setState(record, "pending");
      if (record.controller.signal.aborted) {
        await abortPrepared(record);
        return Object.freeze({ status: "cancelled" });
      }

      setState(record, "uploading");
      let transferred = false;
      for (let transferAttempt = 1; transferAttempt <= maxSafeTransferAttempts; transferAttempt += 1) {
        let outcome: ChatAttachmentUploadTransportResult;
        try {
          outcome = await raceWithAbort(transport({
            upload: uploadDescriptor,
            source: record.source,
            metadata: record.metadata,
            signal: record.controller.signal,
            onProgress(uploadedBytes) {
              if (record.transferSettled || record.controller.signal.aborted || !Number.isFinite(uploadedBytes)) return;
              record.uploadedBytes = Math.max(
                record.uploadedBytes,
                Math.min(record.metadata.sizeBytes, Math.max(0, Math.floor(uploadedBytes))),
              );
              setState(record, "uploading");
            },
          }), record.controller.signal);
        } catch {
          outcome = Object.freeze({ status: "failed", retry: "never" });
        }
        if (outcome.status === "uploaded") {
          transferred = true;
          break;
        }
        if (outcome.retry !== "safe" || transferAttempt === maxSafeTransferAttempts) break;
      }
      record.transferSettled = true;
      if (!transferred || record.controller.signal.aborted) {
        const cancelled = record.controller.signal.aborted;
        const aborted = await abortPrepared(record);
        if (!aborted) setState(record, cancelled ? "cancelled" : "failed");
        return cancelled
          ? Object.freeze({ status: "cancelled" })
          : Object.freeze({ status: "failed", phase: "transfer" });
      }
      record.uploadedBytes = record.metadata.sizeBytes;
      setState(record, "finalizing");
      const finalizeInput = parseFinalizeAttachmentInput({
        operation: "finalize_attachment",
        attachmentId: record.pending.attachmentId,
        idempotencyKey: record.finalizeKey,
      });
      const finalized = await dispatcher.dispatch(
        createFinalizeDescriptor(finalizeInput, record.pending),
        finalizeInput,
        { idempotencyKey: finalizeInput.idempotencyKey, signal: record.controller.signal },
      );
      if (finalized.status !== "success") {
        const cancelled = record.controller.signal.aborted;
        const aborted = await abortPrepared(record);
        if (!aborted) setState(record, cancelled ? "cancelled" : "failed");
        return cancelled
          ? Object.freeze({ status: "cancelled" })
          : Object.freeze({ status: "failed", phase: "finalize" });
      }
      if (finalized.value.outcome === "rejected") {
        const attachment = finalized.value.attachment;
        if (attachment.status !== "rejected") {
          setState(record, "failed");
          return Object.freeze({ status: "failed", phase: "finalize" });
        }
        setState(record, "rejected", attachment);
        return Object.freeze({ status: "rejected", attachment });
      }
      const attachment = finalized.value.attachment;
      if (attachment.status !== "finalized") {
        setState(record, "failed");
        return Object.freeze({ status: "failed", phase: "finalize" });
      }
      const messageMetadata: MessageAttachmentMetadata = Object.freeze({
        attachmentId: attachment.attachmentId,
        fileName: attachment.metadata.fileName,
        contentType: attachment.metadata.contentType,
        sizeBytes: attachment.metadata.sizeBytes,
        downloadUrl: `${config.endpoint}/attachments/${encodeURIComponent(attachment.attachmentId)}/download`,
      });
      setState(record, "finalized", attachment, messageMetadata);
      return Object.freeze({ status: "finalized", attachment });
    } finally {
      record.transferSettled = true;
      delete record.uploadDescriptor;
      revokeResource(record);
      active.delete(record.uploadId);
    }
  };

  return Object.freeze({
    upload(input: ChatAttachmentUploadInput): ChatAttachmentUploadHandle {
      let metadata: AttachmentMetadata;
      if (
        typeof input !== "object" || input === null ||
        typeof input.conversationId !== "string" || input.conversationId.trim().length === 0 ||
        (input.signal !== undefined && !isAbortSignal(input.signal)) ||
        (input.temporaryResource !== undefined && typeof input.temporaryResource.revoke !== "function")
      ) throw new TypeError("Invalid attachment upload input");
      metadata = Object.freeze(parseAttachmentMetadata(input.metadata));
      if (sourceSize(input.source) !== metadata.sizeBytes) {
        throw new TypeError("Attachment byte source size does not match metadata");
      }
      const uploadId = generateUploadId();
      if (typeof uploadId !== "string" || uploadId.trim().length === 0 || active.has(uploadId)) {
        throw new TypeError("Invalid or duplicate attachment upload id");
      }
      const record: ActiveUpload = {
        uploadId,
        conversationId: input.conversationId,
        metadata,
        source: input.source,
        controller: new AbortController(),
        prepareKey: generateIdempotencyKey("prepare", uploadId),
        finalizeKey: generateIdempotencyKey("finalize", uploadId),
        abortKey: generateIdempotencyKey("abort", uploadId),
        ...(input.temporaryResource === undefined ? {} : { temporaryResource: input.temporaryResource }),
        uploadedBytes: 0,
        transferSettled: false,
        resourceRevoked: false,
      };
      active.set(uploadId, record);
      setState(record, "preparing", undefined);
      const callerAbort = () => record.controller.abort();
      input.signal?.addEventListener("abort", callerAbort, { once: true });
      if (input.signal?.aborted === true) record.controller.abort();
      const completion = run(record).finally(() =>
        input.signal?.removeEventListener("abort", callerAbort),
      );
      return Object.freeze({
        uploadId,
        get state() {
          return config.cache.getState().attachmentUploads[uploadId]!;
        },
        completion,
        cancel() {
          record.controller.abort();
        },
      }) as ChatAttachmentUploadHandle;
    },
    closeActive(): void {
      for (const record of [...active.values()]) record.controller.abort();
      dispatcher.closeActive();
    },
  });
}
