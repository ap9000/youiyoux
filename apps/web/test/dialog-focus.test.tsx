// @vitest-environment jsdom
/**
 * Closing one of the hub's dialogs gives focus back to the button that opened it, however it closes
 * (Esc, the close button, a footer button). They are opened by plain buttons, not Radix's
 * Dialog.Trigger, so Radix had nowhere to send focus and it fell to the page's body: `youiyoux
 * behave` failed focus-return on the rail's three dialogs.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DetectReport } from "@youiyoux/core";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContrastConfirm } from "../src/screens/changes/ContrastConfirm.tsx";
import { StackReport } from "../src/screens/stack/StackScreen.tsx";
import { setOverlay } from "../src/shell/keyboard.ts";
import { NavRail } from "../src/shell/NavRail.tsx";
import { Overlays } from "../src/shell/Overlays.tsx";
import { Modal } from "../src/ui/Modal.tsx";
import fixture from "./fixtures/detect.site.json" with { type: "json" };

const VIEW = { agents: [{ kind: "claude", name: "Claude Code", found: true, connected: true, file: ".mcp.json" }], command: "youiyoux agents install" };

beforeEach(() => {
  // cmdk (the palette) measures its list and scrolls the picked item into view; jsdom has neither.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => {};
  // Connect your agent reads /api/agents; nothing else here needs data.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (String(input).includes("/api/agents") ? new Response(JSON.stringify(VIEW), { headers: { "content-type": "application/json" } }) : new Response("", { status: 404 }))));
});
afterEach(() => {
  act(() => setOverlay(null));
  cleanup();
  vi.unstubAllGlobals();
});

/** Focus a button and click it, as a mouse or Enter from the keyboard does in Chromium. */
function press(button: HTMLElement): void {
  button.focus();
  fireEvent.click(button);
}

const escape = (): void => void fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

async function closedWithFocusOn(button: HTMLElement): Promise<void> {
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));
}

function ModalOpener({ form = false }: { form?: boolean }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Remove it
      </button>
      <output data-testid="sent">{sent}</output>
      {open && (
        <Modal
          title="Remove the token"
          onClose={() => setOpen(false)}
          {...(form ? { onSubmit: (event: { preventDefault: () => void }) => (event.preventDefault(), setSent((n) => n + 1), setOpen(false)) } : {})}
          footer={
            <>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              {form && <button type="submit">Remove</button>}
            </>
          }
        >
          {form && <input aria-label="Name" />}
        </Modal>
      )}
    </>
  );
}

describe("Modal", () => {
  test("Esc gives focus back to the button that opened it", async () => {
    render(<ModalOpener />);
    const opener = screen.getByRole("button", { name: "Remove it" });
    press(opener);
    await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));
    escape();
    await closedWithFocusOn(opener);
  });

  test("the close button and a footer button give it back too", async () => {
    render(<ModalOpener />);
    const opener = screen.getByRole("button", { name: "Remove it" });
    press(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await closedWithFocusOn(opener);
    press(opener);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await closedWithFocusOn(opener);
  });

  test("submitting the form still submits it, and gives focus back", async () => {
    render(<ModalOpener form />);
    const opener = screen.getByRole("button", { name: "Remove it" });
    press(opener);
    fireEvent.submit(screen.getByRole("textbox", { name: "Name" }).closest("form")!);
    await closedWithFocusOn(opener);
    expect(screen.getByTestId("sent").textContent).toBe("1");
  });

  test("focus the app has already moved elsewhere is left there", async () => {
    function MovesFocus() {
      const [open, setOpen] = useState(false);
      const [closed, setClosed] = useState(false);
      // After closing, the app itself focuses a field (say, the one the dialog was about).
      useEffect(() => {
        if (closed) document.querySelector<HTMLInputElement>("[aria-label=Next]")!.focus();
      }, [closed]);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <input aria-label="Next" />
          {open && <Modal title="Moves on" onClose={() => (setOpen(false), setClosed(true))} footer={null} />}
        </>
      );
    }
    render(<MovesFocus />);
    press(screen.getByRole("button", { name: "Open" }));
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Next" }));
  });
});

describe("the rail's dialogs", () => {
  const rail = () => render(<><NavRail /><Overlays /></>);

  test.each(["Connect your agent", "Search", "Keyboard shortcuts"])("%s: Esc gives focus back to its rail button", async (name) => {
    rail();
    const opener = screen.getByRole("button", { name });
    press(opener);
    await screen.findByRole("dialog");
    escape();
    await closedWithFocusOn(opener);
  });

  test.each(["Connect your agent", "Keyboard shortcuts"])("%s: the close button gives focus back to its rail button", async (name) => {
    rail();
    const opener = screen.getByRole("button", { name });
    press(opener);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await closedWithFocusOn(opener);
  });

  test("Connect your agent opened from the palette gives focus back to the Search button", async () => {
    rail();
    const opener = screen.getByRole("button", { name: "Search" });
    press(opener);
    const search = await screen.findByRole("combobox", { name: "Command palette" });
    fireEvent.change(search, { target: { value: "connect" } });
    await screen.findByRole("option", { name: "Connect your agent" });
    fireEvent.keyDown(search, { key: "Enter" });
    await screen.findByRole("dialog", { name: "Connect your agent" });
    escape();
    await closedWithFocusOn(opener);
  });
});

describe("the other dialogs opened by a plain button", () => {
  test("the contrast confirmation: Keep editing and Esc give focus back to Approve", async () => {
    function Approve() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Approve revision 2
          </button>
          {open && <ContrastConfirm failing={[]} revision={2} onConfirm={() => setOpen(false)} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Approve />);
    const opener = screen.getByRole("button", { name: "Approve revision 2" });
    press(opener);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await closedWithFocusOn(opener);
    press(opener);
    escape();
    await closedWithFocusOn(opener);
  });

  test("Stack's Draft Library item: Esc gives focus back to Add to Library", async () => {
    render(<StackReport report={DetectReport.parse(fixture)} />);
    const opener = within(screen.getByRole("article", { name: "shadcn/ui dialog" })).getByRole("button", { name: /Add to Library/ });
    press(opener);
    await screen.findByRole("dialog", { name: "Draft Library item" });
    escape();
    await closedWithFocusOn(opener);
  });
});
