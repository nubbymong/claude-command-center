import { describe, it, expect, vi } from 'vitest'

// statusPostUrl (harmonise-remote): the tunnel URL baked into the remote
// statusLine command. Contract: empty when there is no tunnel to ride (shim
// falls back to the OSC ladder); prefers the remote -R listen port; the value
// is charset-safe for embedding in sh single quotes and cmd double quotes.

vi.mock('../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 43110,
  mcpSessionToken: (sid: string) => 'ab'.repeat(32) + '-' + sid.length, // deterministic, hex-ish
}))
vi.mock('../../src/main/hooks/session-hooks-writer', () => ({ buildHooksBlock: () => null }))

import { statusPostUrl, generateRemoteSetupScript, generateWindowsRemoteSetupScript } from '../../src/main/providers/claude/ssh-shim'

describe('statusPostUrl', () => {
  it('is empty when the MCP server is off (port 0) — shim falls back to the OSC ladder', () => {
    expect(statusPostUrl('abc123', 45111, 0, true)).toBe('')
  })

  it('is empty when the tunnel is excluded (includeConductorMcp=false)', () => {
    expect(statusPostUrl('abc123', 45111, 43110, false)).toBe('')
  })

  it('prefers the remote -R listen port and binds the session id + token', () => {
    const url = statusPostUrl('abc123', 45111, 43110, true)
    expect(url.startsWith('http://127.0.0.1:45111/status?')).toBe(true)
    expect(url).toContain('cccSessionId=abc123')
    expect(url).toContain('token=')
  })

  it('falls back to the local MCP port when no remote port is allocated', () => {
    const url = statusPostUrl('abc123', 0, 43110, true)
    expect(url.startsWith('http://127.0.0.1:43110/status?')).toBe(true)
  })

  it('stays inside the shell-safe charset (no quotes, spaces, or metacharacters beyond ?=&)', () => {
    const url = statusPostUrl('abc123', 45111, 43110, true)
    expect(/^[A-Za-z0-9:/?=&._%-]+$/.test(url)).toBe(true)
  })
})

describe('setup script plumbing', () => {
  it('POSIX statusLine command carries CCC_STATUS_URL single-quoted when the tunnel is on', () => {
    const script = generateRemoteSetupScript('abc123', null, { remoteMcpPort: 45111, includeConductorMcp: true }, 'nonceA1', '~')
    expect(script).toContain("CCC_STATUS_URL=\\'http://127.0.0.1:45111/status?cccSessionId=abc123&token=")
  })

  it('POSIX statusLine command omits the CCC_STATUS_URL assignment when the tunnel is off', () => {
    const script = generateRemoteSetupScript('abc123', null, { remoteMcpPort: 0, includeConductorMcp: false }, 'nonceA1', '~')
    // The shim SOURCE always mentions CCC_STATUS_URL (it reads the env var);
    // what must be absent is the command-line ASSIGNMENT that would arm tier 0.
    expect(script).not.toContain("CCC_STATUS_URL=\\'")
  })

  it('Windows statusLine command carries the URL as a double-quoted argv[3]', () => {
    const script = generateWindowsRemoteSetupScript('abc123', { remoteMcpPort: 45111, includeConductorMcp: true }, 'nonceA1')
    expect(script).toContain('"http://127.0.0.1:45111/status?cccSessionId=abc123&token=')
  })

  it('both shims ship tunnel-first delivery with the legacy ladder as fallback', () => {
    const posix = generateRemoteSetupScript('abc123', null, { remoteMcpPort: 45111, includeConductorMcp: true }, 'nonceA1', '~')
    const win = generateWindowsRemoteSetupScript('abc123', { remoteMcpPort: 45111, includeConductorMcp: true }, 'nonceA1')
    for (const script of [posix, win]) {
      expect(script).toContain('CCC_STATUS_URL')
      expect(script).toContain('post-ok')
      expect(script).toContain('post-fail')
      expect(script).toContain('deliverLegacy')
    }
  })
})
