import { ChatLabWebRtcAdapter } from './chat-lab-webrtc';
import type { ChatHuddleMediaAdapterConnection, HuddleMediaJoinDescriptor } from '@handrail/chat/client';

/** Same-origin browser reference host for the Flutter backend lab. No SDK core
 * dependency on JavaScript, WebRTC, this bridge, or a specific provider. */
export function createFlutterMediaHost(element: HTMLElement, changed: (state: string) => void) {
  const adapter = new ChatLabWebRtcAdapter();
  let connection: ChatHuddleMediaAdapterConnection | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const media = new Map<string, { audio: HTMLAudioElement; video: HTMLVideoElement; label: HTMLElement }>();
  const render = () => {
    const view = adapter.getView();
    for (const [id, nodes] of media) if (!view.peers.some(peer => peer.id === id)) {
      nodes.audio.srcObject = null; nodes.video.srcObject = null;
      nodes.audio.remove(); nodes.video.remove(); nodes.label.remove(); media.delete(id);
    }
    for (const peer of view.peers) {
      let nodes = media.get(peer.id);
      if (!nodes) {
        const audio = document.createElement('audio');
        const video = document.createElement('video');
        const label = document.createElement('span');
        audio.autoplay = true; video.autoplay = true; video.playsInline = true; video.muted = true;
        video.style.cssText = 'height:100px;max-width:180px;object-fit:contain;background:#111';
        label.style.cssText = 'padding:8px;font:14px sans-serif';
        element.append(audio, label, video);
        nodes = { audio, video, label }; media.set(peer.id, nodes);
      }
      nodes.label.textContent = `${peer.userId}: ${peer.connectionState}`;
      nodes.label.dataset.mediaConnection = peer.connectionState;
      nodes.audio.srcObject = peer.audio; nodes.video.srcObject = peer.video;
      nodes.video.hidden = !peer.screenShareActive;
      nodes.video.setAttribute('aria-label', `${peer.userId} shared screen`);
      void nodes.audio.play().catch(() => { nodes!.audio.controls = true; });
      if (view.outputDeviceId && 'setSinkId' in nodes.audio) {
        void nodes.audio.setSinkId(view.outputDeviceId).catch(() => { nodes!.audio.controls = true; });
      }
      if (peer.screenShareActive) void nodes.video.play().catch(() => {});
    }
  };
  const publish = () => {
    const state = connection?.getState();
    if (state && !closed) changed(JSON.stringify(state));
  };
  const stopView = adapter.subscribeView(() => { render(); publish(); });
  // Return only stable error codes across the host boundary. Never serialize a
  // provider exception, join descriptor, SDP, ICE credential or token.
  const command = async (action: () => unknown): Promise<string | null> => {
    try { if (closed || !connection) return 'not_connected'; await action(); return null; }
    catch (error) { return error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
      ? 'permission_denied' : 'provider_failure'; }
  };
  return {
    async connect(descriptor: string, expiresAt: string): Promise<void> {
      const next = await adapter.connect({ descriptor, expiresAt } as HuddleMediaJoinDescriptor);
      if (closed) { await next.disconnect(); throw new Error('Media host closed'); }
      connection = next; unsubscribe = next.subscribe(publish); publish();
    },
    microphone: (enabled: boolean) => command(() => connection!.setMicrophoneMuted(!enabled)),
    prepareScreen: () => command(() => connection!.prepareScreenShare?.()),
    screen: (enabled: boolean) => command(() => enabled ? connection!.startScreenShare() : connection!.stopScreenShare()),
    input: (id: string | null) => command(() => connection!.selectDevice('audio_input', id)),
    output: (id: string | null) => command(() => connection!.selectDevice('audio_output', id)),
    async close(): Promise<void> {
      if (closed) return;
      closed = true; unsubscribe?.(); stopView(); await connection?.disconnect();
      for (const nodes of media.values()) { nodes.audio.srcObject = null; nodes.video.srcObject = null; }
      media.clear(); element.replaceChildren();
    },
  };
}

Object.assign(globalThis, { handrailCreateFlutterMediaHost: createFlutterMediaHost });
