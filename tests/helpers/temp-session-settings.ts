// A stand-in for src/main/hooks/per-session-settings for tests that spawn a
// local Claude session through pty-manager. The real module writes each
// session's settings-<sid>.json, mcp-<sid>.json and ccc-status-<sid>.url into
// os.homedir()/.claude -- the REAL Claude config folder of whoever runs the
// test, since the suite redirects only the temp directory (test-tmp.ts), not
// the home. This one has the same functions and file names, writing into a
// temp folder it makes under the per-worker temp root, removed by dispose().
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export function tempSessionSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-session-settings-'))
  const safe = (sessionId: string) => sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const settingsPath = (sessionId: string) => path.join(dir, `settings-${safe(sessionId)}.json`)
  const mcpPath = (sessionId: string) => path.join(dir, `mcp-${safe(sessionId)}.json`)
  const statusPath = (sessionId: string) => path.join(dir, `ccc-status-${safe(sessionId)}.url`)
  const write = (p: string, text: string) => { fs.writeFileSync(p, text); return p }
  const remove = (p: string) => { fs.rmSync(p, { force: true }) }
  return {
    /** The folder every file goes to. */
    dir,
    getLocalSessionSettingsPath: settingsPath,
    getLocalSessionMcpConfigPath: mcpPath,
    getLocalSessionStatusUrlPath: statusPath,
    writeLocalSessionSettings: (sessionId: string) => write(settingsPath(sessionId), '{}\n'),
    writeLocalSessionMcpConfig: (sessionId: string) => write(mcpPath(sessionId), '{"mcpServers":{}}\n'),
    writeLocalSessionStatusUrl: (sessionId: string) => write(statusPath(sessionId), 'http://127.0.0.1/status\n'),
    removeLocalSessionSettings: (sessionId: string) => remove(settingsPath(sessionId)),
    removeLocalSessionMcpConfig: (sessionId: string) => remove(mcpPath(sessionId)),
    removeLocalSessionStatusUrl: (sessionId: string) => remove(statusPath(sessionId)),
    /** Removes the folder and everything in it. */
    dispose: () => { fs.rmSync(dir, { recursive: true, force: true }) },
  }
}
