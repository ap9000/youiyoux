/** Tests never touch the person's own local index (~/.cache/youiyoux/index.db): each worker gets a temporary one. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.YOUI_INDEX) process.env.YOUI_INDEX = join(mkdtempSync(join(tmpdir(), "youi-test-index-")), "index.db");
delete process.env.DATABASE_URL;
