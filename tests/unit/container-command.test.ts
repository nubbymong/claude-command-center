import { describe, it, expect } from 'vitest'
import { composeRuntimeCommand, composeContainerEntryCommand, buildEntryGuardCommand, parseEntrySentinels, entrySentinel, isProvableContainerEntry, parseDockerPostCommand } from '../../src/shared/container-command'

describe('composeRuntimeCommand (item e — the app builds the container command)', () => {
  it('returns undefined for host runtime and for no runtime', () => {
    expect(composeRuntimeCommand(undefined)).toBeUndefined()
    expect(composeRuntimeCommand({ type: 'host' })).toBeUndefined()
  })

  it('composes the default exec shape', () => {
    expect(composeRuntimeCommand({ type: 'container', container: 'ccc-test' }))
      .toBe('docker exec -it ccc-test bash')
  })

  it('composes sudo + podman + container directory', () => {
    expect(composeRuntimeCommand({ type: 'container', engine: 'podman', container: 'dev', sudo: true, containerDir: '/srv/app' }))
      .toBe('sudo podman exec -it -w /srv/app dev bash')
  })

  it('composes start mode attached', () => {
    expect(composeRuntimeCommand({ type: 'container', container: 'dev', mode: 'start', sudo: true }))
      .toBe('sudo docker start -ai dev')
  })

  it('rejects a missing name and unsafe values instead of writing a mangled command', () => {
    expect(() => composeRuntimeCommand({ type: 'container' })).toThrow(/no container name/)
    expect(() => composeRuntimeCommand({ type: 'container', container: 'a; rm -rf /' })).toThrow(/unsafe container name/)
    expect(() => composeRuntimeCommand({ type: 'container', container: '-flag' })).toThrow(/unsafe container name/)
    expect(() => composeRuntimeCommand({ type: 'container', container: 'ok', containerDir: '/srv;id' })).toThrow(/unsafe container directory/)
    expect(() => composeRuntimeCommand({ type: 'container', container: 'ok', containerDir: 'a b' })).toThrow(/unsafe container directory/)
  })

  // ADR-009: an unrecognised `type` used to fall through the `!== 'container'`
  // test and return undefined — i.e. a config whose Runtime block says
  // `'Container'` launched claude on the BARE HOST, silently, with no container
  // hop and no error. config:save does no schema validation, so a typo (or a
  // hand-edited / older-build config) reached this sink verbatim. It must fail
  // CLOSED, joining pty-manager's `runtimeInvalid` latch.
  // Mutation to prove this can fail: restore `if (!runtime || runtime.type !== 'container') return undefined`.
  it('a PRESENT runtime with an unrecognised type FAILS CLOSED instead of silently launching on the host', () => {
    for (const bad of ['Container', 'containr', 'CONTAINER', '', 'docker']) {
      expect(() => composeRuntimeCommand({ type: bad } as never)).toThrow(/unknown ssh runtime type/)
    }
    // The two known types keep their existing meaning.
    expect(composeRuntimeCommand(undefined)).toBeUndefined()
    expect(composeRuntimeCommand({ type: 'host' })).toBeUndefined()
  })

  // ADR-009: `container` is typed `string | undefined` but arrives from a JSON
  // config and, on the no-configId spawn branch, straight off the IPC request.
  // `(runtime.container ?? '').trim()` threw a TypeError on a number or an
  // array; a non-string must read as "no name", which the existing gate rejects.
  it('a NON-STRING container name is rejected as a missing name, never a TypeError', () => {
    for (const bad of [42, ['ccc-test'], { name: 'ccc-test' }, true]) {
      expect(() => composeRuntimeCommand({ type: 'container', container: bad } as never)).toThrow(/no container name/)
    }
  })
})

describe('parseDockerPostCommand (one-click convert affordance)', () => {
  it('parses the classic shapes', () => {
    expect(parseDockerPostCommand('sudo docker exec -it claude-dev bash')).toEqual({
      type: 'container', engine: 'docker', container: 'claude-dev', mode: 'exec', sudo: true,
    })
    // rc.15 review R1: the shell is preserved (a sh-only container must not be
    // handed bash when the line is re-composed with the entry sentinel).
    expect(parseDockerPostCommand('podman exec -it dev sh')).toEqual({
      type: 'container', engine: 'podman', container: 'dev', mode: 'exec', sudo: false, shell: 'sh',
    })
    expect(parseDockerPostCommand('docker exec -it dev /bin/sh')?.shell).toBe('sh')
    expect(parseDockerPostCommand('docker exec -it dev /bin/bash')?.shell).toBeUndefined()
  })

  // rc.15 review R1 (Codex plan review 4-B): `sudo docker exec -it -w /work
  // review sh` used to miss the parse, so the session was classed as a plain
  // host and got no entry watch at all.
  it('parses -w <dir> in either position and split -i -t flags', () => {
    expect(parseDockerPostCommand('sudo docker exec -it -w /work review sh')).toEqual({
      type: 'container', engine: 'docker', container: 'review', mode: 'exec', sudo: true, containerDir: '/work', shell: 'sh',
    })
    expect(parseDockerPostCommand('docker exec -w ~/proj -ti dev bash')).toEqual({
      type: 'container', engine: 'docker', container: 'dev', mode: 'exec', sudo: false, containerDir: '~/proj',
    })
    expect(parseDockerPostCommand('docker exec -i -t dev bash')).toMatchObject({ container: 'dev' })
    expect(parseDockerPostCommand('docker exec -t -i dev bash')).toMatchObject({ container: 'dev' })
    // Both -i and -t are required (an exec without a TTY is not an interactive entry); two -w flags are not a shape we compose.
    expect(parseDockerPostCommand('docker exec -i dev bash')).toBeNull()
    expect(parseDockerPostCommand('docker exec -t dev bash')).toBeNull()
    expect(parseDockerPostCommand('docker exec -it -w /a -w /b dev bash')).toBeNull()
    expect(parseDockerPostCommand('docker exec -it -w "/a b" dev bash')).toBeNull()
  })

  it('refuses anything with extra flags, chained commands, or unknown shells', () => {
    expect(parseDockerPostCommand('docker exec -it dev bash && echo hi')).toBeNull()
    expect(parseDockerPostCommand('docker exec -it --privileged dev bash')).toBeNull()
    expect(parseDockerPostCommand('docker exec -it dev zsh -l')).toBeNull()
    expect(parseDockerPostCommand('cd /srv && ls')).toBeNull()
    expect(parseDockerPostCommand('')).toBeNull()
  })
})

// rc.15 review R1 (aicc_planning#45): the ENTRY command the SSH flow types. A
// process inside the named container prints `__CCC_<nonce>_IN__` before the
// shell starts and `__CCC_<nonce>_OUT__` after it exits; the interactive shell
// inherits CCC_ENTRY=<nonce> for the launch-time guard.
describe('composeContainerEntryCommand / the entry sentinels (rc.15 review R1)', () => {
  const NONCE = '0123456789abcdef01234567'

  it('wraps the exec shape: sh -c outer (no startup files before IN), the configured shell as a CHILD, OUT after it', () => {
    expect(composeContainerEntryCommand({ type: 'container', container: 'ccc-test' }, NONCE)).toBe(
      `docker exec -it ccc-test sh -c 'printf "__CCC_%s_%s__\\n" ${NONCE} IN; CCC_ENTRY=${NONCE} bash; printf "__CCC_%s_%s__\\n" ${NONCE} OUT'`,
    )
    expect(composeContainerEntryCommand({ type: 'container', engine: 'podman', container: 'dev', sudo: true, containerDir: '/srv/app', shell: 'sh' }, NONCE)).toBe(
      `sudo podman exec -it -w /srv/app dev sh -c 'printf "__CCC_%s_%s__\\n" ${NONCE} IN; CCC_ENTRY=${NONCE} sh; printf "__CCC_%s_%s__\\n" ${NONCE} OUT'`,
    )
  })

  it('the typed line never contains a JOINED sentinel (the echo cannot forge one)', () => {
    const cmd = composeContainerEntryCommand({ type: 'container', container: 'ccc-test' }, NONCE)!
    for (const word of ['IN', 'OUT', 'HERE'] as const) expect(cmd).not.toContain(entrySentinel(NONCE, word))
    expect(parseEntrySentinels(cmd + '\r\n', NONCE)).toEqual([])
    expect(parseEntrySentinels(buildEntryGuardCommand() + '\r\n', NONCE)).toEqual([])
  })

  it('start mode has no sentinel (it cannot be proven) and host/no runtime compose nothing', () => {
    expect(composeContainerEntryCommand({ type: 'container', container: 'dev', mode: 'start', sudo: true }, NONCE)).toBe('sudo docker start -ai dev')
    expect(composeContainerEntryCommand({ type: 'host' }, NONCE)).toBeUndefined()
    expect(composeContainerEntryCommand(undefined, NONCE)).toBeUndefined()
    expect(isProvableContainerEntry({ type: 'container', container: 'dev' })).toBe(true)
    expect(isProvableContainerEntry({ type: 'container', container: 'dev', mode: 'start' })).toBe(false)
    expect(isProvableContainerEntry({ type: 'host' })).toBe(false)
    expect(isProvableContainerEntry(undefined)).toBe(false)
  })

  it('refuses a nonce that is not plain hex (it is interpolated into a shell line) and the same unsafe names/dirs as the plain composer', () => {
    for (const bad of ["abc'; rm -rf /; echo '", 'ABCDEF0123456789ABCDEF01', 'short', '', 'a b c d e f g h']) {
      expect(() => composeContainerEntryCommand({ type: 'container', container: 'ccc-test' }, bad)).toThrow(/unsafe container entry nonce/)
    }
    expect(() => composeContainerEntryCommand({ type: 'container', container: 'a; rm -rf /' }, NONCE)).toThrow(/unsafe container name/)
    expect(() => composeContainerEntryCommand({ type: 'container', container: 'ok', containerDir: '/srv;id' }, NONCE)).toThrow(/unsafe container directory/)
    expect(() => composeContainerEntryCommand({ type: 'Container' } as never, NONCE)).toThrow(/unknown ssh runtime type/)
  })

  it('the guard reads CCC_ENTRY back through the shell, POSIX/fish-compatible, with the joined token only ever produced by expansion', () => {
    expect(buildEntryGuardCommand()).toBe(`printf '__CCC_%s_%s__\\n' "$CCC_ENTRY" HERE`)
  })

  it('parseEntrySentinels: this nonce only, terminator required, in order', () => {
    expect(parseEntrySentinels(`__CCC_${NONCE}_IN__\r\nroot@c:/# `, NONCE)).toEqual(['IN'])
    expect(parseEntrySentinels(`__CCC_${NONCE}_IN__\n__CCC_${NONCE}_OUT__\r\n`, NONCE)).toEqual(['IN', 'OUT'])
    expect(parseEntrySentinels(`__CCC_${NONCE}_HERE__\r\n`, NONCE)).toEqual(['HERE'])
    // an unterminated token is not a sentinel yet (chunk boundary)
    expect(parseEntrySentinels(`__CCC_${NONCE}_IN__`, NONCE)).toEqual([])
    expect(parseEntrySentinels(`__CCC_${NONCE}_IN_`, NONCE)).toEqual([])
    // a different nonce, no nonce, an empty host expansion, an unknown word: nothing
    expect(parseEntrySentinels('__CCC_ffffffffffffffffffffffff_IN__\r\n', NONCE)).toEqual([])
    expect(parseEntrySentinels('__CCC_IN__\r\n__CCC__HERE__\r\n', NONCE)).toEqual([])
    expect(parseEntrySentinels(`__CCC_${NONCE}_MAYBE__\r\n`, NONCE)).toEqual([])
    // a nonce that is not hex never matches anything (and never builds a regex from arbitrary text)
    expect(parseEntrySentinels('__CCC_.*_IN__\r\n', '.*')).toEqual([])
  })
})
