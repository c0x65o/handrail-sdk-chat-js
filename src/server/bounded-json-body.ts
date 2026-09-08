import type { IncomingMessage } from "node:http";

export const readBoundedJsonBody = async (
  request: IncomingMessage,
  maxBytes: number,
  invalidRequest: () => Error,
): Promise<unknown> => {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const contentLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 1 ||
      contentLength > maxBytes
    ) {
      throw invalidRequest();
    }
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const unsafeChunk of request) {
    const chunk = Buffer.isBuffer(unsafeChunk)
      ? unsafeChunk
      : Buffer.from(unsafeChunk as string);
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maxBytes) {
      throw invalidRequest();
    }
    chunks.push(chunk);
  }
  if (receivedBytes === 0) {
    throw invalidRequest();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw invalidRequest();
  }
};
