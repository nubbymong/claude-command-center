/**
 * rc.14 review F11 (aicc_planning#55): the liveness probe must look for tmux
 * everywhere the End command does.
 *
 * Both run over a NON-LOGIN ssh exec with a minimal PATH. A Homebrew tmux on
 * macOS (/opt/homebrew/bin or /usr/local/bin) is only on the login PATH, so a
 * probe that tried `command tmux` and the staged binary alone came back empty
 * WITH its completion sentinel -- a verified-empty answer -- and the store
 * pruned live Remote Resumable entries. The End command already tried the
 * extra locations; this file pins the two candidate lists to each other so
 * they cannot drift apart again.
 */
import { describe, it, expect } from 'vitest'
import { buildTmuxListCommand, TMUX_LIVENESS_BIN_EXPRS } from '../../../src/main/ssh-liveness'
import { buildRemoteTmuxKillCommand } from '../../../src/main/providers/claude/ssh-shim'

const unquote = (s: string) => s.replace(/"/g, '')

describe('liveness probe tmux candidates', () => {
  it('include the Homebrew (arm64 + intel) and system locations, not just PATH and the staged binary', () => {
    const cmd = buildTmuxListCommand()
    for (const bin of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
      expect(cmd).toContain(`${bin} ls -F '#{session_name}' 2>/dev/null`)
    }
  })

  it('PARITY: every tmux binary the End command kills through is one the probe lists through', () => {
    const kill = buildRemoteTmuxKillCommand('sess-1')
    const killBins = [...kill.matchAll(/(\S+) kill-session -t /g)].map((m) => unquote(m[1]))
    expect(killBins.length).toBeGreaterThanOrEqual(5)
    const probe = unquote(buildTmuxListCommand())
    for (const bin of killBins) {
      // `tmux` bare in the kill list is the probe's `command tmux`.
      expect(probe, `probe is missing ${bin}`).toContain(`${bin} ls -F '#{session_name}'`)
    }
  })

  it('every candidate is a host-authored literal: no wire operand, no interpolation', () => {
    for (const bin of TMUX_LIVENESS_BIN_EXPRS) {
      expect(bin).toMatch(/^(command tmux|"\$HOME"\/\.claude\/bin\/tmux|\/[A-Za-z0-9_./-]+\/tmux)$/)
    }
  })
})
