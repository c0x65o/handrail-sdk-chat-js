import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  mounted: [] as string[],
  unmounted: [] as string[],
}));

vi.mock("../src/ChatLabApp", () => ({
  ChatLabApp: ({ instanceId }: { readonly instanceId: string }) => {
    useEffect(() => {
      lifecycle.mounted.push(instanceId);
      return () => { lifecycle.unmounted.push(instanceId); };
    }, [instanceId]);
    return <div data-testid="chat-lab-instance">{instanceId}</div>;
  },
}));

import { ChatLabRuntime } from "../src/ChatLabRuntime";

const instanceResponse = (instanceId: string) => ({
  ok: true,
  json: async () => ({ instanceId }),
});

afterEach(() => {
  cleanup();
  lifecycle.mounted.length = 0;
  lifecycle.unmounted.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ChatLabRuntime", () => {
  it("remounts the app with isolated state when the backend instance changes", async () => {
    vi.useFakeTimers();
    const first = "11111111111111111111111111111111";
    const second = "22222222222222222222222222222222";
    const fetch = vi.fn()
      .mockResolvedValueOnce(instanceResponse(first))
      .mockResolvedValue(instanceResponse(second));
    vi.stubGlobal("fetch", fetch);

    render(<ChatLabRuntime />);
    expect(screen.getByRole("status").textContent).toContain("Connecting to Chat Lab");

    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("chat-lab-instance").textContent).toBe(first);
    expect(lifecycle.mounted).toEqual([first]);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByTestId("chat-lab-instance").textContent).toBe(second);
    expect(lifecycle.unmounted).toContain(first);
    expect(lifecycle.mounted).toEqual([first, second]);
    expect(fetch).toHaveBeenCalledWith("/__chat-lab/instance", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });
});
