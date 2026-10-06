import { createHash } from 'node:crypto';

/** Mount behind the host's existing CSRF, abuse/rate and submission authorization
 * policy. The credential and fixed channel are server configuration only.
 * No request/response bodies or credentials are logged, including on failure. */
export function createContactFormHandler({ chatApiUrl, token, channelId, authorizeRequest, fetchImpl = fetch }) {
  const url = new URL(chatApiUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || !/^hrnt_[A-Za-z0-9_-]{43}$/.test(token) ||
      typeof channelId !== 'string' || !channelId.trim() || channelId.length > 200 || typeof authorizeRequest !== 'function') {
    throw new Error('Valid server configuration and host submission authorization are required.');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/native-inbound/messages`;
  return async (request, response) => {
    const reply = (status, code) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: code }));
    };
    try {
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); return reply(405, 'method_not_allowed'); }
      if (!await authorizeRequest(request)) return reply(403, 'submission_denied');
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) return reply(400, 'invalid_submission');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 8000) return reply(413, 'submission_too_large');
        chunks.push(Buffer.from(chunk));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, 'invalid_submission'); }
      const bounds = { submissionId: 120, name: 120, email: 254, message: 4000 };
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !Object.hasOwn(bounds, key)) ||
          Object.entries(bounds).some(([key, max]) => typeof body[key] !== 'string' || !body[key].trim() || body[key].length > max)) {
        return reply(400, 'invalid_submission');
      }
      // Reuse the same submissionId and exact body for a logical submission retry.
      // The SDK rejects a changed body under that ID instead of duplicating it.
      const upstream = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channelId, text: `Contact form\nName: ${body.name}\nEmail: ${body.email}\n${body.message}`,
          idempotencyKey: `contact:${createHash('sha256').update(body.submissionId).digest('hex')}` }),
      });
      // Never reflect an upstream response (or secret) into the public form.
      await upstream.body?.cancel();
      if (upstream.ok) return reply(202, 'accepted');
      if (upstream.status === 409) return reply(409, 'submission_conflict');
      return reply(503, 'delivery_unavailable');
    } catch {
      // An uncertain delivery is retried with the SAME submissionId and body.
      return reply(503, 'delivery_unconfirmed');
    }
  };
}
