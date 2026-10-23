/** The public command name; the old bin is only a compatibility alias. */
export const COMMAND = "youiyoux";
/** Its subcommands, as agent-facing text names them (main.ts's COMMAND_NAMES; a test keeps them in step). */
export const SUBCOMMANDS = ["show", "where", "bom", "check", "baseline", "rules", "plan", "migrate", "init", "adopt", "status", "system", "sync", "link", "unlink", "scan", "watch", "hooks", "agents", "mcp", "ui", "library", "discover", "index", "report", "render", "screens", "requests", "detect", "build", "parity", "schema", "inventory", "gaps", "help"] as const;
