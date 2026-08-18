// Regression (mirror of the local vision-manager fix): the SSH remote setup
// program must NEVER unlinkSync the remote ~/.claude/CLAUDE.md. If stripping the
// legacy VISION-INSTRUCTIONS marker empties it, write an empty file instead.
import { describe, it, expect } from 'vitest'
import { generateRemoteSetupScript, buildRemoteSessionCleanupCommand } from '../../../../src/main/providers/claude/ssh-shim'

// #242 finding F1 (b): generateRemoteSetupScript now requires a nonce.
const NONCE = 'testnonce123abc'

describe('generateRemoteSetupScript -- remote CLAUDE.md handling', () => {
  it('never unlinks the remote CLAUDE.md; writes empty when the strip empties it', () => {
    const script = generateRemoteSetupScript('sess-abc', null, undefined, NONCE)
    // The CLAUDE.md cleanup is still present...
    expect(script).toContain("path.join(claudeDir,'CLAUDE.md')")
    // ...but it must not delete the user's file...
    expect(script).not.toContain('unlinkSync')
    // ...it writes an empty string instead when nothing remains.
    expect(script).toContain("fs.writeFileSync(md,c?c+'\\n':'')")
  })
})

describe('buildRemoteSessionCleanupCommand -- in-band SSH per-session cleanup (U8)', () => {
  it('rm -f the per-session settings + mcp files, and nothing else', () => {
    const cmd = buildRemoteSessionCleanupCommand('sess-abc')
    expect(cmd.startsWith('rm -f ')).toBe(true)
    expect(cmd).toContain('~/.claude/settings-sess-abc.json')
    expect(cmd).toContain('~/.claude/mcp-sess-abc.json')
    expect(cmd.endsWith('\n')).toBe(true)
    // Never touches the shared statusline shim (reused across sessions) or any
    // shared config file -- only the two per-session sidecars.
    expect(cmd).not.toContain('conductor-ssh-statusline')
    expect(cmd).not.toContain('settings.json ')
    expect(cmd).not.toContain('.claude.json')
    expect(cmd).not.toContain('CLAUDE.md')
  })

  it('sanitizes the session id so it cannot inject shell metacharacters', () => {
    const cmd = buildRemoteSessionCleanupCommand('a/b;x')
    expect(cmd).toContain('settings-a_b_x.json')
    expect(cmd).toContain('mcp-a_b_x.json')
  })
})
