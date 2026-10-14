import { expect } from "vitest";
import { SUBCOMMANDS } from "../src/command.ts";

/** A youiyoux command an agent would have to find on its PATH: not run through npx. */
const BARE = new RegExp(`(?<!npx (?:-y |--no-install ))\\byouiyoux (?:${SUBCOMMANDS.join("|")})\\b`);

export function expectOnlyNpx(text: string): void {
  expect(text).not.toMatch(BARE);
}
