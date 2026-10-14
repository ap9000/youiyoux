#!/usr/bin/env node
// youiyoux: `youiyoux report` unless the first word is another youi command (npx youiyoux agents install).
import "./node20.js";
import { COMMAND_NAMES, main } from "@youiyoux/cli";

const argv = process.argv.slice(2);
const command = argv[0] !== undefined && COMMAND_NAMES.includes(argv[0]) ? argv : ["report", ...argv];
const code = await main(command);
if (code >= 0) process.exitCode = code;
