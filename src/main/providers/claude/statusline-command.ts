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
 *
 * The command carries a path only when the shell reads it as nothing but a
 * path (statuslinePathIsPlain); any other path gives NO command (null), and
 * the caller sets up no status line of the app's and says why. Every other
 * path keeps the exact command it always had.
 */
export function buildStatuslineSetting(
  resourcesDir: string,
  sessionId?: string,
  statusUrlFile?: string,
): { type: 'command'; command: string } | null {
  const win32 = os.platform() === 'win32'
  const script = (win32 ? path.win32 : path.posix).join(resourcesDir, 'scripts', 'claude-multi-statusline.js')
  if (!statuslinePathIsPlain(script, win32)) return null
  const esc = (p: string): string => (win32 ? p.replace(/\\/g, '\\\\') : p)
  let command = `node "${esc(script)}"`
  if (sessionId) {
    // Same sanitisation as every other sid embedding (filenames, remote
    // commands): belt-and-braces for a value that is hex in practice.
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    command += ` ${safeSid}`
    if (statusUrlFile) {
      if (!statuslinePathIsPlain(statusUrlFile, win32)) return null
      command += ` "${esc(statusUrlFile)}"`
    }
  }
  return { type: 'command', command }
}

/** Whether a path can go inside the status line command's double quotes and
 *  be read there as nothing but a path: no `$`, backtick or `"`, no control
 *  character, and on Windows no `%` or `!`, elsewhere no backslash. */
export function statuslinePathIsPlain(p: string, win32: boolean): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[$`"\x00-\x1f\x7f]/.test(p)) return false
  return win32 ? !/[%!]/.test(p) : !p.includes('\\')
}
