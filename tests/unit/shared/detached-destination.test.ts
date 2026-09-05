/**
 * SSH Persistent — the ONE destination rule renderer and main both apply (#54).
 *
 * A detached entry records where a session was left (host, user, port, path,
 * runtime); a saved config says where it points NOW. Agreement is what lets the
 * config offer a reattach, probe liveness, or end the remote. Everything else
 * (an edited host, another port, a different container) is an orphan of the edit.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SSH_PORT,
  normalizeSshPort,
  effectiveRuntimeOf,
  runtimeIdentityKey,
  detachedDestinationAgrees,
  describeDestination,
} from '../../../src/shared/detached-destination'

const recorded = (over: Record<string, unknown> = {}) => ({
  host: 'pi.local', username: 'mong', remotePath: '~/work', port: 22, runtime: { type: 'host' as const }, ...over,
}) as Parameters<typeof detachedDestinationAgrees>[0]

const ssh = (over: Record<string, unknown> = {}) => ({
  host: 'pi.local', username: 'mong', remotePath: '~/work', port: 22, ...over,
}) as Parameters<typeof detachedDestinationAgrees>[1]

describe('normalizeSshPort', () => {
  it('reads a number or a numeric string, and defaults everything else to 22', () => {
    expect(normalizeSshPort(2222)).toBe(2222)
    expect(normalizeSshPort('2222')).toBe(2222)
    expect(normalizeSshPort(' 22 ')).toBe(22)
    expect(normalizeSshPort(undefined)).toBe(DEFAULT_SSH_PORT)
    expect(normalizeSshPort(null)).toBe(DEFAULT_SSH_PORT)
    expect(normalizeSshPort(0)).toBe(DEFAULT_SSH_PORT)
    expect(normalizeSshPort(70000)).toBe(DEFAULT_SSH_PORT)
    expect(normalizeSshPort('abc')).toBe(DEFAULT_SSH_PORT)
    expect(normalizeSshPort(22.5)).toBe(DEFAULT_SSH_PORT)
  })
})

describe('effectiveRuntimeOf', () => {
  it('prefers the structured block, then a legacy docker post-command, then the host', () => {
    const structured = { type: 'container' as const, container: 'dev' }
    expect(effectiveRuntimeOf({ runtime: structured, postCommand: 'docker exec -it other bash' })).toBe(structured)
    expect(effectiveRuntimeOf({ postCommand: 'sudo docker exec -it web bash' })).toMatchObject({ type: 'container', container: 'web' })
    expect(effectiveRuntimeOf({ postCommand: 'cd /srv && ls' })).toEqual({ type: 'host' })
    expect(effectiveRuntimeOf({})).toEqual({ type: 'host' })
    expect(effectiveRuntimeOf(undefined)).toEqual({ type: 'host' })
  })
})

describe('runtimeIdentityKey', () => {
  it('is the host for no runtime, a host runtime, or an unknown type', () => {
    expect(runtimeIdentityKey(undefined)).toBe('host')
    expect(runtimeIdentityKey({ type: 'host' })).toBe('host')
    expect(runtimeIdentityKey({ type: 'vm' } as never)).toBe('host')
  })

  it('names the engine and container, defaulting the engine to docker and trimming the name', () => {
    expect(runtimeIdentityKey({ type: 'container', container: 'dev' })).toBe('container:docker:dev')
    expect(runtimeIdentityKey({ type: 'container', engine: 'podman', container: ' dev ' })).toBe('container:podman:dev')
  })

  it('ignores how you get in (sudo, mode, containerDir) — they do not move the session', () => {
    const a = runtimeIdentityKey({ type: 'container', container: 'dev' })
    const b = runtimeIdentityKey({ type: 'container', container: 'dev', sudo: true, mode: 'start', containerDir: '/app' })
    expect(a).toBe(b)
  })
})

describe('detachedDestinationAgrees', () => {
  it('agrees with an unchanged config', () => {
    expect(detachedDestinationAgrees(recorded(), ssh())).toBe(true)
  })

  it('disagrees on a host, user, path, port or runtime edit', () => {
    expect(detachedDestinationAgrees(recorded(), ssh({ host: 'other.box' }))).toBe(false)
    expect(detachedDestinationAgrees(recorded(), ssh({ username: 'root' }))).toBe(false)
    expect(detachedDestinationAgrees(recorded(), ssh({ remotePath: '/srv' }))).toBe(false)
    expect(detachedDestinationAgrees(recorded(), ssh({ port: 2222 }))).toBe(false)
    expect(detachedDestinationAgrees(recorded(), ssh({ runtime: { type: 'container', container: 'dev' } }))).toBe(false)
    expect(detachedDestinationAgrees(recorded(), ssh({ postCommand: 'docker exec -it dev bash' }))).toBe(false)
  })

  it('a container entry agrees only with the same container, however it is entered', () => {
    const inDev = recorded({ runtime: { type: 'container', container: 'dev' } })
    expect(detachedDestinationAgrees(inDev, ssh({ runtime: { type: 'container', container: 'dev', sudo: true } }))).toBe(true)
    expect(detachedDestinationAgrees(inDev, ssh({ postCommand: 'docker exec -it dev bash' }))).toBe(true)
    expect(detachedDestinationAgrees(inDev, ssh({ runtime: { type: 'container', container: 'other' } }))).toBe(false)
    expect(detachedDestinationAgrees(inDev, ssh({ runtime: { type: 'container', engine: 'podman', container: 'dev' } }))).toBe(false)
    expect(detachedDestinationAgrees(inDev, ssh())).toBe(false) // back on the host
  })

  it('hosts compare case-insensitively and trimmed; a string port equals its number', () => {
    expect(detachedDestinationAgrees(recorded(), ssh({ host: 'Pi.LOCAL ' }))).toBe(true)
    expect(detachedDestinationAgrees(recorded({ port: 2222 }), ssh({ port: '2222' }))).toBe(true)
  })

  it('a PRE-#54 entry (no port, no runtime) is checked on host/user/path only', () => {
    const legacy = recorded({ port: undefined, runtime: undefined })
    expect(detachedDestinationAgrees(legacy, ssh({ port: 2222, runtime: { type: 'container', container: 'x' } }))).toBe(true)
    expect(detachedDestinationAgrees(legacy, ssh({ host: 'other.box' }))).toBe(false)
  })

  it('never agrees with a missing ssh block', () => {
    expect(detachedDestinationAgrees(recorded(), undefined)).toBe(false)
    expect(detachedDestinationAgrees(recorded(), null)).toBe(false)
  })

  it('an empty or non-string host on either side never agrees, even with the other (fails closed, no throw)', () => {
    expect(detachedDestinationAgrees(recorded({ host: '' }), ssh({ host: '' }))).toBe(false)
    expect(detachedDestinationAgrees(recorded({ host: '   ' }), ssh({ host: '' }))).toBe(false)
    expect(detachedDestinationAgrees(recorded({ host: 42 }), ssh({ host: 42 }))).toBe(false)
    expect(detachedDestinationAgrees(recorded({ host: undefined }), ssh({ host: undefined }))).toBe(false)
    expect(detachedDestinationAgrees(recorded({ host: undefined }), ssh())).toBe(false)
    expect(detachedDestinationAgrees(recorded(), ssh({ host: undefined }))).toBe(false)
  })
})

describe('describeDestination', () => {
  it('reads user@host, shows a non-default port, and names a container', () => {
    expect(describeDestination({ host: 'pi.local', username: 'mong' })).toBe('mong@pi.local')
    expect(describeDestination({ host: 'pi.local', username: 'mong', port: 22 })).toBe('mong@pi.local')
    expect(describeDestination({ host: 'pi.local', username: 'mong', port: 2222 })).toBe('mong@pi.local:2222')
    expect(describeDestination({ host: 'pi.local', username: 'mong', runtime: { type: 'container', container: 'dev' } })).toBe('mong@pi.local (container dev)')
    expect(describeDestination({ host: 'pi.local', username: 'mong', runtime: { type: 'container' } })).toBe('mong@pi.local (container)')
    expect(describeDestination({ host: 'pi.local', username: 'mong', runtime: { type: 'host' } })).toBe('mong@pi.local')
  })
})
