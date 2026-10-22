/** Commands the hub tells people to run are real `youiyoux` commands, never the old `youi` name or one the CLI lacks. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { COMMAND, SUBCOMMANDS } from "../../../packages/cli/src/command.ts";
import { SYNC_COMMAND } from "../src/screens/element/ComponentPage.tsx";

const SRC = join(import.meta.dirname, "../src");
const sources = (readdirSync(SRC, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file)).map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));

describe("commands in the hub", () => {
  test("the component page's sync command is a subcommand the CLI has", () => {
    const [bin, sub] = SYNC_COMMAND.split(" ");
    expect(bin).toBe(COMMAND);
    expect(SUBCOMMANDS).toContain(sub);
  });

  test("no source says `youi <command>`, and every `youiyoux <word>` names a real subcommand", () => {
    const old = sources.flatMap(({ file, text }) => [...text.matchAll(/\byoui ([a-z]+)\b/g)].filter((m) => (SUBCOMMANDS as readonly string[]).includes(m[1]!) || m[1] === "add").map((m) => `${file}: ${m[0]}`));
    expect(old).toEqual([]);
    const unknown = sources.flatMap(({ file, text }) => [...text.matchAll(/\byouiyoux ([a-z]+)\b/g)].filter((m) => !(SUBCOMMANDS as readonly string[]).includes(m[1]!)).map((m) => `${file}: ${m[0]}`));
    expect(unknown).toEqual([]);
  });
});
