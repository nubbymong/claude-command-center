/**
 * Chrome DevTools Protocol port constants for the Vision sub-tool's headless
 * browser.
 *
 * Mirrors src/shared/mcp-ports.ts: production CCC instances bind 9222 (the
 * canonical Chrome debug port). Dev mode (electron-vite, isPackagedApp() ===
 * false) uses 9322 so dev's Chrome can attach independently of a running
 * production install on the same machine. Without this split, dev's
 * VisionManager waits forever for CDP at 9222 because prod's Chrome owns it.
 */

export const CDP_PORT_PROD = 9222
export const CDP_PORT_DEV = 9322

/** Resolve the CDP port for the current build mode. */
export function resolveCdpPort(isPackaged: boolean): number {
  return isPackaged ? CDP_PORT_PROD : CDP_PORT_DEV
}

/**
 * Ports for the #216 account sign-in browser — DISTINCT from Vision's above.
 *
 * They must not collide: Vision's browser is long-lived and may be connected
 * while a sign-in runs, and two Chromes cannot share a debug port. Sharing one
 * would also be worse than a collision — the sign-in browser briefly holds a
 * live claude.ai session, and Vision's port is reachable by every session's MCP
 * tooling. Separate port, separate profile dir, separate lifetime.
 */
export const AUTH_CDP_PORT_PROD = 9422
export const AUTH_CDP_PORT_DEV = 9522

/** Resolve the account sign-in CDP port for the current build mode. */
export function resolveAuthCdpPort(isPackaged: boolean): number {
  return isPackaged ? AUTH_CDP_PORT_PROD : AUTH_CDP_PORT_DEV
}
