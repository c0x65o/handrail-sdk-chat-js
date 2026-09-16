import { createChatServer as createRuntime } from "@handrail/chat/server";

// HTTP boundary fixtures do not exercise background delivery or maintenance.
// Stop synchronously before their scheduled first poll can consume scripted SQL.
// Real PostgreSQL dispatcher/maintenance suites retain the running workers.
export function createChatServer(options) {
  const runtime = createRuntime(options);
  void runtime.outboxPublisher.stop();
  void runtime.postgresMaintenance.stop();
  void runtime.attachmentCleanupDispatcher?.stop();
  void runtime.auditDispatcher?.stop();
  void runtime.notificationDispatcher?.stop();
  return runtime;
}
