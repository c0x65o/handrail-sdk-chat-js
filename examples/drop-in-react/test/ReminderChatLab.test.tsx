import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReminderChatLab } from "../src/ReminderChatLab";

afterEach(cleanup);

const state = (name: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-fixture-state="${name}"]`);
  if (element === null) throw new Error(`Missing ${name} fixture`);
  return element;
};

const openMessageActions = (message: ReturnType<typeof within>): void => {
  fireEvent.click(message.getByRole("button", { name: "More message actions" }));
};

describe("default React reminder acceptance fixture", () => {
  it("identifies the React renderer and omits Remind me from every ineligible state", () => {
    render(<ReminderChatLab />);

    expect(screen.getByRole("heading", { name: "Default React message renderer" })).toBeTruthy();
    const sent = within(state("sent"));
    openMessageActions(sent);
    expect(sent.getByRole("button", { name: "Remind me" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove from saved" })).toBeNull();
    for (const ineligible of ["deleted", "unsent", "sending", "failed"]) {
      expect(within(state(ineligible)).queryByRole("button", { name: "Remind me" })).toBeNull();
    }
  });

  it("exposes validation, pending, error/retry, cancel, and canonical conflict flows", async () => {
    render(<ReminderChatLab />);
    const sent = within(state("sent"));
    openMessageActions(sent);
    fireEvent.click(sent.getByRole("button", { name: "Remind me" }));

    fireEvent.click(sent.getByRole("button", { name: "Set reminder" }));
    expect((await sent.findByRole("alert")).textContent).toMatch(/valid local date and time/i);

    fireEvent.click(screen.getByRole("button", { name: "Pending" }));
    fireEvent.click(sent.getByRole("button", { name: "In 20 minutes" }));
    expect((await sent.findByRole("status")).textContent).toMatch(/updating reminder/i);
    fireEvent.click(screen.getByRole("button", { name: "Resolve pending as success" }));
    expect((await sent.findByRole("status")).textContent).toMatch(/scheduled/i);

    fireEvent.click(screen.getByRole("button", { name: "Error" }));
    fireEvent.click(sent.getByRole("button", { name: "In 1 hour" }));
    expect((await sent.findByRole("status")).textContent).toMatch(/retry is available/i);
    fireEvent.click(sent.getByRole("button", { name: "Retry reminder" }));
    expect((await sent.findByRole("status")).textContent).toMatch(/updated/i);

    fireEvent.click(screen.getByRole("button", { name: "Success" }));
    fireEvent.click(sent.getByRole("button", { name: "Cancel reminder" }));
    expect((await sent.findByRole("status")).textContent).toMatch(/cancelled/i);

    fireEvent.click(screen.getByRole("button", { name: "Inject canonical conflict" }));
    expect((await sent.findByRole("status")).textContent).toMatch(/changed elsewhere/i);
  });
});
