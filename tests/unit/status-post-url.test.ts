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

import { statusPostUrl, generateRemoteSetupScript, generateWindowsRemoteSetupScript, getWindowsRemoteSetupCommand, SSH_STATUSLINE_SHIM, SSH_STATUSLINE_SHIM_WINDOWS } from '../../src/main/providers/claude/ssh-shim'

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
  // ADR-009 token custody. The URL carries this session's MCP token, and both
  // pre-hardening forms (a POSIX shell env-prefix, a Windows argv) published it
  // to the remote host's process table for the session's whole life. It now goes
  // to a 0600 sidecar and only the PATH rides the command line.
  it('POSIX statusLine command carries CCC_STATUS_URL_FILE, never the URL, when the tunnel is on', () => {
    const script = generateRemoteSetupScript('abc123', null, { remoteMcpPort: 45111, includeConductorMcp: true }, 'nonceA1', '~')
    expect(script).toContain("CCC_STATUS_URL_FILE='+urlPath")
    // The URL itself is only ever WRITTEN to the sidecar.
    expect(script).toContain(`fs.writeFileSync(urlPath,"http://127.0.0.1:45111/status?cccSessionId=abc123&token=`)
    expect(script).toContain("{mode:0o600,flag:'wx'}")
    expect(script).not.toContain("CCC_STATUS_URL=\\'")
  })

  it('POSIX statusLine command omits the URL-file assignment and writes no sidecar when the tunnel is off', () => {
    const script = generateRemoteSetupScript('abc123', null, { remoteMcpPort: 0, includeConductorMcp: false }, 'nonceA1', '~')
    // The shim SOURCE always mentions CCC_STATUS_URL_FILE (it reads the env var);
    // what must be absent is the command-line ASSIGNMENT that would arm tier 0.
    expect(script).not.toContain("CCC_STATUS_URL_FILE='+urlPath")
    expect(script).not.toContain("CCC_STATUS_URL=\\'")
    // A stale sidecar from a previous connect is swept, never left readable.
    expect(script).toContain('try{fs.rmSync(urlPath,{force:true})}catch{}')
    expect(script).not.toContain('fs.writeFileSync(urlPath,')
  })

  it('Windows statusLine command carries the sidecar PATH as argv[3], not the URL', () => {
    const script = generateWindowsRemoteSetupScript('abc123', { remoteMcpPort: 45111, includeConductorMcp: true }, 'nonceA1')
    expect(script).toContain(`+' '+JSON.stringify(urlPath)`)
    expect(script).toContain(`fs.writeFileSync(urlPath,"http://127.0.0.1:45111/status?cccSessionId=abc123&token=`)
    expect(script).not.toContain(`' abc123 "http://`)
  })

  it('every line of the Windows setup command stays under cmd.exe input limit', () => {
    // The live regression this guards: the slice-2 gather snippet grew the
    // one-liner to ~11K chars and cmd.exe's 8191 input limit silently killed
    // setup (`running-setup → failed`). The chunked form must keep EVERY
    // typed line under the limit with margin, and still end by running node.
    const cmd = getWindowsRemoteSetupCommand('abc123', { remoteMcpPort: 45111, includeConductorMcp: true }, 'nonceA1')
    const lines = cmd.split('\r')
    for (const l of lines) expect(l.length).toBeLessThan(8000)
    expect(lines[lines.length - 1]).toContain('FromBase64String')
    expect(lines[lines.length - 1]).toContain('|node')
  })

  it('both shims are syntactically valid JS (a broken shim only explodes later on a remote host)', () => {
    for (const src of [SSH_STATUSLINE_SHIM, SSH_STATUSLINE_SHIM_WINDOWS]) {
      // A shebang is legal only at file top level — strip it for the parse check.
      expect(() => new Function(src.replace(/^#![^\n]*\n/, ''))).not.toThrow()
    }
  })

  it('both shims gather account + usage (Fable buckets) before delivering', () => {
    for (const src of [SSH_STATUSLINE_SHIM, SSH_STATUSLINE_SHIM_WINDOWS]) {
      expect(src).toContain('oauthAccount')
      expect(src).toContain('api.anthropic.com')
      expect(src).toContain('usageBuckets')
      // gather runs BEFORE the delivery choice: fetchUsage wraps deliver()
      expect(src).toContain('fetchUsage(function(lim){applyUsage(lim);deliver();})')
    }
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
