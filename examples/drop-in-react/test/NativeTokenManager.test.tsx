import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeTokenManager } from '@handrail/chat/ui';
const getHeaders = async () => ({ authorization: 'Bearer synthetic-host-session' });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('creates a named scoped token, clears its one-time disclosure, and revokes it', async () => {
  const token = { id: 'token-1', name: 'Contact form', channelIds: ['channel-1'], createdAt: '2026-09-16T00:00:00Z', revokedAt: null };
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ token, secret: 'synthetic-one-time-value' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ revoked: true })));
  vi.stubGlobal('fetch', fetcher);
  render(<NativeTokenManager sessionScope="tenant-a:actor-a:login-1" endpoint='/api/chat' getHeaders={getHeaders} />);
  await screen.findByText('Create token');
  fireEvent.change(screen.getByLabelText('Token name'), { target: { value: token.name } });
  fireEvent.change(screen.getByLabelText('Allowed channel IDs (comma separated)'), { target: { value: 'channel-1' } });
  fireEvent.click(screen.getByText('Create token'));
  await screen.findByText('I saved the secret');
  await waitFor(() => expect((screen.getByLabelText('New token secret') as HTMLInputElement).value === 'synthetic-one-time-value').toBe(true));
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ name: token.name, channelIds: ['channel-1'] });
  expect(localStorage.length).toBe(0);
  fireEvent.click(screen.getByText('I saved the secret'));
  expect((screen.getByLabelText('New token secret') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByText('Revoke Contact form'));
  await waitFor(() => expect(screen.queryByText('Revoke Contact form')).toBeNull());
  expect(fetcher.mock.calls[2]![1].method).toBe('DELETE');
});
it('shows denial and offers no management form to an ordinary session', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
  render(<NativeTokenManager sessionScope="tenant-a:actor-a:login-1" endpoint='/api/chat' getHeaders={getHeaders} />);
  expect((await screen.findByRole('alert')).textContent).toContain('host-authorized');
  expect(screen.queryByText('Create token')).toBeNull();
});
it('does not reveal a late creation result after changing host identity', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"tokens":[]}'))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(new Response('{}', { status: 403 })));
  const view = render(<NativeTokenManager sessionScope="tenant-a:actor-a:login-1" endpoint='/api/chat' getHeaders={getHeaders} />);
  await screen.findByText('Create token');
  fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'late' } });
  fireEvent.change(screen.getByLabelText('Allowed channel IDs (comma separated)'), { target: { value: 'channel-1' } });
  fireEvent.click(screen.getByText('Create token'));
  await waitFor(() => expect(finish).toBeDefined());
  view.rerender(<NativeTokenManager sessionScope="tenant-a:actor-a:login-1" endpoint='/api/chat' getHeaders={async () => ({})} />);
  finish(new Response('{"secret":"synthetic-late-value","token":{}}'));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('New token secret') as HTMLInputElement).value).toBe('');
});

// These getters keep the same function identity across tenant/user/login transitions.
// A host must update sessionScope in the same commit as its authenticated session.
const metadata = { id: 'old-token', name: 'Old token', channelIds: ['channel-1'], revokedAt: null };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function createToken() {
  await screen.findByText('Create token');
  fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Synthetic' } });
  fireEvent.change(screen.getByLabelText('Allowed channel IDs (comma separated)'), { target: { value: 'channel-1' } });
  fireEvent.click(screen.getByText('Create token'));
}

for (const strict of [false, true]) {
  const ui = (scope: string | null, headers: () => Promise<Record<string, string>> = getHeaders) => {
    const manager = <NativeTokenManager sessionScope={scope} endpoint='/api/chat' getHeaders={headers} />;
    return strict ? <StrictMode>{manager}</StrictMode> : manager;
  };
  for (const next of ['tenant-a:actor-b:login-2', 'tenant-b:actor-a:login-1', null]) {
    it(`clears an already disclosed secret immediately on ${next ?? 'logout'} (StrictMode=${strict})`, async () => {
      vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(JSON.stringify(options.method === 'POST'
        ? { token: metadata, secret: 'synthetic-disclosure' } : { tokens: [] }))));
      const view = render(ui('tenant-a:actor-a:login-1'));
      await createToken();
      const oldInput = screen.getByLabelText('New token secret') as HTMLInputElement;
      await waitFor(() => expect(Boolean(oldInput.value)).toBe(true));
      view.rerender(ui(next));
      expect(oldInput.value).toBe(''); // also scrub detached DOM, not just the visible tree
      expect((screen.queryByLabelText('New token secret') as HTMLInputElement | null)?.value ?? '').toBe('');
      expect(screen.queryByText('Old token')).toBeNull();
      if (next) await screen.findByText('Create token');
      else expect(screen.queryByText('Create token')).toBeNull();
    });
  }
  for (const operation of ['POST', 'DELETE', 'GET']) {
    for (const fails of [false, true]) {
      it(`isolates delayed ${operation} ${fails ? 'errors/finalizers' : 'results'} with stable headers (StrictMode=${strict})`, async () => {
        const pending = deferred<Response>();
        const newWrite = deferred<Response>();
        let session = 'old';
        let hold = operation === 'GET';
        let held = 0;
        const headers = async () => ({ authorization: session });
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
          if (options.headers.authorization === 'old' && options.method === operation && hold) {
            held++; return pending.promise; // deliberately ignore abort to prove generation guards
          }
          if (options.headers.authorization === 'new' && options.method === 'POST') return newWrite.promise;
          return new Response(JSON.stringify({ tokens: [metadata] }));
        }));
        const view = render(ui('old', headers));
        if (operation !== 'GET') {
          await screen.findByText('Create token');
          hold = true;
          if (operation === 'POST') await createToken();
          else fireEvent.click(screen.getByText('Revoke Old token'));
        }
        await waitFor(() => expect(held).toBeGreaterThan(0));
        session = 'new';
        view.rerender(ui('new', headers));
        await createToken(); // new session has its own pending operation
        await act(async () => {
          if (fails) pending.reject(new Error('Old session failure'));
          else pending.resolve(new Response(JSON.stringify({ tokens: [{ ...metadata, name: 'Stale listing' }], token: metadata, secret: 'synthetic-late' })));
        });
        expect((screen.getByLabelText('New token secret') as HTMLInputElement).value).toBe('');
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByText('Stale listing')).toBeNull();
        expect((screen.getByText('Create token') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText('Revoke Old token')).toBeDefined();
        await act(async () => newWrite.resolve(new Response(JSON.stringify({ token: { ...metadata, id: 'new-token' }, secret: 'synthetic-new' }))));
        await waitFor(() => expect(Boolean((screen.getByLabelText('New token secret') as HTMLInputElement).value)).toBe(true));
      });
    }
  }
  for (const method of ['GET', 'POST', 'DELETE']) {
    it(`does not dispatch ${method} after delayed headers cross logout (StrictMode=${strict})`, async () => {
      const pending = deferred<Record<string, string>>();
      let hold = method === 'GET';
      const headers = vi.fn(() => hold ? pending.promise : Promise.resolve({ authorization: 'old' }));
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ tokens: [metadata] })));
      vi.stubGlobal('fetch', fetcher);
      const view = render(ui('old', headers));
      if (method !== 'GET') {
        await screen.findByText('Create token');
        hold = true;
        if (method === 'POST') await createToken();
        else fireEvent.click(screen.getByText('Revoke Old token'));
      }
      const before = fetcher.mock.calls.length;
      view.rerender(ui(null, headers));
      await act(async () => pending.resolve({ authorization: 'new-session' }));
      expect(fetcher.mock.calls.length).toBe(before);
      expect(screen.queryByText('Create token')).toBeNull();
    });
  }
}
it('StrictMode cancels the first delayed header lookup before fetching and authorizes the live generation', async () => {
  const fetcher = vi.fn(async () => new Response('{"tokens":[]}'));
  vi.stubGlobal('fetch', fetcher);
  render(<StrictMode><NativeTokenManager sessionScope='session' endpoint='/api/chat' getHeaders={getHeaders} /></StrictMode>);
  await screen.findByText('Create token');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
