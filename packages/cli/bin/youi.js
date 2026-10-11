#!/usr/bin/env node
// YouIyouX CLI. Node ≥ 24 runs the TypeScript sources directly (type stripping), so there is no build step.
import { main } from "../src/main.ts";

const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
