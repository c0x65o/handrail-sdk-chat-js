import {
  parseAttachmentMutationResult,
  parseAttachmentTransportResult,
  parseAttachmentTransportInput,
  type AbortAttachmentInput,
  type AttachedAttachmentState,
  type AttachmentDownloadDescriptor,
  type AttachmentId,
  type AttachmentMetadata,
  type AttachmentMutationResult,
  type AttachmentTransportInput,
  type FinalizeAttachmentInput,
  type FinalizedAttachmentState,
  type GetAttachmentDownloadInput,
  type MessageId,
  type PrepareAttachmentInput,
  type PrepareAttachmentResult,
} from "../src/index.js";
import {
  parseAttachmentTransportInput as parseClientAttachmentTransportInput,
} from "../src/client/index.js";
import {
  parseAttachmentMutationResult as parseServerAttachmentMutationResult,
} from "../src/server/index.js";

const attachmentId = "attachment-1" as AttachmentId;
const messageId = "message-1" as MessageId;
const checksum = `sha256:${"a".repeat(64)}`;

const metadata: AttachmentMetadata = {
  fileName: "report.pdf",
  contentType: "application/pdf",
  sizeBytes: 42,
};
const prepareInput: PrepareAttachmentInput = {
  operation: "prepare_attachment",
  metadata,
  idempotencyKey: "prepare-1",
};
const finalizeInput: FinalizeAttachmentInput = {
  operation: "finalize_attachment",
  attachmentId,
  idempotencyKey: "finalize-1",
};
const abortInput: AbortAttachmentInput = {
  operation: "abort_attachment",
  attachmentId,
  idempotencyKey: "abort-1",
};
const downloadInput: GetAttachmentDownloadInput = {
  operation: "get_attachment_download",
  attachmentId,
  messageId,
};

// @ts-expect-error State-changing prepare requires idempotency.
const prepareWithoutIdempotency: PrepareAttachmentInput = {
  operation: "prepare_attachment",
  metadata,
};
// @ts-expect-error State-changing abort requires idempotency.
const abortWithoutIdempotency: AbortAttachmentInput = {
  operation: "abort_attachment",
  attachmentId,
};
// @ts-expect-error Finalization requires idempotency.
const finalizeWithoutIdempotency: FinalizeAttachmentInput = {
  operation: "finalize_attachment",
  attachmentId,
};

const executableMetadata: AttachmentMetadata = {
  fileName: "payload.exe",
  // @ts-expect-error Executable content is outside the supported policy.
  contentType: "application/x-msdownload",
  sizeBytes: 42,
};
const parameterizedMetadata: AttachmentMetadata = {
  fileName: "report.pdf",
  // @ts-expect-error Content types must be canonical and parameter-free.
  contentType: "application/pdf; charset=binary",
  sizeBytes: 42,
};

const tenantSpoof: PrepareAttachmentInput = {
  ...prepareInput,
  // @ts-expect-error Tenant identity comes from trusted server context.
  tenantId: "tenant-spoof",
};
const uploaderSpoof: PrepareAttachmentInput = {
  ...prepareInput,
  // @ts-expect-error Uploader identity comes from trusted server context.
  uploaderUserId: "user-spoof",
};
const actorSpoof: FinalizeAttachmentInput = {
  ...finalizeInput,
  // @ts-expect-error Actor identity comes from trusted server context.
  actorUserId: "user-spoof",
};
const authorizationSpoof: AbortAttachmentInput = {
  ...abortInput,
  // @ts-expect-error Authorization is resolved from the trusted host request.
  authorization: "Bearer spoof",
};
const ownershipSpoof: GetAttachmentDownloadInput = {
  ...downloadInput,
  // @ts-expect-error Attachment/message identifiers are claims, not ownership assertions.
  ownerId: "user-spoof",
};
const storageKeySpoof: FinalizeAttachmentInput = {
  ...finalizeInput,
  // @ts-expect-error Unrestricted storage keys never enter public transport.
  storageKey: "tenant/private/object",
};
const providerSpoof: PrepareAttachmentInput = {
  ...prepareInput,
  // @ts-expect-error Provider selection is internal to the host adapter.
  provider: "vendor",
};
const clientMetadataClaim: FinalizeAttachmentInput = {
  ...finalizeInput,
  // @ts-expect-error Finalization metadata comes from trusted storage inspection.
  metadata: { sizeBytes: 42, checksum },
};

const downloadDescriptor: AttachmentDownloadDescriptor = {
  kind: "opaque_attachment_download",
  descriptor: "opaque-download",
  expiresAt: "2026-08-26T12:04:00.000Z",
};
const signedDownloadDescriptor: AttachmentDownloadDescriptor = {
  ...downloadDescriptor,
  // @ts-expect-error Signatures stay behind the opaque descriptor field.
  signature: "provider-signature",
};

const attached: AttachedAttachmentState = {
  status: "attached",
  attachmentId,
  metadata,
  createdAt: "2026-08-26T12:00:30.000Z",
  expiresAt: "2026-08-26T13:00:30.000Z",
  messageId,
  checksum,
  attachedAt: "2026-08-26T12:05:00.000Z",
};
const attachedWithUploader: AttachedAttachmentState = {
  ...attached,
  // @ts-expect-error Public attachment state never exposes uploader identity.
  uploaderUserId: "user-1",
};
const finalized: FinalizedAttachmentState = {
  status: "finalized",
  attachmentId,
  metadata,
  createdAt: "2026-08-26T12:00:30.000Z",
  expiresAt: "2026-08-26T13:00:30.000Z",
  checksum,
  finalizedAt: "2026-08-26T12:05:00.000Z",
};
const finalizeResult: AttachmentMutationResult = {
  operation: "finalize_attachment",
  reconciliationStatus: "applied",
  idempotencyKey: finalizeInput.idempotencyKey,
  attachmentId,
  outcome: "finalized",
  attachment: finalized,
};
const typedPrepareResult = parseAttachmentTransportResult(
  {
    operation: "prepare_attachment",
    reconciliationStatus: "applied",
    idempotencyKey: prepareInput.idempotencyKey,
    attachment: {
      status: "pending",
      attachmentId,
      metadata,
      createdAt: "2026-08-26T12:00:30.000Z",
      expiresAt: "2026-08-26T13:00:30.000Z",
    },
    upload: {
      kind: "opaque_attachment_upload",
      descriptor: "opaque-upload",
      expiresAt: "2026-08-26T12:10:00.000Z",
    },
  },
  prepareInput,
  { now: "2026-08-26T12:00:00.000Z" },
);
const typedPendingStatus: "pending" = typedPrepareResult.attachment.status;

const browserParser: typeof parseAttachmentTransportInput =
  parseClientAttachmentTransportInput;
const serverParser: typeof parseAttachmentMutationResult =
  parseServerAttachmentMutationResult;

function narrowInput(input: AttachmentTransportInput): AttachmentId | AttachmentMetadata {
  if (input.operation === "prepare_attachment") return input.metadata;
  if (input.operation === "finalize_attachment") {
    const claimedAttachment: AttachmentId = input.attachmentId;
    void claimedAttachment;
  }
  return input.attachmentId;
}

function narrowResult(result: AttachmentMutationResult): string {
  if (result.operation === "prepare_attachment") {
    const pending: "pending" = result.attachment.status;
    const uploadKind: "opaque_attachment_upload" = result.upload.kind;
    void [pending, uploadKind];
  } else if (result.operation === "finalize_attachment") {
    const outcome: "finalized" | "rejected" = result.outcome;
    void outcome;
  } else {
    const terminal: "abandoned" = result.attachment.status;
    void terminal;
  }
  return result.idempotencyKey;
}

parseAttachmentTransportInput(prepareInput);
parseAttachmentTransportInput(finalizeInput, {
  now: "2026-08-26T12:00:00.000Z",
});
parseAttachmentMutationResult(finalizeResult, finalizeInput, {
  now: "2026-08-26T12:00:00.000Z",
});
narrowInput(downloadInput);
narrowResult(finalizeResult);

void [
  prepareWithoutIdempotency,
  abortWithoutIdempotency,
  finalizeWithoutIdempotency,
  executableMetadata,
  parameterizedMetadata,
  tenantSpoof,
  uploaderSpoof,
  actorSpoof,
  authorizationSpoof,
  ownershipSpoof,
  storageKeySpoof,
  providerSpoof,
  clientMetadataClaim,
  signedDownloadDescriptor,
  attachedWithUploader,
  browserParser,
  serverParser,
  typedPendingStatus,
];

void ({} as PrepareAttachmentResult);
