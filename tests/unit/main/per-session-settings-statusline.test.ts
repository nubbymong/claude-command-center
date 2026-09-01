// U2 (2a): CCC must deliver its statusLine PER-SESSION (in ~/.claude/settings-<sid>.json)
// rather than via a global ~/.claude/settings.json write. writeLocalSessionSettings
// injects the statusLine command (pointing at the bundled resources script) and
// overrides any statusLine inherited from the shared-settings clone.
//
// Local unification (harmonise-remote): the command now carries the session id
// (argv[2]) and the delivery target (argv[3]) so the local bridge delivers over
// the same channel as the SSH shims, with the watched status file as fallback.
// ADR-009 token custody: argv[3] is the PATH of a 0600 sidecar holding the
// /status URL, never the token-bearing URL itself.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Deterministic MCP port/token so the /status URL bake is assertable. The mock
// applies to BOTH direct imports (writeLocalSessionMcpConfig) and the
// statusPostUrl path inside ssh-shim.ts. Port is a mutable holder so one test
// can exercise the server-unbound (port 0) fallback.
const h = vi.hoisted(() => ({ port: 19333 }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => h.port,
  mcpSessionToken: (sessionId: string) => `tok${sessionId.replace(/[^a-zA-Z0-9]/g, '')}`,
}))

import { writeLocalSessionSettings } from '../../../src/main/hooks/per-session-settings'

describe('writeLocalSessionSettings -- per-session statusLine', () => {
  let fakeHome = ''
  let claudeDir = ''
  const resourcesDir = () => path.join(fakeHome, 'res')
  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'per-session-sl-'))
    claudeDir = path.join(fakeHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome)
    h.port = 19333
  })
  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('injects a statusLine command pointing at the bundled script when resourcesDir is given', () => {
    const p = writeLocalSessionSettings('sid-1', { resourcesDir: resourcesDir() })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.statusLine?.type).toBe('command')
    expect(cfg.statusLine?.command).toContain('claude-multi-statusline.js')
    expect(String(cfg.statusLine?.command).startsWith('node ')).toBe(true)
  })

  // ADR-009 token custody: argv[3] is the PATH of a 0600 sidecar holding the
  // /status URL, NOT the URL. The URL carries this session's MCP token — the
  // sole gate on the loopback MCP server and thus on vision_eval — and a
  // statusLine command is the argv of a process Claude Code respawns every
  // second or two, so baking it in published the token to every other account
  // on this machine through the process table.
  // Mutation to prove this can fail: pass `statusUrl` to buildStatuslineSetting.
  it('bakes the session id (argv[2]) and the status-URL FILE PATH (argv[3]); the token never reaches the command', () => {
    const p = writeLocalSessionSettings('sid-1', { resourcesDir: resourcesDir() })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const cmd = String(cfg.statusLine?.command)
    // argv[2]: the sanitised session id, space-separated after the script path.
    expect(cmd).toMatch(/claude-multi-statusline\.js" sid-1 /)
    // argv[3]: the sidecar path, double-quoted (it can contain spaces).
    expect(cmd).toContain(`"${path.join(claudeDir, 'ccc-status-sid-1.url')}"`.replace(/\\/g, '\\\\'))
    // Nothing secret on the command line.
    expect(cmd).not.toContain('token=')
    expect(cmd).not.toContain('http://')
    // The URL itself lives in the sidecar, owner-only.
    const urlFile = path.join(claudeDir, 'ccc-status-sid-1.url')
    expect(fs.readFileSync(urlFile, 'utf-8')).toBe('http://127.0.0.1:19333/status?cccSessionId=sid-1&token=toksid1')
    if (process.platform !== 'win32') {
      expect(fs.statSync(urlFile).mode & 0o777).toBe(0o600)
    }
  })

  it('omits argv[3] and writes no sidecar when the MCP server is unbound — file delivery fallback', () => {
    h.port = 0
    const p = writeLocalSessionSettings('sid-1', { resourcesDir: resourcesDir() })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const cmd = String(cfg.statusLine?.command)
    expect(cmd).toMatch(/claude-multi-statusline\.js" sid-1$/)
    expect(cmd).not.toContain('/status')
    expect(fs.existsSync(path.join(claudeDir, 'ccc-status-sid-1.url'))).toBe(false)
  })

  it('sweeps a STALE sidecar from a previous connect when the server is unbound', () => {
    // A URL naming a port this session no longer owns must not be readable by
    // the bridge on the next tick.
    const urlFile = path.join(claudeDir, 'ccc-status-sid-1.url')
    fs.writeFileSync(urlFile, 'http://127.0.0.1:1/status?cccSessionId=sid-1&token=stale')
    h.port = 0
    writeLocalSessionSettings('sid-1', { resourcesDir: resourcesDir() })
    expect(fs.existsSync(urlFile)).toBe(false)
  })

  it('overrides any statusLine inherited from the shared-settings clone (and keeps other keys)', () => {
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'GLOBAL_PLACEHOLDER' },
        outputStyle: 'concise',
      }),
    )
    const p = writeLocalSessionSettings('sid-2', { resourcesDir: resourcesDir() })
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.statusLine?.command).not.toBe('GLOBAL_PLACEHOLDER')
    expect(cfg.statusLine?.command).toContain('claude-multi-statusline.js')
    expect(cfg.outputStyle).toBe('concise')
  })

  it('does not inject a statusLine when no resourcesDir is provided', () => {
    const p = writeLocalSessionSettings('sid-3', {})
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(cfg.statusLine).toBeUndefined()
  })
})
