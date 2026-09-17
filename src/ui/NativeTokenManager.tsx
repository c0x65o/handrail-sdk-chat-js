import { useLayoutEffect, useRef, useState } from "react";

export interface NativeTokenManagerProps {
  /** Same host session headers as the chat client. Never pass an integration secret. */
  readonly getHeaders: () => Promise<Record<string, string>>;
  readonly endpoint: string;
  /** Non-secret host tenant/user/session identity. Change on every identity transition; null on logout. */
  readonly sessionScope: string | null;
}
interface TokenMetadata {
  id: string;
  name: string;
  channelIds: string[];
  createdAt: string;
  revokedAt: string | null;
}

/** The boundary remounts all sensitive state synchronously with a host scope change. */
export function NativeTokenManager(props: NativeTokenManagerProps) {
  if (!props.sessionScope) return null;
  return <ScopedNativeTokenManager key={JSON.stringify([props.endpoint, props.sessionScope])} {...props} />;
}

/** Secrets live only in the mounted disclosure input, outside chat/cache/storage state. */
function ScopedNativeTokenManager({ endpoint, getHeaders }: NativeTokenManagerProps) {
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [name, setName] = useState("");
  const [channelIds, setChannelIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [disclosed, setDisclosed] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const disclosure = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const clearSecret = () => {
    if (disclosure.current) disclosure.current.value = "";
    setDisclosed(false);
  };
  const request = async (current: number, path = "", method = "GET", body?: unknown) => {
    const signal = controller.current!.signal;
    const headers = await getHeaders();
    // Header getters may resolve after logout or even read a different host session.
    if (generation.current !== current || signal.aborted) throw new Error("Session changed.");
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/native-tokens${path}`, {
      method, signal, headers: { ...headers, "content-type": "application/json" },
      credentials: "same-origin", cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (generation.current !== current || signal.aborted) throw new Error("Session changed.");
    if (!response.ok) throw new Error(response.status === 403 ? "Only host-authorized administrators can manage tokens."
      : response.status === 429 ? "Too many authentication requests. Wait 60 seconds and try again."
      : "Token request failed. Check your session and channel access.");
    return response.json();
  };
  useLayoutEffect(() => {
    const current = ++generation.current;
    controller.current = new AbortController();
    clearSecret();
    setBusy(false);
    setName(""); setChannelIds("");
    setAuthorized(false);
    setTokens([]);
    setError("");
    void request(current).then(result => {
      if (generation.current !== current) return;
      setTokens(result.tokens);
      setAuthorized(true);
    }).catch((cause: Error) => { if (generation.current === current) setError(cause.message); });
    const input = disclosure.current;
    return () => { generation.current++; controller.current?.abort(); if (input) input.value = ""; };
  }, [endpoint, getHeaders]);

  const mutate = async (action: () => Promise<void>) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true); setError("");
    try { await action(); } catch (cause) { if (generation.current === current) setError((cause as Error).message); }
    finally { if (generation.current === current) setBusy(false); }
  };
  return <section aria-label="Inbound channel tokens" className="hr-chat-native-tokens">
    <h3>Inbound channel tokens</h3>
    <p>Allow a server to post to selected channels. Tokens cannot read messages or manage chat.</p>
    {error && <p role="alert">{error}</p>}
    <div hidden={!disclosed} role="status">
      <p>Copy this secret now. It will not be shown again. Store it on the sender’s server.</p>
      <label>New token secret <input ref={disclosure} readOnly autoComplete="off" spellCheck={false} /></label>
      <button type="button" onClick={clearSecret}>I saved the secret</button>
    </div>
    {authorized && <>
      <form onSubmit={event => {
        event.preventDefault();
        const current = generation.current;
        void mutate(async () => {
          clearSecret();
          const result = await request(current, "", "POST", { name, channelIds: channelIds.split(",").map(id => id.trim()).filter(Boolean) });
          if (generation.current !== current) return;
          if (disclosure.current) disclosure.current.value = result.secret;
          setDisclosed(true);
          setTokens(previous => [result.token, ...previous]);
          setName(""); setChannelIds("");
        });
      }}>
        <label>Token name <input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Allowed channel IDs (comma separated) <input required value={channelIds} onChange={event => setChannelIds(event.target.value)} /></label>
        <button disabled={busy || disclosed} type="submit">Create token</button>
      </form>
      <ul>{tokens.map(token => <li key={token.id}>
        <strong>{token.name}</strong> · {token.channelIds.join(", ")} · {token.revokedAt ? "Revoked" : "Active"}
        {!token.revokedAt && <button type="button" disabled={busy} onClick={() => {
          const current = generation.current;
          void mutate(async () => {
            await request(current, `/${encodeURIComponent(token.id)}`, "DELETE");
            if (generation.current !== current) return;
            clearSecret();
            setTokens(previous => previous.map(item => item.id === token.id ? { ...item, revokedAt: new Date().toISOString() } : item));
          });
        }}>Revoke {token.name}</button>}
      </li>)}</ul>
    </>}
  </section>;
}
