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
