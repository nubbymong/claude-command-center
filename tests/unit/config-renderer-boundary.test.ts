import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The renderer is the less-trusted process. Two config files are secrets
// (conductor-secret.json is the ONLY gate on the loopback Conductor MCP server,
// which exposes vision_eval; ssh-credentials.json is the legacy SSH credential
// store) and the renderer has no reader for either. These tests pin the IPC
// boundary: `config:loadAll` never hands a secret key to the renderer, and
// `config:save` refuses to write one (or any unregistered key) on the
// renderer's say-so. Main-process code that needs a secret reads it directly.

const h = vi.hoisted(() => ({
  resourcesDir: '',
  handlers: {} as Record<string, (e: unknown, ...args: unknown[]) => unknown>,
  warns: [] as string[],
  tokenomicsRefreshes: 0,
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
  refreshTokenomicsConfigs: () => { h.tokenomicsRefreshes++ },
}))

import {
  loadAllConfig, readConfig, saveConfig, getConfigDir,
  RENDERER_CONFIG_KEYS, isRendererConfigKey,
} from '../../src/main/config-manager'
import { registerConfigHandlers } from '../../src/main/ipc/config-handlers'

const SECRET = { secret: 'a'.repeat(64), v: 2 }
const SSH = { 'cfg-1': 'ENCRYPTED-BLOB' }

// One resources dir for the whole file: config-manager caches the CONFIG path
// on first use, so a fresh mkdtemp per test would leave readConfig pointing at
// a directory that is already gone.
let tmp = ''

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cfg-boundary-'))
  h.resourcesDir = tmp
})

beforeEach(() => {
  h.handlers = {}
  h.warns = []
  h.tokenomicsRefreshes = 0
  // Plant both secret files AND an ordinary one, so "the secret is absent from
  // loadAll" cannot pass merely because nothing was on disk.
  const dir = join(tmp, 'CONFIG')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'conductor-secret.json'), JSON.stringify(SECRET))
  writeFileSync(join(dir, 'ssh-credentials.json'), JSON.stringify(SSH))
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ id: 'c1', label: 'x' }]))
  registerConfigHandlers()
})

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('the renderer allowlist', () => {
  it('is every registered key except the two secrets', () => {
    expect(RENDERER_CONFIG_KEYS).toContain('commands')
    expect(RENDERER_CONFIG_KEYS).toContain('settings')
    expect(RENDERER_CONFIG_KEYS).not.toContain('conductorSecret')
    expect(RENDERER_CONFIG_KEYS).not.toContain('sshCredentials')
    expect(isRendererConfigKey('commands')).toBe(true)
    expect(isRendererConfigKey('conductorSecret')).toBe(false)
    expect(isRendererConfigKey('sshCredentials')).toBe(false)
    expect(isRendererConfigKey('not-a-key')).toBe(false)
    expect(isRendererConfigKey(undefined)).toBe(false)
    expect(isRendererConfigKey({ toString: () => 'commands' })).toBe(false)
  })
})

describe('config:loadAll', () => {
  it('never hands the secret configs to the renderer, even when the files exist', async () => {
    // The files ARE there and main CAN read them -- the boundary is the filter.
    expect(readConfig('conductorSecret')).toEqual(SECRET)
    expect(readConfig('sshCredentials')).toEqual(SSH)

    const direct = loadAllConfig()
    expect(direct.data).not.toHaveProperty('conductorSecret')
    expect(direct.data).not.toHaveProperty('sshCredentials')
    expect(direct.data.commands).toEqual([{ id: 'c1', label: 'x' }])
    expect(JSON.stringify(direct)).not.toContain('a'.repeat(64))
    expect(JSON.stringify(direct)).not.toContain('ENCRYPTED-BLOB')

    // And the same through the IPC handler the renderer actually calls.
    const viaIpc = await h.handlers['config:loadAll']({}) as { data: Record<string, unknown> }
    expect(Object.keys(viaIpc.data).sort()).toEqual([...RENDERER_CONFIG_KEYS].sort())
  })
})

describe('config:save', () => {
  it('refuses the secret keys from the renderer and leaves the files untouched', async () => {
    const save = h.handlers['config:save']
    const before = readFileSync(join(getConfigDir(), 'conductor-secret.json'), 'utf-8')

    expect(await save({}, 'conductorSecret', { secret: 'b'.repeat(64), v: 2 })).toBe(false)
    expect(await save({}, 'sshCredentials', { 'cfg-1': 'tampered' })).toBe(false)

    expect(readFileSync(join(getConfigDir(), 'conductor-secret.json'), 'utf-8')).toBe(before)
    expect(readConfig('sshCredentials')).toEqual(SSH)
    expect(h.warns.filter((w) => w.includes('config:save refused')).length).toBe(2)
    // The refusal names the key but never echoes the data.
    expect(h.warns.join('\n')).not.toContain('b'.repeat(64))
    expect(h.warns.join('\n')).not.toContain('tampered')
  })

  it('refuses an unregistered or non-string key without touching disk', async () => {
    const save = h.handlers['config:save']
    expect(await save({}, 'conductor-secret.json', { secret: 'x' })).toBe(false)
    expect(await save({}, '../evil', { secret: 'x' })).toBe(false)
    expect(await save({}, 42, { secret: 'x' })).toBe(false)
    expect(await save({}, undefined, { secret: 'x' })).toBe(false)
    expect(existsSync(join(getConfigDir(), '..', 'evil'))).toBe(false)
    expect(existsSync(join(getConfigDir(), '..', 'evil.json'))).toBe(false)
  })

  it('still writes an ordinary renderer key and keeps the tokenomics hook', async () => {
    const save = h.handlers['config:save']
    expect(await save({}, 'commands', [{ id: 'c2', label: 'y' }])).toBe(true)
    expect(readConfig('commands')).toEqual([{ id: 'c2', label: 'y' }])
    expect(await save({}, 'configs', [])).toBe(true)
    expect(h.tokenomicsRefreshes).toBe(1)
    expect(h.warns).toEqual([])
  })

  it('main-process code can still write a secret directly (the boundary is the IPC, not the store)', () => {
    expect(saveConfig('conductorSecret', { secret: 'c'.repeat(64), v: 2 })).toBe(true)
    expect(readConfig('conductorSecret')).toEqual({ secret: 'c'.repeat(64), v: 2 })
  })
})
