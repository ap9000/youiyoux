import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPglite } from "../src/index.ts";
import { storeContract } from "./store.contract.ts";

let dir: string;
storeContract({
  name: "postgres (PGlite)",
  open: async () => { dir = await mkdtemp(join(tmpdir(), "youi-pglite-")); return openPglite(dir); },
  reopen: () => openPglite(dir),
  readOnly: () => openPglite(dir, { readOnly: true }),
  cleanup: () => rm(dir, { recursive: true, force: true }),
});
