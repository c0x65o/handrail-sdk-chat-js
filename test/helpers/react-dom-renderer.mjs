import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { act } from "./react-act.mjs";

// React 18's test renderer does not replay StrictMode effects. Exercise these
// lifecycle regressions with the actual DOM renderer on both React generations.
export function createDomRenderer(element, t) {
  const window = new Window({ url: "https://chat.test" });
  const prior = new Map();
  for (const [key, value] of Object.entries({ window, document: window.document,
    navigator: window.navigator, HTMLElement: window.HTMLElement })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; root.unmount(); } };
  t.after(async () => {
    try { await act(async () => unmount()); }
    finally {
      await window.happyDOM.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
  root.render(element);
  return { unmount };
}
