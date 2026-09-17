import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatLabWebRtcAdapter } from "../src/chat-lab-webrtc";

// Only capture/signaling boundaries are synthetic. Exercise the actual browser
// adapter and the view callback used by the Flutter bridge on provider loss.
class SignalingSocket {
  static OPEN = 1;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send() {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
      type: "welcome", peerId: "self", iceServers: [], peers: [],
    }) }));
  }
  close() { this.readyState = 3; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("real-media adapter provider-loss cleanup", () => {
  it("stops capture without feeding disconnected view callbacks back into cleanup", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("WebSocket", SignalingSocket);
    const track = { readyState: "live", onended: null, stop: vi.fn(() => { track.readyState = "ended"; }) };
    vi.stubGlobal("navigator", { mediaDevices: {
      getDisplayMedia: async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }),
    } });
    const adapter = new ChatLabWebRtcAdapter();
    const connection = await adapter.connect({ kind: "opaque_media_join", descriptor: JSON.stringify({ version: 1, token: "test-only" }), expiresAt: "2030-01-01T00:00:00.000Z" });
    await connection.startScreenShare();
    let disconnectedCallbacks = 0;
    adapter.subscribeView(() => {
      if (!adapter.getView().connected) {
        disconnectedCallbacks++;
        // Bound the regression: the old adapter loops indefinitely in the real
        // host. Keep the failing test finite without hiding duplicate events.
        if (disconnectedCallbacks < 10) void connection.stopScreenShare();
      }
    });
    await connection.disconnect();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(disconnectedCallbacks).toBe(1);
    expect(track.readyState).toBe("ended");
    expect(adapter.getView()).toEqual({ connected: false, peers: [] });
    await connection.stopScreenShare();
    expect(disconnectedCallbacks).toBe(1);
  });
});
