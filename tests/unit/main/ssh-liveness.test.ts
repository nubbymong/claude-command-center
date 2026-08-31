/**
 * SSH Persistent — the main-side liveness command + parse.
 *
 * The remote command must be a host-authored literal with NO wire operand (the
 * candidate ids are matched LOCALLY via safeSid, never interpolated), and the
 * parse must tell a COMPLETED run (sentinel present — even with zero sessions)
 * apart from a connection failure (no sentinel), then intersect the reported tmux
 * names with the queried `ccc-<safeSid(id)>` targets.
 */
import { describe, it, expect } from 'vitest'
import {
  buildTmuxListCommand,
  parseTmuxLivenessOutput,
  computeLiveSessionIds,
  TMUX_LIVENESS_BEGIN,
  TMUX_LIVENESS_END,
} from '../../../src/main/ssh-liveness'

const wrap = (body: string) => `${TMUX_LIVENESS_BEGIN}\n${body}\n${TMUX_LIVENESS_END}\n`

describe('buildTmuxListCommand', () => {
  const cmd = buildTmuxListCommand()

  it('brackets the tmux listing with the completion sentinels', () => {
    expect(cmd.startsWith(`echo ${TMUX_LIVENESS_BEGIN};`)).toBe(true)
    expect(cmd.endsWith(`echo ${TMUX_LIVENESS_END}`)).toBe(true)
  })

  it('lists names from BOTH the on-PATH and the staged tmux, single-quoting the format', () => {
    expect(cmd).toContain(`command tmux ls -F '#{session_name}' 2>/dev/null`)
    expect(cmd).toContain(`"$HOME"/.claude/bin/tmux ls -F '#{session_name}' 2>/dev/null`)
  })

  it('carries NO candidate/session operand — it is a fixed literal', () => {
    // The only tokens are the fixed tmux exprs, `ls`, the quoted format, redirs,
    // echoes and sentinels. Nothing resembling a ccc-<id> target appears.
    expect(cmd).not.toMatch(/ccc-/)
  })
})

describe('parseTmuxLivenessOutput', () => {
  it('marks completed and returns the names between the sentinels', () => {
    const { completed, names } = parseTmuxLivenessOutput(wrap('ccc-a\nccc-b\nother'))
    expect(completed).toBe(true)
    expect(names).toEqual(['ccc-a', 'ccc-b', 'other'])
  })

  it('a completed run with ZERO sessions is completed with no names (verified-empty, not a failure)', () => {
    const { completed, names } = parseTmuxLivenessOutput(wrap(''))
    expect(completed).toBe(true)
    expect(names).toEqual([])
  })

  it('no END sentinel => NOT completed (a connection/auth failure — unverified)', () => {
    expect(parseTmuxLivenessOutput('ssh: connect to host pi.local port 22: Connection refused')).toEqual({
      completed: false,
      names: [],
    })
  })

  it('dedupes names reported by both tmux tiers', () => {
    expect(parseTmuxLivenessOutput(wrap('ccc-a\nccc-a\nccc-b')).names).toEqual(['ccc-a', 'ccc-b'])
  })

  it('tolerates a login banner before BEGIN, ANSI escapes and CRLF', () => {
    const raw = `Last login: today\r\n\x1b[32m${TMUX_LIVENESS_BEGIN}\x1b[0m\r\nccc-a\r\nccc-b\r\n${TMUX_LIVENESS_END}\r\n`
    expect(parseTmuxLivenessOutput(raw).names).toEqual(['ccc-a', 'ccc-b'])
  })
})

describe('computeLiveSessionIds', () => {
  it('returns the queried ids whose ccc-<safeSid> target is in the reported names', () => {
    // The deliverable case: names ccc-a, ccc-b, other; candidates a, b, z.
    expect(computeLiveSessionIds(['a', 'b', 'z'], ['ccc-a', 'ccc-b', 'other'])).toEqual(['a', 'b'])
  })

  it('matches via safeSid so a metachar-laden id maps to its sanitized target', () => {
    // safeSid('weird id!') => 'weird_id_' => target 'ccc-weird_id_'.
    expect(computeLiveSessionIds(['weird id!'], ['ccc-weird_id_'])).toEqual(['weird id!'])
  })

  it('returns [] when nothing matches', () => {
    expect(computeLiveSessionIds(['a', 'b'], ['ccc-x', 'other'])).toEqual([])
  })

  it('end-to-end: parse a listing then intersect with candidates', () => {
    const parsed = parseTmuxLivenessOutput(wrap('ccc-a\nccc-b\nother'))
    expect(computeLiveSessionIds(['a', 'b', 'z'], parsed.names)).toEqual(['a', 'b'])
  })
})
