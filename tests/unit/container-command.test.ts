import { describe, it, expect } from 'vitest'
import { composeRuntimeCommand, parseDockerPostCommand } from '../../src/shared/container-command'

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
})

describe('parseDockerPostCommand (one-click convert affordance)', () => {
  it('parses the classic shapes', () => {
    expect(parseDockerPostCommand('sudo docker exec -it claude-dev bash')).toEqual({
      type: 'container', engine: 'docker', container: 'claude-dev', mode: 'exec', sudo: true,
    })
    expect(parseDockerPostCommand('podman exec -it dev sh')).toEqual({
      type: 'container', engine: 'podman', container: 'dev', mode: 'exec', sudo: false,
    })
  })

  it('refuses anything with extra flags, chained commands, or unknown shells', () => {
    expect(parseDockerPostCommand('docker exec -it dev bash && echo hi')).toBeNull()
    expect(parseDockerPostCommand('docker exec -it --privileged dev bash')).toBeNull()
    expect(parseDockerPostCommand('docker exec -it dev zsh -l')).toBeNull()
    expect(parseDockerPostCommand('cd /srv && ls')).toBeNull()
    expect(parseDockerPostCommand('')).toBeNull()
  })
})
