#!/usr/bin/env node
// The packaged hub's server (apps/web/scripts/hub-server.ts), which `youiyoux ui` starts.
import "./node20.js";
import { main } from "../../../apps/web/scripts/hub-server.ts";

await main();
