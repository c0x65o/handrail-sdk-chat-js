import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  render(<NativeTokenManager endpoint='/api/chat' getHeaders={getHeaders} />);
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
  render(<NativeTokenManager endpoint='/api/chat' getHeaders={getHeaders} />);
  expect((await screen.findByRole('alert')).textContent).toContain('host-authorized');
  expect(screen.queryByText('Create token')).toBeNull();
});
it('does not reveal a late creation result after changing host identity', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"tokens":[]}'))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(new Response('{}', { status: 403 })));
  const view = render(<NativeTokenManager endpoint='/api/chat' getHeaders={getHeaders} />);
  await screen.findByText('Create token');
  fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'late' } });
  fireEvent.change(screen.getByLabelText('Allowed channel IDs (comma separated)'), { target: { value: 'channel-1' } });
  fireEvent.click(screen.getByText('Create token'));
  await waitFor(() => expect(finish).toBeDefined());
  view.rerender(<NativeTokenManager endpoint='/api/chat' getHeaders={async () => ({})} />);
  finish(new Response('{"secret":"synthetic-late-value","token":{}}'));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('New token secret') as HTMLInputElement).value).toBe('');
});
