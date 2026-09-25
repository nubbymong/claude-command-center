/**
 * The End result the renderer reads (readSshEndRemoteResult) and the stop
 * command it shows for 'container-needs-sudo' (manualContainerStopCommand).
 * Live T24 (2026-09-25): End could not stop Claude inside a rootful container
 * because sudo wanted a password nobody had saved; the user is now told the
 * exact command, so what that command is built from matters: the sanitised
 * session id and a validated container name, nothing else. The host is only
 * shown, so a host the notice cannot show is left out rather than dropping the
 * whole result.
 *
 * Mutation to prove the host cases can fail: return null again from
 * readSshEndRemoteResult when the host fails HOST_DISPLAY_RE.
 */
import { describe, it, expect } from 'vitest'
import { readSshEndRemoteResult } from '../../../src/shared/ssh-end-result'
import { manualContainerStopCommand, containerSessionKillPattern, containerSessionStopScript } from '../../../src/shared/container-command'

const NEEDS = { outcome: 'container-needs-sudo', container: { engine: 'podman', name: 'ccc-test', host: 'rocky.lan' } }
const script = (sid: string): string =>
  String.raw`rm -f ~/.claude/settings-${sid}.json ~/.claude/mcp-${sid}.json ~/.claude/ccc-status-${sid}.url 2>/dev/null; exec pkill -f "/settings-${sid}\.json"`
const ch = (...codes: number[]): string => String.fromCharCode(...codes)

describe('readSshEndRemoteResult', () => {
  it('accepts the four outcomes, and the container details only with container-needs-sudo', () => {
    for (const outcome of ['completed', 'failed', 'no-target'] as const) {
      expect(readSshEndRemoteResult({ outcome })).toEqual({ outcome })
      // Stray details on an ordinary outcome are dropped, not passed on.
      expect(readSshEndRemoteResult({ outcome, container: NEEDS.container })).toEqual({ outcome })
    }
    expect(readSshEndRemoteResult(NEEDS)).toEqual(NEEDS)
    expect(readSshEndRemoteResult({ ...NEEDS, extra: 'x', container: { ...NEEDS.container, extra: 'y' } })).toEqual(NEEDS)
  })

  it('reads anything malformed in the outcome, engine or name as no result', () => {
    const bad: unknown[] = [
      undefined, null, 'completed', 42, [], {},
      { outcome: 'done' },
      { outcome: 'container-needs-sudo' },
      { outcome: 'container-needs-sudo', container: null },
      { outcome: 'container-needs-sudo', container: [] },
      { outcome: 'container-needs-sudo', container: { ...NEEDS.container, engine: 'nerdctl' } },
      { outcome: 'container-needs-sudo', container: { ...NEEDS.container, name: 'ccc test' } },
      { outcome: 'container-needs-sudo', container: { ...NEEDS.container, name: 'x;rm -rf /' } },
      { outcome: 'container-needs-sudo', container: { ...NEEDS.container, name: '-rm' } },
      { outcome: 'container-needs-sudo', container: { ...NEEDS.container, name: 7 } },
    ]
    for (const v of bad) expect(readSshEndRemoteResult(v), JSON.stringify(v)).toBeNull()
  })

  // The host never enters a command; it is only shown. A host the spawn schema
  // accepts but the notice cannot show as one plain token must not cost the
  // user the notice: the result keeps the engine and name and drops the host.
  it('keeps the result, without the host, when the host cannot be shown as one plain token', () => {
    const hosts: unknown[] = [
      `b${ch(0xfc)}cher.example`,         // a non-ASCII (IDN) name
      `${ch(0x4f8b, 0x3048)}.jp`,         // another script entirely
      `rocky${ch(0x200b)}.lan`,           // a zero-width character
      'x'.repeat(256),                    // longer than 255
      '',                                 // empty
      'a b',                              // a space
      '-oProxyCommand=x',                 // begins with a dash
      'h\nnext',                          // a line break
      42,                                 // not a string
      undefined,                          // missing
    ]
    for (const host of hosts) {
      const r = readSshEndRemoteResult({ outcome: 'container-needs-sudo', container: { engine: 'podman', name: 'ccc-test', host } })
      expect(r, JSON.stringify(host)).toEqual({ outcome: 'container-needs-sudo', container: { engine: 'podman', name: 'ccc-test' } })
      expect(Object.keys(r!.container!), JSON.stringify(host)).not.toContain('host')
    }
    // A plain host up to 255 characters is still shown.
    const long = 'h'.repeat(255)
    expect(readSshEndRemoteResult({ ...NEEDS, container: { ...NEEDS.container, host: long } })!.container!.host).toBe(long)
  })
})

describe('manualContainerStopCommand', () => {
  it('runs the End script in the container under sh -c, with a plain sudo, for the engine and container named', () => {
    expect(manualContainerStopCommand('lv24abc', 'podman', 'ccc-test')).toBe(
      `sudo podman exec ccc-test sh -c '${script('lv24abc')}'`,
    )
    expect(manualContainerStopCommand('s1', 'docker', 'web.app_1-x')).toBe(
      `sudo docker exec web.app_1-x sh -c '${script('s1')}'`,
    )
  })

  it('is built from the one shared script, which removes the files first and then execs the pkill', () => {
    const sid = 'lv24abc'
    expect(manualContainerStopCommand(sid, 'podman', 'ccc-test')).toBe(`sudo podman exec ccc-test sh -c '${containerSessionStopScript(sid)}'`)
    const s = containerSessionStopScript(sid)
    expect(s.indexOf('rm -f ')).toBe(0)
    expect(s.indexOf('; exec pkill -f ')).toBeGreaterThan(s.indexOf('ccc-status-'))
    expect(s).toContain(`"${containerSessionKillPattern(sid)}"`)
  })

  it('sanitises an odd session id exactly as the remote file names do', () => {
    const sid = `odd id'; rm -rf / #$(x)`
    expect(containerSessionKillPattern(sid)).toBe(String.raw`/settings-odd_id___rm_-rf______x_\.json`)
    const cmd = manualContainerStopCommand(sid, 'podman', 'ccc-test')!
    expect(cmd).toBe(`sudo podman exec ccc-test sh -c '${script('odd_id___rm_-rf______x_')}'`)
    // One single-quoted script, nothing after it: no quote, `;` or `$` from the id got through.
    expect(cmd.split("'")).toHaveLength(3)
    expect(cmd.endsWith("'")).toBe(true)
  })

  it('refuses an engine or container name that fails validation', () => {
    expect(manualContainerStopCommand('s1', 'nerdctl', 'ccc-test')).toBeNull()
    expect(manualContainerStopCommand('s1', 'podman', 'ccc test')).toBeNull()
    expect(manualContainerStopCommand('s1', 'podman', "c'; rm -rf /")).toBeNull()
    expect(manualContainerStopCommand('s1', 'podman', '')).toBeNull()
    expect(manualContainerStopCommand('s1', 'podman', 12)).toBeNull()
  })
})
