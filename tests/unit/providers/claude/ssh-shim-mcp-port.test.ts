// #24: the remote Claude's MCP URL must point at the PER-SESSION remote listen
// port (opts.remoteMcpPort), which sshd forwards to the one shared local server.
// Before #24 it hardcoded the single local port, so two sessions to one host
// collided. These pin that the emitted setup script bakes the per-session port.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 19333, // the shared LOCAL server port
  getConductorMcpSecret: () => 'b'.repeat(64),
  mcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))

import { generateRemoteSetupScript, generateWindowsRemoteSetupScript } from '../../../../src/main/providers/claude/ssh-shim'

const NONCE = 'testnonce123abc'

describe('#24 remote MCP URL uses the per-session port', () => {
  it('POSIX: bakes localhost:<remoteMcpPort>/sse, not the shared local port', () => {
    const script = generateRemoteSetupScript('sid-1', null, { remoteMcpPort: 40007 }, NONCE)
    expect(script).toContain('localhost:40007/sse')
    expect(script).not.toContain('localhost:19333/sse')
  })

  it('Windows: bakes localhost:<remoteMcpPort>/sse too', () => {
    const script = generateWindowsRemoteSetupScript('sid-1', { remoteMcpPort: 40007 }, NONCE)
    expect(script).toContain('localhost:40007/sse')
    expect(script).not.toContain('localhost:19333/sse')
  })

  it('falls back to the shared local port when no per-session port is given (pre-#24 shape)', () => {
    const script = generateRemoteSetupScript('sid-1', null, undefined, NONCE)
    expect(script).toContain('localhost:19333/sse')
  })

  it('falls back to the local port when remoteMcpPort is 0 (server-down defensive)', () => {
    const script = generateRemoteSetupScript('sid-1', null, { remoteMcpPort: 0 }, NONCE)
    expect(script).toContain('localhost:19333/sse')
  })
})

// #25: the setup pre-accepts claude's first-run trust dialog for the configured
// remotePath, so concurrent sessions don't race on the prompt and one exit to a
// bare shell.
describe('#25 pre-trust the configured remote folder', () => {
  it('bakes a hasTrustDialogAccepted write into ~/.claude.json for the default (~) path', () => {
    const script = generateRemoteSetupScript('sid-1', null, undefined, NONCE, '~')
    expect(script).toContain('hasTrustDialogAccepted')
    expect(script).toContain('.claude.json')
  })

  it('embeds the exact configured remotePath as a string literal (not shell-interpolated)', () => {
    const script = generateRemoteSetupScript('sid-1', null, undefined, NONCE, '/srv/app')
    expect(script).toContain('"/srv/app"')
    expect(script).toContain('hasTrustDialogAccepted')
  })

  it('resolves ~, ~/sub, and relative paths against the remote home', () => {
    const script = generateRemoteSetupScript('sid-1', null, undefined, NONCE, '~/proj')
    // The remote node resolves ~/ and relative paths against os.homedir().
    expect(script).toContain('path.join(home,rp.slice(2))')
    expect(script).toContain('path.resolve(home,rp)')
  })
})
