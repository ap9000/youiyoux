/** The public command name; the old bin is only a compatibility alias. */
export const COMMAND = "youiyoux";
/** Its subcommands, as agent-facing text names them (main.ts's COMMAND_NAMES; a test keeps them in step). */
export const SUBCOMMANDS = ["show", "where", "bom", "check", "baseline", "rules", "plan", "migrate", "init", "sync", "scan", "watch", "hooks", "agents", "mcp", "ui", "library", "discover", "index", "report", "render", "screens", "detect", "build", "parity", "schema", "inventory", "help"] as const;
