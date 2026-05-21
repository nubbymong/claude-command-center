/**
 * Conductor MCP server port constants.
 *
 * Production CCC instances bind 19333 (the canonical port that's been used
 * since v1.0; the MCP server is registered in `~/.claude.json` under the
 * `conductor` key, and CCC-spawned sessions get per-session `--mcp-config`
 * overrides written to `~/.claude/mcp-<sid>.json`). Dev mode (electron-vite,
 * isPackagedApp() === false) binds 19433 so a dev session can coexist with
 * a running production install on the same machine without EADDRINUSE.
 *
 * The resolver is the single source of truth -- main process, renderer,
 * SSH shim, and per-session settings all use it.
 */

export const CONDUCTOR_MCP_PORT_PROD = 19333
export const CONDUCTOR_MCP_PORT_DEV = 19433

/** Resolve the port for the current build mode. */
export function resolveConductorMcpPort(isPackaged: boolean): number {
  return isPackaged ? CONDUCTOR_MCP_PORT_PROD : CONDUCTOR_MCP_PORT_DEV
}
