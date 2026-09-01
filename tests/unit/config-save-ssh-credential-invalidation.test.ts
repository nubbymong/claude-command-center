import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * config:save credential-safety guard (private advisory, fixed in-PR).
 *
 * A saved SSH config's credentials live in the OS keychain keyed by the config's
 * ID (`<id>` = SSH password, `<id>_sudo` = sudo password) and are NOT pinned to
 * the config's host. Before this fix `config:save` validated only the KEY, so a
 * compromised renderer could rewrite a saved config's `sshConfig.host` (or
 * username/port) while keeping its id — leaving the stored password bound, by id,
 * to an attacker host that the next connect would dial and authenticate to.
 *
 * Part 1 (load-bearing): a config:save that changes an SSH config's
 * host/username/port drops that config's connection-bound credentials in the
 * same save. Part 2 (defence in depth): a `configs` value that is not a
 * well-formed config array is rejected before it reaches disk.
 */

const h = vi.hoisted(() => ({
  resourcesDir: '',
  handlers: {} as Record<string, (e: unknown, ...args: unknown[]) => unknown>,
  warns: [] as string[],
  deleted: [] as string[],
  // deleteCredential's return: true = dropped (or was never there). Flip to false
  // to exercise the fail-closed path.
  deleteReturns: true,
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { h.handlers[channel] = fn },
  },
}))
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: (m: string) => { h.warns.push(m) },
}))
vi.mock('../../src/main/tokenomics/tokenomics-service', () => ({
  refreshTokenomicsConfigs: () => {},
}))
// Spy on the credential store so a drop is observable without touching a real
// keychain. deleteCredential is the ONLY credential-store symbol config-handlers
// imports.
vi.mock('../../src/main/credential-store', () => ({
  deleteCredential: (key: string) => { h.deleted.push(key); return h.deleteReturns },
}))

import { saveConfig, readConfig, getConfigDir } from '../../src/main/config-manager'
import { registerConfigHandlers } from '../../src/main/ipc/config-handlers'
import { sshCredentialKeysToInvalidate, isValidConfigsPayload } from '../../src/main/config-save-guard'

// Alphanumeric ids, the real credential-key charset.
const sshCfg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: 'A config',
  workingDirectory: '/work',
  color: '#ffffff',
  sessionType: 'ssh' as const,
  provider: 'claude' as const,
  sshConfig: { host: 'goodhost', port: 22, username: 'me', remotePath: '~/proj', ...over },
})
const localCfg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: 'A local config',
  workingDirectory: '/work',
  color: '#ffffff',
  sessionType: 'local' as const,
  provider: 'claude' as const,
  ...over,
})

let tmp = ''
let configsPath = ''

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cfg-cred-invalidate-'))
  h.resourcesDir = tmp
})

beforeEach(() => {
  h.handlers = {}
  h.warns = []
  h.deleted = []
  h.deleteReturns = true
  mkdirSync(join(tmp, 'CONFIG'), { recursive: true })
  configsPath = join(getConfigDir(), 'configs.json')
  // Fresh per test: the resources dir is shared for the whole file (config-manager
  // caches the CONFIG path), so a configs.json left by a prior test would become
  // the next test's `prev`.
  rmSync(configsPath, { force: true })
  registerConfigHandlers()
})

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
})

async function save(key: string, data: unknown): Promise<boolean> {
  return (await h.handlers['config:save']({}, key, data)) as boolean
}

describe('Part 1 — a changed SSH connection identity drops the credential (through the IPC handler)', () => {
  it('drops <id> and <id>_sudo when the host changes', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    h.deleted = []
    expect(await save('configs', [sshCfg('cfgAAAA', { host: 'evilhost' })])).toBe(true)
    expect(h.deleted).toEqual(['cfgAAAA', 'cfgAAAA_sudo'])
    // The rewrite is only persisted once the credential is gone.
    expect((readConfig('configs') as Array<{ sshConfig: { host: string } }>)[0].sshConfig.host).toBe('evilhost')
  })

  it('drops <id> and <id>_sudo when the username changes', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    h.deleted = []
    expect(await save('configs', [sshCfg('cfgAAAA', { username: 'attacker' })])).toBe(true)
    expect(h.deleted).toEqual(['cfgAAAA', 'cfgAAAA_sudo'])
  })

  it('drops <id> and <id>_sudo when the port changes', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    h.deleted = []
    expect(await save('configs', [sshCfg('cfgAAAA', { port: 2222 })])).toBe(true)
    expect(h.deleted).toEqual(['cfgAAAA', 'cfgAAAA_sudo'])
  })

  it('keeps the credential when the SSH identity is unchanged (a non-identity edit)', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    h.deleted = []
    // Rename + move the remote path, but keep host/username/port.
    expect(await save('configs', [sshCfg('cfgAAAA', { label: 'renamed', remotePath: '~/elsewhere' })])).toBe(true)
    expect(h.deleted).toEqual([])
  })

  it('keeps the credential when only the port TYPE differs (22 vs "22")', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA', { port: 22 })])
    h.deleted = []
    expect(await save('configs', [sshCfg('cfgAAAA', { port: '22' })])).toBe(true)
    expect(h.deleted).toEqual([])
  })

  it('drops nothing for a brand-new config (no previous entry with that id)', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    h.deleted = []
    // cfgAAAA unchanged; cfgBBBB is new with a different host.
    expect(await save('configs', [sshCfg('cfgAAAA'), sshCfg('cfgBBBB', { host: 'anotherhost' })])).toBe(true)
    expect(h.deleted).toEqual([])
  })

  it('drops nothing when a non-SSH config is edited', async () => {
    saveConfig('configs', [localCfg('cfgLOCAL')])
    h.deleted = []
    expect(await save('configs', [localCfg('cfgLOCAL', { workingDirectory: '/new/dir' })])).toBe(true)
    expect(h.deleted).toEqual([])
  })

  it('fails closed: refuses the save (and does not persist) when a credential drop fails', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    const before = readFileSync(configsPath, 'utf-8')
    h.deleted = []
    h.deleteReturns = false // keychain unreadable/locked
    expect(await save('configs', [sshCfg('cfgAAAA', { host: 'evilhost' })])).toBe(false)
    // It attempted the drop, but the old config is left intact on disk.
    expect(h.deleted.length).toBeGreaterThan(0)
    expect(readFileSync(configsPath, 'utf-8')).toBe(before)
    expect(h.warns.some((w) => w.includes('could not invalidate'))).toBe(true)
  })
})

describe('Part 2 — the configs payload is shape-validated (defence in depth)', () => {
  it('rejects a non-array value and does not write it', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    const before = readFileSync(configsPath, 'utf-8')
    expect(await save('configs', { not: 'an array' })).toBe(false)
    expect(readFileSync(configsPath, 'utf-8')).toBe(before)
    expect(h.deleted).toEqual([])
    expect(h.warns.some((w) => w.includes('not a well-formed config array'))).toBe(true)
  })

  it('rejects an array that contains a non-object item', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    const before = readFileSync(configsPath, 'utf-8')
    expect(await save('configs', [sshCfg('cfgAAAA'), 42])).toBe(false)
    expect(readFileSync(configsPath, 'utf-8')).toBe(before)
  })

  it('rejects an item without a string id', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    const before = readFileSync(configsPath, 'utf-8')
    expect(await save('configs', [{ label: 'no id here' }])).toBe(false)
    expect(readFileSync(configsPath, 'utf-8')).toBe(before)
  })

  it('rejects an oversized array (> 1000)', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    const before = readFileSync(configsPath, 'utf-8')
    const huge = Array.from({ length: 1001 }, (_, i) => ({ id: 'c' + i }))
    expect(await save('configs', huge)).toBe(false)
    expect(readFileSync(configsPath, 'utf-8')).toBe(before)
  })

  it('rejects an item whose sshConfig is not an object', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA')])
    const before = readFileSync(configsPath, 'utf-8')
    expect(await save('configs', [{ id: 'cfgAAAA', sshConfig: 'not-an-object' }])).toBe(false)
    expect(readFileSync(configsPath, 'utf-8')).toBe(before)
  })

  it('accepts a well-formed configs array (including an empty one)', async () => {
    expect(await save('configs', [])).toBe(true)
    expect(readConfig('configs')).toEqual([])
    expect(await save('configs', [sshCfg('cfgAAAA'), localCfg('cfgLOCAL')])).toBe(true)
    expect((readConfig('configs') as unknown[]).length).toBe(2)
  })
})

describe('closing the two config:save bypasses (independent review)', () => {
  it('Bypass A — a duplicate-id payload is rejected by Part 2 and never written', async () => {
    saveConfig('configs', [sshCfg('cfgAAAA', { host: 'goodhost' })])
    const before = readFileSync(configsPath, 'utf-8')
    // EVIL first (the entry findSavedConfig would connect with), the original
    // GOOD last (what a last-entry comparison would read as unchanged).
    const dup = [sshCfg('cfgAAAA', { host: 'evilhost' }), sshCfg('cfgAAAA', { host: 'goodhost' })]
    expect(await save('configs', dup)).toBe(false)
    // saveConfig NOT called: the malicious duplicate never reaches disk.
    expect(readFileSync(configsPath, 'utf-8')).toBe(before)
    expect(h.deleted).toEqual([])
    expect(h.warns.some((w) => w.includes('not a well-formed config array'))).toBe(true)
  })

  it('Bypass B — deleting an SSH config drops its credential on the DELETE save, so a re-add of the id cannot reuse it', async () => {
    // Prev: an SSH config that has a stored password (by id).
    saveConfig('configs', [sshCfg('cfgAAAA', { host: 'goodhost' })])
    // Save 1 — remove it. The disappearance drops the connection-bound slots.
    h.deleted = []
    expect(await save('configs', [])).toBe(true)
    expect(h.deleted).toEqual(['cfgAAAA', 'cfgAAAA_sudo'])
    // Save 2 — re-add the SAME id pointed at an attacker host. Prev on disk is now
    // empty so there is nothing new to drop, and — the point — the slot is already
    // gone, so the re-added config has no password to send anywhere.
    h.deleted = []
    expect(await save('configs', [sshCfg('cfgAAAA', { host: 'evilhost' })])).toBe(true)
    expect(h.deleted).toEqual([])
  })
})

describe('the other renderer keys are unaffected by the configs-only guards', () => {
  it('saves commands/settings unchanged, even a shape the configs schema would reject', async () => {
    expect(await save('commands', [{ id: 'c1', label: 'y' }])).toBe(true)
    expect(readConfig('commands')).toEqual([{ id: 'c1', label: 'y' }])
    expect(await save('settings', { theme: 'dark' })).toBe(true)
    expect(readConfig('settings')).toEqual({ theme: 'dark' })
    // A non-array value under 'commands' is NOT rejected — Part 2 is configs-only.
    expect(await save('commands', { not: 'an array' })).toBe(true)
    expect(h.deleted).toEqual([])
  })
})

describe('sshCredentialKeysToInvalidate — pure function edge cases', () => {
  it('returns [] when either side is not an array (missing/garbled configs.json)', () => {
    expect(sshCredentialKeysToInvalidate(null, [sshCfg('a')])).toEqual([])
    expect(sshCredentialKeysToInvalidate([sshCfg('a')], null)).toEqual([])
    expect(sshCredentialKeysToInvalidate('nope', 'nope')).toEqual([])
  })

  it('drops when a config stops being SSH (host it was bound to is gone)', () => {
    const keys = sshCredentialKeysToInvalidate([sshCfg('aaaa')], [localCfg('aaaa')])
    expect(keys).toEqual(['aaaa', 'aaaa_sudo'])
  })

  it('drops a deleted SSH config so its orphaned keychain slots cannot be reused', () => {
    expect(sshCredentialKeysToInvalidate([sshCfg('aaaa')], [])).toEqual(['aaaa', 'aaaa_sudo'])
  })

  it('does not drop a deleted NON-SSH config (nothing was connection-bound)', () => {
    expect(sshCredentialKeysToInvalidate([localCfg('aaaa')], [])).toEqual([])
  })

  it('matches an id to its FIRST occurrence in next (as findSavedConfig does)', () => {
    // prev good; next has EVIL first (what a spawn would connect with) and the
    // original GOOD last. First-match => EVIL => changed => drop.
    const keys = sshCredentialKeysToInvalidate(
      [sshCfg('aaaa', { host: 'goodhost' })],
      [sshCfg('aaaa', { host: 'evilhost' }), sshCfg('aaaa', { host: 'goodhost' })],
    )
    expect(keys).toEqual(['aaaa', 'aaaa_sudo'])
  })

  it('skips non-object entries and entries without a string id', () => {
    expect(sshCredentialKeysToInvalidate([null, { sshConfig: { host: 'x' } }, sshCfg('aaaa')], [sshCfg('aaaa', { host: 'z' })]))
      .toEqual(['aaaa', 'aaaa_sudo'])
  })

  it('reports each changed id once even if duplicated in prev', () => {
    const keys = sshCredentialKeysToInvalidate([sshCfg('aaaa'), sshCfg('aaaa')], [sshCfg('aaaa', { host: 'z' })])
    expect(keys).toEqual(['aaaa', 'aaaa_sudo'])
  })
})

describe('isValidConfigsPayload — pure function', () => {
  it('accepts arrays of id-bearing objects with an optional object sshConfig', () => {
    expect(isValidConfigsPayload([])).toBe(true)
    expect(isValidConfigsPayload([{ id: 'a' }])).toBe(true)
    expect(isValidConfigsPayload([sshCfg('a')])).toBe(true)
    expect(isValidConfigsPayload([{ id: 'a', sshConfig: null }])).toBe(true)
  })

  it('rejects non-arrays, non-object items, missing ids, and oversized arrays', () => {
    expect(isValidConfigsPayload({})).toBe(false)
    expect(isValidConfigsPayload('x')).toBe(false)
    expect(isValidConfigsPayload([1])).toBe(false)
    expect(isValidConfigsPayload([{ label: 'no id' }])).toBe(false)
    expect(isValidConfigsPayload([{ id: 5 }])).toBe(false)
    expect(isValidConfigsPayload([{ id: 'a', sshConfig: 'nope' }])).toBe(false)
    expect(isValidConfigsPayload(Array.from({ length: 1001 }, (_, i) => ({ id: 'c' + i })))).toBe(false)
  })

  it('rejects duplicate ids (the spawn-reader vs. guard divergence, Bypass A)', () => {
    expect(isValidConfigsPayload([{ id: 'x' }, { id: 'x' }])).toBe(false)
    expect(isValidConfigsPayload([sshCfg('x', { host: 'evil' }), sshCfg('x', { host: 'good' })])).toBe(false)
  })
})
