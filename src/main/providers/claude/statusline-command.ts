import path from 'node:path'
import os from 'node:os'

/**
 * Build the `statusLine` settings value that runs CCC's bundled statusline
 * bridge script (`<resourcesDir>/scripts/claude-multi-statusline.js`).
 *
 * Shared by the per-session settings writer so the command is delivered via
 * each session's `--settings settings-<sid>.json` file rather than a global
 * `~/.claude/settings.json` write.
 *
 * Local unification (harmonise-remote): when `sessionId` is given, it rides
 * argv[2] and the /status delivery target rides argv[3] — the SAME argv
 * convention as both remote shims (ssh-shim.ts), so all three bridges resolve
 * identity and delivery identically.
 *
 * ADR-009 token custody: argv[3] is the PATH of the 0600 status-URL file, NOT
 * the URL. The URL carries this session's MCP token — the sole gate on the
 * loopback MCP server and thus on `vision_eval` — and a statusLine command is
 * argv of a process the local machine spawns every second or two, so the
 * pre-hardening form published the token to every other account on this machine
 * through the process table (`ps auxww` on POSIX, `Win32_Process.CommandLine` on
 * Windows). The bridge's resolver (SHIM_STATUS_URL_JS) still accepts a literal
 * `http…` URL here, so a settings file written by an older build keeps
 * delivering until it is rewritten. The path is double-quoted because it can
 * contain spaces. With no sessionId (legacy caller) or no URL file (MCP server
 * not bound) the script falls back to env/stdin identity and file delivery.
 */
export function buildStatuslineSetting(
  resourcesDir: string,
  sessionId?: string,
  statusUrlFile?: string,
): { type: 'command'; command: string } {
  const script = path.join(resourcesDir, 'scripts', 'claude-multi-statusline.js')
  const esc = (p: string): string => (os.platform() === 'win32' ? p.replace(/\\/g, '\\\\') : p)
  let command = `node "${esc(script)}"`
  if (sessionId) {
    // Same sanitisation as every other sid embedding (filenames, remote
    // commands): belt-and-braces for a value that is hex in practice.
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    command += ` ${safeSid}`
    if (statusUrlFile) command += ` "${esc(statusUrlFile)}"`
  }
  return { type: 'command', command }
}
