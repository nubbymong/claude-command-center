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
 * argv[2] and the /status POST URL rides argv[3] — the SAME argv convention
 * as both remote shims (ssh-shim.ts), so all three bridges resolve identity
 * and delivery identically. The URL is double-quoted: `&` in its query would
 * otherwise split the command under cmd.exe (and background it under sh);
 * statusPostUrl charset-guards the value so the quotes cannot be escaped
 * from. With no sessionId (legacy caller) or no URL (MCP server not bound)
 * the script falls back to env/stdin identity and file delivery.
 */
export function buildStatuslineSetting(
  resourcesDir: string,
  sessionId?: string,
  statusUrl?: string,
): { type: 'command'; command: string } {
  const script = path.join(resourcesDir, 'scripts', 'claude-multi-statusline.js')
  let command =
    os.platform() === 'win32'
      ? `node "${script.replace(/\\/g, '\\\\')}"`
      : `node "${script}"`
  if (sessionId) {
    // Same sanitisation as every other sid embedding (filenames, remote
    // commands): belt-and-braces for a value that is hex in practice.
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    command += ` ${safeSid}`
    if (statusUrl) command += ` "${statusUrl}"`
  }
  return { type: 'command', command }
}
