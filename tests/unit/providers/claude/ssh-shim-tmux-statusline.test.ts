// tests/unit/providers/claude/ssh-shim-tmux-statusline.test.ts
//
// #242 item 2: the statusline shim's $TMUX branch must run BEFORE the
// ancestor-pts walk (findPty) -- under tmux, the pts walk lands on the
// PANE's pty, which tmux swallows the OSC sentinel into rather than
// forwarding to the attached client. These tests pin the mechanism (not
// just its presence) so a revert of the wiring -- dropping the branch,
// reordering it after the pts walk, or dropping the CCC_TMUX_BIN bake-in --
// fails loudly instead of leaving the suite green.
import { describe, it, expect, vi } from 'vitest'

const MOCK_SECRET = 'b'.repeat(64)
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 19333,
  getConductorMcpSecret: () => MOCK_SECRET,
  // GHSA-q83v (landed on beta while this branch was out): the remote config
  // carries HMAC(secret, sessionId) rather than the raw secret, so the shim
  // now imports this too. Deterministic stub, matching ssh-shim.test.ts.
  mcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))

import { generateRemoteSetupScript } from '../../../../src/main/providers/claude/ssh-shim'

// #242 finding F1 (b): generateRemoteSetupScript now requires a nonce.
const NONCE = 'testnonce123abc'

describe('SSH statusline shim -- $TMUX client_tty branch (#242 item 2)', () => {
  it('(a) embeds the $TMUX / client_tty branch in the emitted shim', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain('process.env.TMUX')
    expect(script).toContain('#{client_tty}')
    expect(script).toContain('display-message')
  })

  it('(b) the $TMUX guard precedes the ancestor-pts walk (findPty call) in the emitted source', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    const tmuxGuardIdx = script.indexOf('process.env.TMUX')
    // findPty is DEFINED earlier (function declaration); what matters is
    // where it is CALLED, inside the fallback chain -- `const pts=findPty()`.
    const findPtyCallIdx = script.indexOf('const pts=findPty()')
    expect(tmuxGuardIdx).toBeGreaterThan(-1)
    expect(findPtyCallIdx).toBeGreaterThan(-1)
    expect(tmuxGuardIdx).toBeLessThan(findPtyCallIdx)
  })

  it('(b cont.) the $TMUX guard also precedes the /dev/tty attempt', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    const tmuxGuardIdx = script.indexOf('process.env.TMUX')
    const devTtyIdx = script.indexOf(`fs.writeFileSync('/dev/tty'`)
    expect(tmuxGuardIdx).toBeGreaterThan(-1)
    expect(devTtyIdx).toBeGreaterThan(-1)
    expect(tmuxGuardIdx).toBeLessThan(devTtyIdx)
  })

  it('(c) bakes CCC_TMUX_BIN into the per-session statusLine command, sourced from the tier-1/2 probe result', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain(`CCC_TMUX_BIN='+tmuxPath+'`)
    // It rides alongside CLAUDE_MULTI_SESSION_ID in the SAME command string,
    // not a separate/duplicate statusLine stanza.
    const parts = script.split(`Object.assign({},sBase,{`)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const sesCfgBody = parts[1].split('})')[0]
    expect(sesCfgBody).toContain('CLAUDE_MULTI_SESSION_ID=sid-x')
    expect(sesCfgBody).toContain(`CCC_TMUX_BIN='+tmuxPath+'`)
  })

  it('(c cont.) the tmux probe (tmuxPath) is declared BEFORE the sesCfg statusLine command references it', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    const probeDeclIdx = script.indexOf(`let tmuxPath=''`)
    const sesCfgIdx = script.indexOf(`CCC_TMUX_BIN='+tmuxPath+'`)
    expect(probeDeclIdx).toBeGreaterThan(-1)
    expect(sesCfgIdx).toBeGreaterThan(-1)
    expect(probeDeclIdx).toBeLessThan(sesCfgIdx)
  })

  it('the shim resolves tmuxBin from $CCC_TMUX_BIN, not a hardcoded PATH guess', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain('process.env.CCC_TMUX_BIN')
  })

  it('empty #{client_tty} output (detached session) is traced and skipped, not treated as success', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain('tmux-detached')
  })

  it('a failed tmux server call is traced distinctly from a detached session', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain('tmux-fail')
  })

  it('a successful client_tty write is traced', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain('tmux-clienttty-ok')
  })

  // #242 MINOR (round 2, adversarial review): a wedged/half-dead tmux server
  // must not block the statusLine child indefinitely on every refresh.
  it('bounds the display-message call with a timeout (a hung tmux server must not stall the statusline)', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain(`{encoding:'utf8',timeout:2000}`)
  })

  it('includeStatusLine=false still omits CCC_TMUX_BIN (no statusLine command to carry it)', () => {
    const script = generateRemoteSetupScript('sid-x', null, { includeStatusLine: false }, NONCE)
    const parts = script.split(`Object.assign({},sBase,{`)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const sesCfgBody = parts[1].split('})')[0]
    expect(sesCfgBody).not.toContain('CCC_TMUX_BIN')
    expect(sesCfgBody).not.toContain('statusLine')
  })

  // #242 MAJOR (round 2, adversarial review): tmuxPath from either probe
  // (tier 1 `command -v tmux`, tier 2 ~/.claude/bin/tmux) reaches the
  // CCC_TMUX_BIN bake-in with no charset guard. A merely awkward value (a
  // relative path with a space, e.g. `tools/tmux`) survives `sh -c`
  // re-splitting and executes out of the session's cwd instead of the shim.
  // The remote script must clear (not pass through) a non-conforming
  // tmuxPath before that sink, using the SAME character class as
  // SAFE_TMUX_BIN_RE in src/main/ssh-tmux.ts.
  //
  // #242 round-3 correction (I3): the guard now ALSO resets `tmuxClass` to
  // 'none' alongside `tmuxPath` -- tmuxClass is what crosses back over the
  // wire in the `setup ok ... tmux=` sentinel, so a value that fails this
  // charset guard must not leave a stale 'path'/'home' class behind after
  // tmuxPath itself was cleared.
  describe('tmuxPath allowlist guard (#242 round 2 MAJOR)', () => {
    it('(i) emits an allowlist guard that clears a non-conforming tmuxPath AND tmuxClass', () => {
      const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
      expect(script).toContain(`if(tmuxPath&&!/^[A-Za-z0-9_./-]+$/.test(tmuxPath)){tmuxPath='';tmuxClass='none'}`)
    })

    it('(ii) the guard precedes both the CCC_TMUX_BIN bake-in and the "setup ok tmux=" sentinel', () => {
      const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
      const guardIdx = script.indexOf(`if(tmuxPath&&!/^[A-Za-z0-9_./-]+$/.test(tmuxPath)){tmuxPath='';tmuxClass='none'}`)
      const bakeInIdx = script.indexOf(`CCC_TMUX_BIN='+tmuxPath+'`)
      const sentinelIdx = script.indexOf(`setup ok ${NONCE} tmux=`)
      expect(guardIdx).toBeGreaterThan(-1)
      expect(bakeInIdx).toBeGreaterThan(-1)
      expect(sentinelIdx).toBeGreaterThan(-1)
      expect(guardIdx).toBeLessThan(bakeInIdx)
      expect(guardIdx).toBeLessThan(sentinelIdx)
    })

    it('the guard character class is identical to SAFE_TMUX_BIN_RE in ssh-tmux.ts (the paired sink)', async () => {
      const { SAFE_TMUX_BIN_RE } = await import('../../../../src/main/ssh-tmux')
      const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
      // Extract the class body embedded in the emitted guard and compare
      // against the regex object's own source, rather than hardcoding the
      // class twice in this test -- a future edit to either one flags a
      // mismatch here instead of the two silently drifting apart.
      const m = script.match(/if\(tmuxPath&&!\/\^(\[[^\]]+\]\+)\$\/\.test\(tmuxPath\)\)\{tmuxPath='';tmuxClass='none'\}/)
      expect(m).not.toBeNull()
      const emittedClass = m![1]
      expect(SAFE_TMUX_BIN_RE.source).toBe(`^${emittedClass}$`)
    })
  })

  // #242 round-3 correction (I3): the sentinel now carries a fixed CLASS
  // (path/home/none), never the probed path itself -- the wire-reported
  // path this codebase used to trust for tier 1/2 command construction is
  // gone by construction, not by a stronger validator.
  describe('setup ok sentinel carries a tmux CLASS, not a path (#242 finding I3)', () => {
    it('emits tmux=+tmuxClass in the sentinel, not tmuxPath', () => {
      const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
      expect(script).toContain(`process.stdout.write('setup ok ${NONCE} tmux='+tmuxClass+'\\n')`)
      expect(script).not.toContain(`process.stdout.write('setup ok ${NONCE} tmux='+tmuxPath`)
    })

    it('sets tmuxClass to "path" when tier 1 (command -v tmux) succeeds', () => {
      const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
      expect(script).toContain(`tmuxClass='path'`)
    })

    it('sets tmuxClass to "home" when tier 2 (~/.claude/bin/tmux) succeeds', () => {
      const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
      expect(script).toContain(`tmuxClass='home'`)
    })

    it('defaults tmuxClass to "none"', () => {
      const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
      expect(script).toContain(`let tmuxPath='';let tmuxClass='none';`)
    })
  })
})
