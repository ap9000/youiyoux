// @vitest-environment jsdom
/**
 * The hub's own modal dialogs say they are modal, and the rail buttons that open them say they open
 * a dialog, so `youiyoux behave` finds and checks them (slice 5 dogfood: Radix leaves aria-modal off,
 * and the probe needs aria-haspopup="dialog" on a dialog's button).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { NavRail } from "../src/shell/NavRail.tsx";
import { Modal } from "../src/ui/Modal.tsx";

afterEach(cleanup);

test("Modal's dialog is aria-modal", () => {
  render(<Modal title="Remove it" onClose={() => {}} footer={<button type="button">Remove</button>} />);
  expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
});

test("the rail's dialog buttons say they open a dialog; the theme switch doesn't", () => {
  render(<NavRail />);
  for (const name of ["Connect your agent", "Search", "Keyboard shortcuts"]) expect(screen.getByRole("button", { name }).getAttribute("aria-haspopup"), name).toBe("dialog");
  expect(screen.getByRole("button", { name: /^Theme/ }).hasAttribute("aria-haspopup")).toBe(false);
});
