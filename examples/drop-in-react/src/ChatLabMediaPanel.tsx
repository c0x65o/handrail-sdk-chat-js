import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChatLabWebRtcAdapter } from "./chat-lab-webrtc";
import { chatLabActors } from "./chat-lab-config";

function MediaOutput({ stream, video, label, outputDeviceId }: {
  stream: MediaStream; video: boolean; label: string; outputDeviceId?: string;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [deviceError, setDeviceError] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let active = true;
    element.srcObject = stream;
    void element.play().then(() => { if (active) setBlocked(false); }, () => { if (active) setBlocked(true); });
    return () => { active = false; element.pause(); element.srcObject = null; };
  }, [stream]);
  useEffect(() => {
    const element = ref.current;
    if (!element || video || !outputDeviceId) return;
    let active = true;
    if (typeof element.setSinkId !== "function") setDeviceError(true);
    else void element.setSinkId(outputDeviceId).then(
      () => { if (active) setDeviceError(false); },
      () => { if (active) setDeviceError(true); },
    );
    return () => { active = false; };
  }, [outputDeviceId, video]);
  return <div className={video ? "chat-lab-media__screen" : "chat-lab-media__audio"}>
    {video
      ? <video ref={ref} aria-label={label} autoPlay playsInline muted />
      : <audio ref={ref} aria-label={label} autoPlay />}
    {blocked && <button type="button" onClick={() => {
      void ref.current?.play().then(() => setBlocked(false), () => setBlocked(true));
    }}>Play {label}</button>}
    {deviceError && <p role="status">This browser could not select that speaker. Using the browser’s current audio output.</p>}
  </div>;
}

export function ChatLabMediaPanel({ adapter }: { adapter: ChatLabWebRtcAdapter }) {
  const view = useSyncExternalStore(adapter.subscribeView, adapter.getView);
  if (!view.connected && !view.error) return null;
  return <section className="chat-lab-media" aria-label="Live huddle media">
    <div role="status">
      {view.connected ? `Huddle media connected · ${view.peers.length} other participant${view.peers.length === 1 ? "" : "s"}` : "Huddle media disconnected"}
    </div>
    {view.error && <p role="alert">{view.error}</p>}
    <div className="chat-lab-media__screens">
      {view.localScreen && <div><span>Your screen</span>
        <MediaOutput stream={view.localScreen} video label="Your shared screen" />
      </div>}
      {view.peers.map((peer) => {
        const label = chatLabActors.find((actor) => actor.id === peer.userId)?.displayName ?? peer.userId;
        return <div key={peer.id} data-media-peer={peer.userId} data-media-connection={peer.connectionState}>
          <span>{label} · {peer.connectionState}</span>
          <MediaOutput stream={peer.audio} video={false} label={`${label} audio`}
            {...(view.outputDeviceId ? { outputDeviceId: view.outputDeviceId } : {})} />
          {peer.screenShareActive && <MediaOutput stream={peer.video} video label={`${label} shared screen`} />}
        </div>;
      })}
    </div>
  </section>;
}
