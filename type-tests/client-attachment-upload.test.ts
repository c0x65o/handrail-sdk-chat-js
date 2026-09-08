import {
  createChatClient,
  type ChatAttachmentUploadHandle,
  type ChatAttachmentUploadResult,
  type ChatAttachmentUploadTransport,
  type ClientAttachmentUploadState,
} from "../src/client/index.js";
import type { ConversationId } from "../src/contracts/identifiers.js";

const transport: ChatAttachmentUploadTransport = async ({
  upload,
  source,
  metadata,
  signal,
  onProgress,
}) => {
  const descriptor: string = upload.descriptor;
  const byteSource: Blob | ArrayBuffer | ArrayBufferView = source;
  const aborted: boolean = signal.aborted;
  onProgress(metadata.sizeBytes);
  void descriptor;
  void byteSource;
  void aborted;
  return { status: "uploaded" };
};

const client = createChatClient({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
  attachments: {
    transport,
    maxSafeTransferAttempts: 2,
    cleanupTimeoutMs: 500,
  },
});

const upload: ChatAttachmentUploadHandle = client.uploadAttachment({
  conversationId: "conversation-1" as ConversationId,
  metadata: {
    fileName: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 3,
  },
  source: new Uint8Array([1, 2, 3]),
  temporaryResource: { revoke() {} },
});
const state: ClientAttachmentUploadState = upload.state;
const result: Promise<ChatAttachmentUploadResult> = upload.completion;
upload.cancel();
void state;
void result;

// Provider internals cannot be authored into canonical upload state.
const invalidState: ClientAttachmentUploadState = {
  uploadId: "upload-1",
  conversationId: "conversation-1" as ConversationId,
  metadata: { fileName: "notes.txt", contentType: "text/plain", sizeBytes: 3 },
  status: "uploading",
  progress: { uploadedBytes: 1, totalBytes: 3 },
  // @ts-expect-error descriptors are ephemeral transport-only values
  descriptor: "provider-secret",
};
void invalidState;
