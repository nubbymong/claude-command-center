/**
 * Live T24 (2026-09-25): End in a ROOTFUL container whose sudo password was
 * typed at the entry prompt and never saved. The in-container stop could only
 * try `sudo -n`, sudo refused, the failure was swallowed and End reported
 * completed while Claude kept running in the container.
 *
 * buildContainerKillCommand now takes a per-End nonce. For a rootful container
 * with no saved sudo password it asks `sudo -n <engine> --version` first (under
 * `sh -c`, so its redirections never reach the host login shell) and, when
 * that fails, prints `CCC_END_SUDO_NEEDED_<nonce>` on a line of its own
 * (parseEndSudoSentinel reads it); the kill is then attempted regardless,
 * byte-for-byte the no-probe `sudo -n` form. Outside single quotes the segment
 * uses only `;`, `||` and `2>/dev/null`, so it parses in every host login
 * shell: fish has no `if ...; then ...; fi`, and tcsh/csh reject
 * `>/dev/null 2>&1` ("Ambiguous output redirect").
 * ssh-end-remote-shell-compat.test.ts runs it through each installed shell.
 * Every other path (rootless, and T21's saved password) takes no probe.
 *
 * The in-container script runs under `sh -c`, not `bash -c` (a container
 * without bash failed the exec silently), and it is containerSessionStopScript,
 * the same builder the End notice's stop command uses. So the T20 (rootless)
 * and T21 (saved password) shapes pinned below changed ON PURPOSE in the T24
 * fix round: `bash -c` became `sh -c`, nothing else.
 *
 * Mutation to prove these can fail: put the `if sudo -n ...; then <kill>;
 * else printf ...; fi` form back, or the probe's `>/dev/null 2>&1` back outside
 * `sh -c`, or `bash -c` back, in buildContainerKillCommand; build
 * manualContainerStopCommand's script by hand again; or loosen
 * parseEndSudoSentinel's boundaries.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  mcpSessionToken: () => 'tok',
  issueMcpSessionToken: () => 'tok',
}))

import { buildContainerKillCommand, buildRemoteTmuxKillCommand, parseEndSudoSentinel, END_SUDO_SENTINEL_PREFIX } from '../../../../src/main/providers/claude/ssh-shim'
import { manualContainerStopCommand, containerSessionStopScript } from '../../../../src/shared/container-command'

const NONCE = 'a1b2c3d4e5f60718a1b2c3d4'
const ROOTLESS = { type: 'container', engine: 'podman', container: 'ccc-test' } as const
const ROOTFUL = { ...ROOTLESS, sudo: true } as const
const inner = (sid: string): string =>
  String.raw`rm -f ~/.claude/settings-${sid}.json ~/.claude/mcp-${sid}.json ~/.claude/ccc-status-${sid}.url 2>/dev/null; exec pkill -f "/settings-${sid}\.json"`
/** The probe prefix End puts before the kill (buildContainerKillCommand, 3). */
const probe = (engine: string, nonce: string): string =>
  `sh -c 'sudo -n ${engine} --version >/dev/null 2>&1' || ` + String.raw`printf '\n%s_%s\n' CCC_END_SUDO_NEEDED ` + `${nonce}; `

describe('buildContainerKillCommand: the paths that take no probe (byte-for-byte)', () => {
  it('rootless (T20), with or without a nonce: the script under sh -c', () => {
    const expected = `podman exec ccc-test sh -c '${inner('lv20abc')}' 2>/dev/null; true`
    expect(buildContainerKillCommand('lv20abc', ROOTLESS)).toBe(expected)
    expect(buildContainerKillCommand('lv20abc', ROOTLESS, { sudoProbeNonce: NONCE })).toBe(expected)
    expect(buildContainerKillCommand('lv20abc', ROOTLESS, { hasSudoPassword: true, sudoProbeNonce: NONCE })).toBe(expected)
  })

  it('rootful with a saved sudo password (T21): the prompt path, with or without a nonce', () => {
    const expected = `sudo -S -p password: podman exec ccc-test sh -c '${inner('lv21abc')}'; true`
    expect(buildContainerKillCommand('lv21abc', ROOTFUL, { hasSudoPassword: true })).toBe(expected)
    expect(buildContainerKillCommand('lv21abc', ROOTFUL, { hasSudoPassword: true, sudoProbeNonce: NONCE })).toBe(expected)
  })

  it('rootful, no saved password, and no usable nonce: the plain `sudo -n` form', () => {
    const expected = `sudo -n podman exec ccc-test sh -c '${inner('s1')}' 2>/dev/null; true`
    expect(buildContainerKillCommand('s1', ROOTFUL)).toBe(expected)
    for (const bad of ['', 'short', 'UPPERCASE0123456789', 'a1b2 c3d4e5f6', "a1b2c3d4'; x", 'a'.repeat(65)]) {
      expect(buildContainerKillCommand('s1', ROOTFUL, { sudoProbeNonce: bad }), bad).toBe(expected)
    }
  })

  it('never `bash -c`: a container without bash must still run the kill', () => {
    for (const cmd of [
      buildContainerKillCommand('s1', ROOTLESS),
      buildContainerKillCommand('s1', ROOTFUL, { hasSudoPassword: true }),
      buildContainerKillCommand('s1', ROOTFUL),
      buildContainerKillCommand('s1', ROOTFUL, { sudoProbeNonce: NONCE }),
      buildContainerKillCommand('s1', { ...ROOTLESS, shell: 'sh' }),
    ]) {
      expect(cmd).not.toContain('bash')
      expect(cmd).toContain(` exec ccc-test sh -c '${containerSessionStopScript('s1')}'`)
    }
  })

  it('a host runtime or an invalid name still yields no command at all', () => {
    expect(buildContainerKillCommand('s1', { type: 'host' }, { sudoProbeNonce: NONCE })).toBe('')
    expect(buildContainerKillCommand('s1', { ...ROOTFUL, container: 'a b' }, { sudoProbeNonce: NONCE })).toBe('')
  })
})

describe('buildContainerKillCommand: the sudo probe (rootful, no saved sudo password)', () => {
  it('asks sudo first, prints the sentinel on its own line when it cannot, then attempts the kill regardless', () => {
    const kill = `sudo -n podman exec ccc-test sh -c '${inner('lv24abc')}' 2>/dev/null`
    expect(buildContainerKillCommand('lv24abc', ROOTFUL, { sudoProbeNonce: NONCE })).toBe(
      `${probe('podman', NONCE)}${kill}; true`,
    )
  })

  it('the kill after the probe is exactly the no-probe `sudo -n` kill', () => {
    const withProbe = buildContainerKillCommand('lv24abc', ROOTFUL, { sudoProbeNonce: NONCE })
    const without = buildContainerKillCommand('lv24abc', ROOTFUL)
    expect(withProbe).toBe(probe('podman', NONCE) + without)
  })

  it('uses no if/then/else/fi (not fish syntax): only `;`, `||`, redirections and quotes', () => {
    const cmd = buildContainerKillCommand('s1', ROOTFUL, { sudoProbeNonce: NONCE })
    const unquoted = cmd.replace(/'[^']*'/g, "''")
    expect(unquoted).not.toMatch(/(^|[\s;])(if|then|else|elif|fi)(?=[\s;]|$)/)
    expect(unquoted).not.toContain('&&')
    expect(unquoted.match(/\|\|/g)).toHaveLength(1)
  })

  // tcsh/csh: a second output redirection on one command (`>/dev/null 2>&1`)
  // is a parse error there ("Ambiguous output redirect") that fails the WHOLE
  // End line; HEAD's line, with only `2>/dev/null`, still ran. So on the whole
  // line End sends, every redirection that is not `2>/dev/null` sits inside
  // single quotes (the probe's own, under `sh -c`).
  it('outside single quotes the whole End line redirects only with `2>/dev/null` (tcsh/csh parse it, as they did before)', () => {
    const line = `${buildContainerKillCommand('s1', ROOTFUL, { sudoProbeNonce: NONCE })}; ${buildRemoteTmuxKillCommand('s1')}`
    const unquoted = line.replace(/'[^']*'/g, "''")
    expect(unquoted).not.toMatch(/>&|&>|>>/)
    const redirects = unquoted.match(/\d*>\S*/g) ?? []
    expect(redirects.length).toBeGreaterThan(0)
    for (const r of redirects) expect(r, r).toMatch(/^2>\/dev\/null;?$/)
  })

  it('probes the engine the runtime names', () => {
    expect(buildContainerKillCommand('s1', { ...ROOTFUL, engine: 'docker' }, { sudoProbeNonce: NONCE })).toMatch(/^sh -c 'sudo -n docker --version /)
  })

  it('the command text never carries the joined sentinel, so its own echo cannot be read as one', () => {
    const cmd = buildContainerKillCommand('s1', ROOTFUL, { sudoProbeNonce: NONCE })
    expect(cmd).not.toContain(`${END_SUDO_SENTINEL_PREFIX}_${NONCE}`)
    expect(parseEndSudoSentinel(cmd, NONCE)).toBe(false)
  })

  it('never prompts: no `-S`, and every sudo is `-n`', () => {
    const cmd = buildContainerKillCommand('s1', ROOTFUL, { sudoProbeNonce: NONCE })
    expect(cmd).not.toContain('-S')
    expect(cmd.match(/sudo(?! -n )/g)).toBeNull()
  })
})

describe('the stop command the End notice shows runs exactly what End runs in the container', () => {
  it('the same script, from the one shared builder, under sh -c, with a plain sudo', () => {
    for (const sid of ['lv24abc', 'odd id/with:chars', `x'; rm -rf / #$(y)`]) {
      const end = buildContainerKillCommand(sid, ROOTFUL, { sudoProbeNonce: NONCE })
      const endScript = end.match(/ exec ccc-test sh -c '([^']+)'/)![1]
      const shown = manualContainerStopCommand(sid, 'podman', 'ccc-test')!
      expect(shown).toBe(`sudo podman exec ccc-test sh -c '${containerSessionStopScript(sid)}'`)
      expect(shown.match(/ exec ccc-test sh -c '([^']+)'$/)![1]).toBe(endScript)
      // It removes the session's files, not only the pkill.
      expect(endScript).toContain('rm -f ~/.claude/settings-')
    }
  })
})

describe('parseEndSudoSentinel', () => {
  const token = `${END_SUDO_SENTINEL_PREFIX}_${NONCE}`

  it('reads the sentinel on its own line, between other output, and at the very end', () => {
    expect(parseEndSudoSentinel(`${token}\n`, NONCE)).toBe(true)
    expect(parseEndSudoSentinel(`motd line\r\n${token}\r\nmore`, NONCE)).toBe(true)
    expect(parseEndSudoSentinel(token, NONCE)).toBe(true)
    // What printf '\n%s_%s\n' prints after output that did not end its line.
    expect(parseEndSudoSentinel(`no newline yet\n${token}\n`, NONCE)).toBe(true)
  })

  it('strips escapes first: a ConPTY-glued sentinel is still read', () => {
    expect(parseEndSudoSentinel(`\x1b[?25l${token}\x1b[?25h\r\n`, NONCE)).toBe(true)
    expect(parseEndSudoSentinel(`${END_SUDO_SENTINEL_PREFIX}_\x1b[0m${NONCE}\r\n`, NONCE)).toBe(true)
    expect(parseEndSudoSentinel(`\x1b]0;title\x07${token}`, NONCE)).toBe(true)
  })

  it('ignores another nonce, a partial one, a longer one, and a glued prefix', () => {
    expect(parseEndSudoSentinel(`${END_SUDO_SENTINEL_PREFIX}_${'0'.repeat(24)}\n`, NONCE)).toBe(false)
    expect(parseEndSudoSentinel(`${END_SUDO_SENTINEL_PREFIX}_${NONCE.slice(0, -1)}\n`, NONCE)).toBe(false)
    expect(parseEndSudoSentinel(`${token}0\n`, NONCE)).toBe(false)
    expect(parseEndSudoSentinel(`X${token}\n`, NONCE)).toBe(false)
    expect(parseEndSudoSentinel(`${END_SUDO_SENTINEL_PREFIX} ${NONCE}\n`, NONCE)).toBe(false)
    expect(parseEndSudoSentinel('', NONCE)).toBe(false)
  })

  it('refuses a nonce that could not have come from randomId()', () => {
    for (const bad of ['', 'abc', 'A1B2C3D4E5F6', '.*', `${NONCE}|x`]) {
      expect(parseEndSudoSentinel(`${END_SUDO_SENTINEL_PREFIX}_${bad}\n`, bad), bad).toBe(false)
    }
  })
})
