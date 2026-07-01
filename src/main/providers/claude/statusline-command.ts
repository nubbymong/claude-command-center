import path from 'node:path'
import os from 'node:os'

/**
 * Build the `statusLine` settings value that runs CCC's bundled statusline
 * bridge script (`<resourcesDir>/scripts/claude-multi-statusline.js`).
 *
 * Shared by the per-session settings writer so the command is delivered via
 * each session's `--settings settings-<sid>.json` file rather than a global
 * `~/.claude/settings.json` write. The script derives its status dir from its
 * own location and resolves the session id from Claude's stdin payload
 * (`data.session_id`), so no per-session env var is required.
 */
export function buildStatuslineSetting(resourcesDir: string): { type: 'command'; command: string } {
  const script = path.join(resourcesDir, 'scripts', 'claude-multi-statusline.js')
  const command =
    os.platform() === 'win32'
      ? `node "${script.replace(/\\/g, '\\\\')}"`
      : `node "${script}"`
  return { type: 'command', command }
}
