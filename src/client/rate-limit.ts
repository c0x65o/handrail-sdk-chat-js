import type { ChatClientFetchResponse } from "./command-dispatcher.js";

export const retryAfterDeadline = (
  response: ChatClientFetchResponse,
  now: number,
): number | undefined => {
  let header: string | null | undefined;
  try { header = response.headers?.get("retry-after"); } catch { /* Optional fetch adapter edge. */ }
  const value = header?.trim();
  const deadline = value && /^\d+(?:\.\d+)?$/.test(value)
    ? now + Number(value) * 1_000
    : value && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(deadline) && deadline <= 8_640_000_000_000_000 ? deadline : undefined;
};

// Preserve the existing read-state policy, including its expired-header fallback.
export const rateLimitDeadline = (response: ChatClientFetchResponse): number => {
  const now = Date.now();
  const deadline = retryAfterDeadline(response, now);
  return deadline !== undefined && deadline > now ? deadline : now + 60_000;
};
