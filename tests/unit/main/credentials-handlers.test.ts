/**
 * The renderer's two doors into the credential store accept only keys of the
 * app's own shape (credential-key.ts): an id, or an id with one of the three
 * known suffixes. Anything else is refused before the store is touched. Driven
 * through the real handlers on a fake ipcMain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
}))
const saveCredential = vi.fn(() => true)
const deleteCredential = vi.fn(() => true)
vi.mock('../../../src/main/credential-store', () => ({ saveCredential, deleteCredential, loadCredential: vi.fn() }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { registerCredentialHandlers } = await import('../../../src/main/ipc/credentials-handlers')
const { isAllowedCredentialKey, CREDENTIAL_KEY_PATTERN } = await import('../../../src/main/credential-key')
registerCredentialHandlers()
const save = handlers.get('credentials:save')!
const del = handlers.get('credentials:delete')!

beforeEach(() => { saveCredential.mockClear(); deleteCredential.mockClear() })

describe('isAllowedCredentialKey', () => {
  it('accepts the four shapes the app writes', () => {
    for (const k of ['a1b2c3d4e5f6a1b2c3d4e5f6', 'cfg1', 'cfg1_sudo', 'cfg1_argsecret', 'aaa111_cmdsecret', 'k9ZmQ2_sudo']) expect(isAllowedCredentialKey(k), k).toBe(true)
  })
  it('refuses everything else: other suffixes, separators, paths, empty, oversized, non-strings', () => {
    for (const k of ['', 'cfg1_token', 'cfg1_', '_sudo', 'cfg-1', 'cfg 1', 'github:nubbymong', '../x', 'cfg1_sudo_sudo', 'a'.repeat(65), 'a'.repeat(65) + '_sudo', 'cfg1\n', 'cfg1_cmdsecret ']) expect(isAllowedCredentialKey(k), JSON.stringify(k)).toBe(false)
    for (const k of [undefined, null, 42, {}, ['cfg1']]) expect(isAllowedCredentialKey(k)).toBe(false)
    expect(CREDENTIAL_KEY_PATTERN.source).toContain('_cmdsecret')
  })
})

describe('credentials:save / credentials:delete', () => {
  it('saves and deletes well-formed keys', async () => {
    expect(await save({}, 'cfg1', 'pw')).toBe(true)
    expect(saveCredential).toHaveBeenCalledWith('cfg1', 'pw')
    expect(await save({}, 'cfg1_argsecret', 'tok')).toBe(true)
    expect(await del({}, 'aaa111_cmdsecret')).toBe(true)
    expect(deleteCredential).toHaveBeenCalledWith('aaa111_cmdsecret')
  })
  it('refuses a key outside the allowed shape without touching the store', async () => {
    expect(await save({}, 'github:token', 'pw')).toBe(false)
    expect(await save({}, 'cfg1_token', 'pw')).toBe(false)
    expect(await save({}, '../creds', 'pw')).toBe(false)
    expect(await del({}, 'cfg1; rm')).toBe(false)
    expect(await del({}, undefined)).toBe(false)
    expect(saveCredential).not.toHaveBeenCalled()
    expect(deleteCredential).not.toHaveBeenCalled()
  })
  it('refuses a non-string value', async () => {
    expect(await save({}, 'cfg1', { v: 'pw' })).toBe(false)
    expect(await save({}, 'cfg1', undefined)).toBe(false)
    expect(saveCredential).not.toHaveBeenCalled()
  })
})
