#!/usr/bin/env node
// The hub's snapshot of a design system (apps/web/scripts/snapshot.ts), which `youiyoux ui` runs before serving it.
import "./node20.js";
import { main } from "../../../apps/web/scripts/snapshot.ts";

await main();
