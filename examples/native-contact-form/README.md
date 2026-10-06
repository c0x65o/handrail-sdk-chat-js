# Server-side contact form

Mount this handler at a fixed HTTP path in your existing server. Keep the token in
its server secret store. The browser sends only `{submissionId,name,email,message}`;
it cannot select a token, destination, role or sender. Choose a stable submission
ID per form submission and retain the identical body for retries.

```js
import { createContactFormHandler } from './handler.mjs';

const contactForm = createContactFormHandler({
  chatApiUrl: process.env.CHAT_API_URL, // HTTPS origin + chat API mount
  token: process.env.CHAT_NATIVE_TOKEN,
  channelId: process.env.CHAT_CHANNEL_ID,
  authorizeRequest: host.authorizeContactSubmission,
});
// In your existing HTTP router, after its normal bounded request/time limits:
// POST /contact -> contactForm(request, response)
```

`authorizeRequest` is required: use your host's existing submission authentication,
CSRF and abuse/rate controls. An authorization callback that always returns true
is appropriate only inside an isolated synthetic test. Configure the handler once
at startup; never copy a native credential into client bundles, logs, form fields,
URLs or retained request traces. No redirects are followed. A timeout/503 can mean
the message was stored: retry only with the same submission ID and body. A 409
means that ID was already used with different content. Rotation preserves this
retry history; update the sender's server secret after rotating in token settings.
This example does not automatically retry or enable any external integration.
