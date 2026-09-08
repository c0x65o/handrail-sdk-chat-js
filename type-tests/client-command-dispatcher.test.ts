import {
  createChatClient,
  type ChatCommandDescriptor,
  type ChatCommandResult,
} from "../src/client/index.js";

interface SendInput {
  readonly message: string;
}

interface SendBody {
  readonly content: string;
}

interface SendResult {
  readonly messageId: string;
}

const descriptor = {
  name: "message.send",
  method: "POST",
  path: "/messages",
  retry: "safe",
  validateInput(input) {
    return { content: input.message };
  },
  parseResult(value) {
    return value as SendResult;
  },
} satisfies ChatCommandDescriptor<SendInput, SendBody, SendResult>;

const client = createChatClient({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
  commands: {
    retry: {
      maxAttempts: 3,
      maxAuthRefreshes: 1,
      backoffMs: (retryNumber) => retryNumber * 10,
    },
    generateIdempotencyKey: () => "key",
  },
});

const result: Promise<ChatCommandResult<SendResult>> = client.dispatch(
  descriptor,
  { message: "hello" },
  { idempotencyKey: "caller-key", signal: new AbortController().signal },
);

client.dispatch(
  descriptor,
  // @ts-expect-error Message content must be a string.
  { message: 42 },
);

createChatClient({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
  commands: {
    retry: {
      // @ts-expect-error Authentication refresh is strictly zero or one.
      maxAuthRefreshes: 2,
    },
  },
});

void result;
