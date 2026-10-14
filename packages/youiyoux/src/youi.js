#!/usr/bin/env node
// youi: the full YouIyouX CLI, as `youi` runs from a checkout.
import "./node20.js";
import { main } from "@youiyoux/cli";

const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
