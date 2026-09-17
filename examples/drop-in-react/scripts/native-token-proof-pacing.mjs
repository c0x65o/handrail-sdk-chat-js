// One conservative budget for all native browser and external HTTP requests.
// Response completion timestamps overestimate the server admission times, so a
// slow request cannot cause an early slot reuse. Never reset server counters.
export function createNativeTokenProofPacer({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const completions = [];
  let tail = Promise.resolve();
  let blockedUntil = 0;
  const windowMs = 60_250; // server window plus a small clock/transport margin
  const request = send => {
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        while (true) {
          while (completions.length && completions[0] + windowMs <= now()) completions.shift();
          const until = Math.max(blockedUntil, completions.length >= 10 ? completions[0] + windowMs : 0);
          if (until <= now()) break;
          await sleep(until - now());
        }
        let result;
        try { result = await send(); }
        catch { throw new Error('Native proof transport failed; operation outcome unknown. Inspect metadata before resuming; no automatic write replay.'); }
        finally { completions.push(now()); }
        if (result.status !== 429) return result.value;
        // This SDK rejects 429 in its authentication limiter BEFORE dispatching
        // management/inbound writes. Only this explicit rejection is replayable.
        // Do not retry timeouts, disconnects, 5xx or other uncertain write outcomes.
        const seconds = Number(result.retryAfter);
        const dateDelay = Date.parse(result.retryAfter) - now();
        const retryMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : (Number.isFinite(dateDelay) ? dateDelay : 60_000);
        blockedUntil = now() + Math.max(60_000, retryMs) + 250;
      }
      throw new Error('Native proof remains rate limited after explicit 429 responses; no acceptance result.');
    };
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };
  return { request };
}

export async function paceNativeTokenBrowserRequests(context, pacer) {
  await context.route('**/api/chat/native-**', async route => {
    try {
      const response = await pacer.request(async () => {
        const value = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
        return { status: value.status(), retryAfter: value.headers()['retry-after'], value };
      });
      await route.fulfill({ response });
    } catch {
      // Do not emit request headers or response bodies (creation discloses a secret).
      await route.abort('failed');
    }
  });
}

export function pacedNativeTokenFetch(pacer, url, options) {
  return pacer.request(async () => {
    const value = await fetch(url, { ...options, redirect: 'error' });
    const result = { status: value.status, retryAfter: value.headers.get('retry-after'), value };
    if (value.status === 429) await value.body?.cancel();
    return result;
  });
}
