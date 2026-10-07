/**
 * The renderer's two doors into the credential store accept only keys of the
 * app's own shape (credential-key.ts): an id, or an id with one of the three
 * known suffixes. Anything else is refused before the store is touched. Driven
 * through the real handlers on a fake ipcMain. A delete for an id string the
 * save door refuses is skipped without a warning when the store holds nothing
 * under it, and warned about when it does (PR 4 review C-Q3: an entry stored
 * before the shape rule existed stays stored, and the log is its only trace).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
}))
const saveCredential = vi.fn(() => true)
const deleteCredential = vi.fn(() => true)
/** The store as read, read-only (null: the file is there and could not be read). */
const readCredentialsFile = vi.fn((): Record<string, string> | null => ({}))
const logWarn = vi.fn()
vi.mock('../../../src/main/credential-store', () => ({ saveCredential, deleteCredential, readCredentialsFile, loadCredential: vi.fn() }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn, logError: vi.fn() }))

const { registerCredentialHandlers } = await import('../../../src/main/ipc/credentials-handlers')
const { isAllowedCredentialKey, CREDENTIAL_KEY_PATTERN } = await import('../../../src/main/credential-key')
registerCredentialHandlers()
const save = handlers.get('credentials:save')!
const del = handlers.get('credentials:delete')!

beforeEach(() => {
  saveCredential.mockClear(); deleteCredential.mockClear(); deleteCredential.mockImplementation(() => true); logWarn.mockClear()
  readCredentialsFile.mockClear(); readCredentialsFile.mockImplementation(() => ({}))
})

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

// [host] The owner's 2026-10-04 answer: a delete for an id that cannot hold a
// stored credential is skipped quietly. "Cannot hold one" is the save door's
// own rule (in this build credentials:save is the only door that adds an
// entry, and it takes only keys isAllowedCredentialKey accepts), so the two
// doors must agree on every key. A refusal that still means something keeps
// its warning, including an entry an older build stored under an id outside
// that rule (PR 4 review C-Q3).
describe('credentials:delete for ids that cannot hold a stored credential', () => {
  const warned = () => logWarn.mock.calls.map((c) => String(c[0]))

  it('[host] skips an id string the save door never accepts, without a warning, when the store holds nothing under it', async () => {
    // Ids from outside the app (imported or seeded configs), with the suffixes
    // the edit-save deletes for, and anything else outside the shape.
    for (const k of ['cfg-ssh-1', 'cfg-ssh-1_sudo', 'cfg-ssh-1_argsecret', 'cfg 1', 'cfg1_token', '', 'a'.repeat(65), 'cfg1; rm']) {
      expect(await del({}, k), JSON.stringify(k)).toBe(false)
    }
    expect(deleteCredential).not.toHaveBeenCalled()
    expect(warned()).toEqual([])
  })

  // PR 4 review C-Q3: a store from a build older than the shape rule can hold
  // an entry under an id outside it (an imported config's own id). Such an
  // entry cannot be deleted through this door, so a delete for it is warned
  // about; the store is only read, never written.
  it('[host] an id outside the shape that the store does hold is refused with a warning, and the store is only read', async () => {
    readCredentialsFile.mockImplementation(() => ({ 'cfg-ssh-1_sudo': 'c2VjcmV0', cfg1: 'b3RoZXI=' }))
    expect(await del({}, 'cfg-ssh-1_sudo')).toBe(false)
    expect(warned()).toEqual(['[credentials] delete refused: a credential is stored under an id of an older shape, which the renderer cannot delete'])
    expect(deleteCredential).not.toHaveBeenCalled()
    expect(saveCredential).not.toHaveBeenCalled()
    // One the store does not hold stays quiet.
    logWarn.mockClear()
    expect(await del({}, 'cfg-ssh-2_sudo')).toBe(false)
    expect(warned()).toEqual([])
  })

  it('[host] an id outside the shape is quiet only when the store can be read and holds nothing under it', async () => {
    // A store that cannot be read cannot say it holds nothing.
    readCredentialsFile.mockImplementation(() => null)
    expect(await del({}, 'cfg-ssh-1')).toBe(false)
    expect(warned()).toEqual(['[credentials] delete refused: key outside the expected shape, and the credential store could not be read to check it'])
    // Only the store's own entries count, never what every object inherits.
    readCredentialsFile.mockImplementation(() => ({}))
    logWarn.mockClear()
    for (const k of ['__proto__', '__defineGetter__', '__lookupSetter__']) expect(await del({}, k), k).toBe(false)
    expect(warned()).toEqual([])
    expect(deleteCredential).not.toHaveBeenCalled()
  })

  it('[host] a request whose key is not a string at all is still refused with a warning', async () => {
    for (const k of [undefined, null, 42, {}, ['cfg1']]) {
      logWarn.mockClear()
      expect(await del({}, k)).toBe(false)
      expect(warned(), JSON.stringify(k)).toEqual(['[credentials] delete refused: key not of the expected shape'])
    }
    expect(deleteCredential).not.toHaveBeenCalled()
    expect(readCredentialsFile).not.toHaveBeenCalled()
  })

  it('[host] a store that cannot delete a key that could hold a credential says so', async () => {
    deleteCredential.mockImplementation(() => false)
    expect(await del({}, 'cfg1_sudo')).toBe(false)
    expect(deleteCredential).toHaveBeenCalledWith('cfg1_sudo')
    expect(warned()).toEqual(['[credentials] delete refused: the credential store could not be read or written'])
    // A delete the store carries out is not logged.
    deleteCredential.mockImplementation(() => true)
    logWarn.mockClear()
    expect(await del({}, 'cfg1_sudo')).toBe(true)
    expect(warned()).toEqual([])
  })

  it('[host] the delete door skips exactly the keys the save door refuses: one rule for both', async () => {
    const keys = ['cfg1', 'a1b2c3d4e5f6a1b2c3d4e5f6', 'cfg1_sudo', 'cfg1_argsecret', 'aaa111_cmdsecret', 'k9ZmQ2_sudo', 'a'.repeat(64),
      'cfg-1', 'cfg_1', 'cfg-ssh-1_sudo', 'cfg1_', '_sudo', 'cfg1_sudo_sudo', 'a'.repeat(65), 'cfg1\n', 'cfg.1', 'cfg1_cmdsecret ']
    for (const k of keys) {
      saveCredential.mockClear()
      deleteCredential.mockClear()
      await save({}, k, 'pw')
      await del({}, k)
      expect(deleteCredential.mock.calls.length, JSON.stringify(k)).toBe(saveCredential.mock.calls.length)
      expect(deleteCredential.mock.calls.length, JSON.stringify(k)).toBe(isAllowedCredentialKey(k) ? 1 : 0)
    }
  })
})
