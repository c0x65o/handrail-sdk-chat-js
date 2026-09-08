import { parseKnownDurableEvent } from "../contracts/generated/durable-events.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import {
  isReplyStyle, supportsReplyStylePreference, parseReplyStylePreferenceState,
  parseUpdateReplyStylePreferenceInput, parseUpdateReplyStylePreferenceResult,
  type ReplyStyle, type ReplyStylePreferenceState, type UpdateReplyStylePreferenceInput,
  type UpdateReplyStylePreferenceResult,
} from "../contracts/reply-style-preference.js";
import type { ChatCommandDispatcher } from "./command-dispatcher.js";
import type { NormalizedChatCache } from "./normalized-cache.js";
import type { ChatSnapshotReader } from "./snapshot-reader.js";

export interface ChatReplyStyleConfiguration {
  /** Unknown host values safely resolve to Current without falling through. */
  readonly hostDefault?: string;
  readonly enforcedOverride?: string;
}
export interface ChatReplyStyleState {
  readonly effectiveStyle: ReplyStyle;
  readonly origin: "override" | "saved" | "host_default" | "fallback";
  readonly resolutionReason: "supported" | "unsupported_value";
  /** Undefined means unresolved, not an authoritative absence. */
  readonly confirmedPreference: ReplyStylePreferenceState | undefined;
  readonly requestedStyle: ReplyStyle | undefined;
  readonly loading: boolean;
  readonly loadStatus: "idle" | "loading" | "ready" | "error";
  readonly saveStatus: "idle" | "saving" | "saved" | "error" | "conflict";
  readonly capability: "unknown" | "available" | "unsupported";
  readonly editingAvailable: boolean;
  readonly disabledReason: "identity_required" | "unsupported" | "capability_unknown" | "enforced_override" | "loading" | "not_hydrated" | "offline" | "saving" | undefined;
  readonly loadError: string | undefined;
  readonly saveError: string | undefined;
  readonly reconciliationRequired: boolean;
  readonly pendingInput: UpdateReplyStylePreferenceInput | undefined;
  readonly result: UpdateReplyStylePreferenceResult | undefined;
}
export interface ChatReplyStyle {
  getState(): ChatReplyStyleState;
  /** Snapshot selector; selecting a value to save is an explicit update operation. */
  select(): ChatReplyStyleState;
  subscribe(listener: () => void): () => void;
  load(): Promise<ChatReplyStyleState>;
  update(style: ReplyStyle): Promise<ChatReplyStyleState>;
  /** Reconciles uncertain outcomes first; conflicts retry only on this explicit call. */
  retry(): Promise<ChatReplyStyleState>;
  /** Replaces host policy without persisting it. Omission removes an override/default. */
  configure(configuration: ChatReplyStyleConfiguration): void;
}
interface Options {
  cache: NormalizedChatCache;
  reader: Pick<ChatSnapshotReader, "getReplyStylePreference">;
  dispatch: ChatCommandDispatcher["dispatch"];
  enabledFeatures: () => Readonly<Record<string, boolean>> | undefined;
  online: () => boolean;
  generateIdempotencyKey: () => string;
  configuration?: ChatReplyStyleConfiguration;
}

/** Actor-private preference state. Never writes to the message/draft/thread/send cache. */
export function createReplyStyleRuntime(options: Options) {
  let configuration = { ...options.configuration };
  let epoch = 0;
  let active = true;
  let eventsActive = true;
  let persistenceUnavailable = false;
  let read: AbortController | undefined;
  let command: AbortController | undefined;
  let readTask: Promise<ChatReplyStyleState> | undefined;
  let saveTask: Promise<ChatReplyStyleState> | undefined;
  const listeners = new Set<() => void>();
  const usedKeys = new Map<string, string>();
  const blank = (): ChatReplyStyleState => ({ effectiveStyle: "current", origin: "fallback", resolutionReason: "supported",
    confirmedPreference: undefined, requestedStyle: undefined, loading: false, loadStatus: "idle", saveStatus: "idle",
    capability: "unknown", editingAvailable: false, disabledReason: "not_hydrated", loadError: undefined,
    saveError: undefined, reconciliationRequired: false, pendingInput: undefined, result: undefined });
  const resolve = (value: ChatReplyStyleState): ChatReplyStyleState => {
    const saved = value.confirmedPreference;
    const source = configuration.enforcedOverride !== undefined ? { origin: "override" as const, value: configuration.enforcedOverride }
      : saved?.state === "saved" ? { origin: "saved" as const, value: saved.style }
      : configuration.hostDefault !== undefined ? { origin: "host_default" as const, value: configuration.hostDefault }
      : { origin: "fallback" as const, value: "current" };
    const features = options.enabledFeatures();
    const capability = persistenceUnavailable ? "unsupported" : features === undefined ? "unknown" : supportsReplyStylePreference(features) ? "available" : "unsupported";
    const disabledReason = !active || options.cache.getState().identity === null ? "identity_required"
      : source.origin === "override" ? "enforced_override" : capability === "unknown" ? "capability_unknown"
      : capability === "unsupported" ? "unsupported" : value.loading ? "loading"
      : saved === undefined || value.loadStatus !== "ready" ? "not_hydrated"
      : !options.online() ? "offline" : value.saveStatus === "saving" ? "saving" : undefined;
    return Object.freeze({ ...value, capability, disabledReason, editingAvailable: disabledReason === undefined,
      origin: source.origin, effectiveStyle: isReplyStyle(source.value) ? source.value : "current",
      resolutionReason: isReplyStyle(source.value) ? "supported" : "unsupported_value" });
  };
  let state = resolve(blank());
  const publish = (next: ChatReplyStyleState) => {
    const resolved = resolve(next);
    if (JSON.stringify(resolved) === JSON.stringify(state)) return state;
    state = resolved;
    for (const listener of listeners) { try { listener(); } catch { /* Observers cannot alter admission. */ } }
    return state;
  };
  const guard = (controller: AbortController) => {
    const session = epoch, identity = options.cache.getState().identity;
    return () => {
      const current = options.cache.getState().identity;
      return active && !controller.signal.aborted && session === epoch && identity !== null &&
        identity.tenantId === current?.tenantId && identity.userId === current?.userId && identity.sessionId === current?.sessionId;
    };
  };
  const accept = (preference: ReplyStylePreferenceState): ReplyStylePreferenceState =>
    state.confirmedPreference === undefined || preference.revision > state.confirmedPreference.revision
      ? Object.freeze(preference) : state.confirmedPreference;
  const load = (): Promise<ChatReplyStyleState> => {
    if (readTask !== undefined) return readTask;
    if (!active || options.cache.getState().identity === null || !options.online() ||
        !supportsReplyStylePreference(options.enabledFeatures()) || persistenceUnavailable) {
      return Promise.resolve(publish({ ...state, loading: false, loadStatus: "error",
        loadError: options.cache.getState().identity === null ? "identity_required" : !options.online() ? "offline" : "unsupported" }));
    }
    const controller = new AbortController(); read = controller;
    const current = guard(controller);
    const task = Promise.resolve().then(async () => {
      if (!current()) return state;
      publish({ ...state, loading: true, loadStatus: "loading", loadError: undefined });
      if (!current()) return state;
      const response = await options.reader.getReplyStylePreference({}, { signal: controller.signal });
      if (!current()) return state;
      if (response.status !== "success") {
        if ("httpStatus" in response && [404, 405, 501].includes(response.httpStatus ?? 0)) persistenceUnavailable = true;
        return publish({ ...state, loading: false, loadStatus: "error", loadError: persistenceUnavailable ? "unsupported" : response.status });
      }
      const confirmedPreference = accept(parseReplyStylePreferenceState(response.value));
      return publish({ ...state, confirmedPreference, loading: false, loadStatus: "ready", loadError: undefined });
    }).catch(() => current() ? publish({ ...state, loading: false, loadStatus: "error", loadError: "malformed_response" }) : state)
      .finally(() => { if (readTask === task) { readTask = undefined; read = undefined; } });
    readTask = task; return task;
  };
  const settle = (result: UpdateReplyStylePreferenceResult) => {
    const confirmedPreference = accept(result.preference);
    const superseded = confirmedPreference.revision > result.preference.revision ||
      (confirmedPreference.revision === result.preference.revision && JSON.stringify(confirmedPreference) !== JSON.stringify(result.preference));
    const conflict = result.reconciliationStatus === "preference_revision_conflict" || superseded;
    Object.freeze(result.preference);
    return publish({ ...state, confirmedPreference, result: Object.freeze(result),
      pendingInput: undefined, reconciliationRequired: false, saveStatus: conflict ? "conflict" : "saved",
      saveError: conflict ? superseded ? "superseded" : "preference_revision_conflict" : undefined,
      requestedStyle: conflict ? state.requestedStyle : undefined });
  };
  const execute = (choice: ReplyStyle): Promise<ChatReplyStyleState> => {
    if (saveTask !== undefined) return saveTask;
    const controller = new AbortController(); command = controller;
    const current = guard(controller);
    const task = Promise.resolve().then(async () => {
      if (!current()) return state;
      if (state.reconciliationRequired) {
        await load();
        if (!current() || state.loadStatus !== "ready") return state;
      }
      publish(state);
      if (!current()) return state;
      if (!state.editingAvailable) return publish({ ...state, saveStatus: "error", saveError: state.disabledReason });
      let input = state.pendingInput;
      if (input !== undefined && input.style !== choice) {
        // Resolve the exact uncertain mutation before accepting a different request.
        return publish({ ...state, saveStatus: "error", saveError: "retry_required" });
      }
      try {
        input ??= Object.freeze(parseUpdateReplyStylePreferenceInput({ operation: "update_reply_style_preference", style: choice,
          baseRevision: state.confirmedPreference!.revision, idempotencyKey: options.generateIdempotencyKey() }));
        const identity = options.cache.getState().identity!;
        const key = JSON.stringify([identity.tenantId, identity.userId, input.idempotencyKey]);
        const signature = JSON.stringify([input.style, input.baseRevision]);
        if (usedKeys.has(key) && usedKeys.get(key) !== signature) throw new Error("key reuse");
        usedKeys.set(key, signature);
      } catch { return current() ? publish({ ...state, requestedStyle: choice, saveStatus: "error", saveError: "validation" }) : state; }
      if (!current()) return state;
      const request = input;
      publish({ ...state, requestedStyle: choice, pendingInput: request, saveStatus: "saving", saveError: undefined, result: undefined });
      if (!current()) return state;
      const response = await options.dispatch({ name: "reply.style.update", method: "PATCH", path: "/preferences/reply-style", retry: "never",
        validateInput: parseUpdateReplyStylePreferenceInput,
        parseResult: value => parseUpdateReplyStylePreferenceResult(value, request),
        parseErrorResult(value, status) {
          if (status !== 409 || typeof value !== "object" || value === null ||
              !("reconciliationStatus" in value) || value.reconciliationStatus !== "preference_revision_conflict") return undefined;
          return parseUpdateReplyStylePreferenceResult(value, request);
        },
      }, request, { idempotencyKey: request.idempotencyKey, signal: controller.signal });
      if (!current()) return state;
      if (response.status !== "success") {
        if (response.status === "unsupported" || response.status === "feature_disabled") persistenceUnavailable = true;
        const uncertain = ["transport", "malformed_response", "aborted", "closed"].includes(response.status);
        return publish({ ...state, saveStatus: "error", saveError: response.status, reconciliationRequired: uncertain,
          pendingInput: uncertain ? request : undefined });
      }
      return settle(parseUpdateReplyStylePreferenceResult(response.value, request));
    }).catch(() => current() ? publish({ ...state, saveStatus: "error", saveError: "transport", reconciliationRequired: true }) : state)
      .finally(() => { if (saveTask === task) { saveTask = undefined; command = undefined; } });
    saveTask = task; return task;
  };
  const cancel = () => {
    epoch++; read?.abort(); command?.abort(); read = undefined; command = undefined; readTask = undefined; saveTask = undefined;
  };
  const reset = () => { cancel(); eventsActive = false; persistenceUnavailable = false; publish(blank()); };
  // Includes explicit cache reset and switch-away-and-back, even for identical restored identity values.
  options.cache.subscribePrivateStateBoundary(() => {
    reset();
    if (active && options.online()) void load();
  });
  options.cache.subscribe(s => s.identity, (identity, previous) => {
    if (identity?.tenantId !== previous?.tenantId || identity?.userId !== previous?.userId || identity?.sessionId !== previous?.sessionId) reset();
  });
  const api: ChatReplyStyle = Object.freeze({
    getState: () => state, select: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    update(style: ReplyStyle) {
      if (!isReplyStyle(style)) return Promise.resolve(publish({ ...state, saveStatus: "error", saveError: "validation" }));
      if (saveTask !== undefined) return saveTask;
      if (state.pendingInput !== undefined && state.pendingInput.style !== style) {
        return Promise.resolve(publish({ ...state, saveStatus: "error", saveError: "retry_required" }));
      }
      const available = resolve(state);
      if (!available.editingAvailable) return Promise.resolve(publish({ ...state, saveStatus: "error", saveError: available.disabledReason,
        requestedStyle: !options.online() && state.confirmedPreference !== undefined && configuration.enforcedOverride === undefined ? style : state.requestedStyle }));
      return execute(style);
    },
    retry: () => state.requestedStyle === undefined ? load() : execute(state.requestedStyle),
    configure(value: ChatReplyStyleConfiguration) { configuration = { ...value }; publish(state); },
  });
  return { api,
    closeActive() { active = false; reset(); },
    connectionChanged(connected: boolean) {
      const wasSaving = state.saveStatus === "saving";
      cancel(); eventsActive = connected;
      if (connected) { active = true; persistenceUnavailable = false; }
      publish({ ...state, loading: false, loadStatus: "idle",
        ...(wasSaving ? { saveStatus: "error" as const, saveError: "offline", reconciliationRequired: true } : {}) });
      if (connected) void load();
    },
    handleCanonicalEvent(value: unknown) {
      const identity = options.cache.getState().identity;
      if (!active || !eventsActive || !options.online() || identity === null || !supportsReplyStylePreference(options.enabledFeatures())) return;
      try {
        const event = parseKnownDurableEvent(value, identity);
        if (event.protocolVersion !== CHAT_PROTOCOL_VERSION || event.type !== "reply.style.updated" ||
            event.payload.preference.revision <= (state.confirmedPreference?.revision ?? -1)) return;
        const request = state.pendingInput, mutation = event.payload.mutation;
        if (request !== undefined && mutation !== undefined && request.operation === mutation.operation &&
            request.style === mutation.style && request.baseRevision === mutation.baseRevision && request.idempotencyKey === mutation.idempotencyKey) {
          const result = parseUpdateReplyStylePreferenceResult({ operation: mutation.operation, baseRevision: mutation.baseRevision,
            idempotencyKey: mutation.idempotencyKey, requestedStyle: mutation.style, reconciliationStatus: "applied", preference: event.payload.preference }, request);
          command?.abort(); command = undefined; saveTask = undefined;
          settle(result);
        } else {
          const confirmedPreference = accept(event.payload.preference);
          publish({ ...state, confirmedPreference, loadStatus: state.loading ? "loading" : "ready", loadError: undefined });
        }
      } catch { /* Foreign, stale and noncanonical events cannot mutate private state. */ }
    },
  };
}
