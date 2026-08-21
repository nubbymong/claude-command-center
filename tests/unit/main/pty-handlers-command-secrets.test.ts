/**
 * The pty:spawn handler is the ONLY place command secrets are allowed to enter
 * the spawn options, and it builds them from disk + keychain, never from what
 * the renderer sent. This drives the real handler (registered through a fake
 * ipcMain) rather than the schema, because the property lives in the handler's
 * body: the zod parse result is discarded and `options` is forwarded, so a field
 * the schema does not know would otherwise flow straight through.
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

let commandsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({ readConfig: (key: string) => (key === 'commands' ? commandsOnDisk : null) }))
const vault: Record<string, string> = {}
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => vault[k] ?? null }))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'

beforeEach(() => {
  spawnPty.mockClear()
  commandsOnDisk = null
  for (const k of Object.keys(vault)) delete vault[k]
})

describe('pty:spawn and command secrets', () => {
  it('STRIPS commandSecrets the renderer sent -- a renderer cannot name its own secrets', async () => {
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfg1', commandSecrets: { evil: 'x' } })
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnPty.mock.calls[0][2].commandSecrets).toBeUndefined()
  })

  it('rebuilds them from the commands file on disk and the keychain, for a SHELL spawn with a config', async () => {
    commandsOnDisk = [
      { id: 'aaa111', hasSecretArg: true, scope: 'global' },
      { id: 'bbb222', hasSecretArg: true, scope: 'config', configId: 'other' },
    ]
    vault['aaa111_cmdsecret'] = 'tok-a'
    vault['bbb222_cmdsecret'] = 'tok-b'
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfg1', commandSecrets: { aaa111: 'renderer-lie' } })
    // The renderer's value for aaa111 is ignored; the keychain's is used. The
    // other-config command is not visible here.
    expect(spawnPty.mock.calls[0][2].commandSecrets).toEqual({ aaa111: 'tok-a' })
  })

  it('gives a CLAUDE spawn none, even with secrets on disk', async () => {
    commandsOnDisk = [{ id: 'aaa111', hasSecretArg: true, scope: 'global' }]
    vault['aaa111_cmdsecret'] = 'tok-a'
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: false, configId: 'cfg1' })
    expect(spawnPty.mock.calls[0][2].commandSecrets).toBeUndefined()
  })

  it('gives a shell spawn with NO config none -- there is nothing to scope to', async () => {
    commandsOnDisk = [{ id: 'aaa111', hasSecretArg: true, scope: 'global' }]
    vault['aaa111_cmdsecret'] = 'tok-a'
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true })
    expect(spawnPty.mock.calls[0][2].commandSecrets).toBeUndefined()
  })
})
