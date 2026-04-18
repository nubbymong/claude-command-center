import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GitHubConfigStore } from '../../../src/main/github/github-config-store'
import {
  GITHUB_CONFIG_SCHEMA_VERSION,
  DEFAULT_SYNC_INTERVALS,
  DEFAULT_FEATURE_TOGGLES,
} from '../../../src/shared/github-constants'

function sample() {
  return {
    schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
    authProfiles: {},
    featureToggles: { ...DEFAULT_FEATURE_TOGGLES },
    syncIntervals: { ...DEFAULT_SYNC_INTERVALS },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

describe('GitHubConfigStore', () => {
  let tmp: string
  let store: GitHubConfigStore

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcfg-'))
    store = new GitHubConfigStore(tmp)
  })

  it('read returns null when missing', async () => {
    expect(await store.read()).toBeNull()
  })

  it('round-trips', async () => {
    await store.write(sample())
    expect(await store.read()).toEqual(sample())
  })

  it('atomic write leaves only final file', async () => {
    await store.write(sample())
    const entries = await fs.readdir(tmp)
    expect(entries).toEqual(['github-config.json'])
  })

  it('corrupt JSON → null', async () => {
    await fs.writeFile(path.join(tmp, 'github-config.json'), 'not json', 'utf8')
    expect(await store.read()).toBeNull()
  })

  it('unknown schemaVersion → null AND backs up file before any write clobbers it', async () => {
    const payload = JSON.stringify({ schemaVersion: 9999, mine: 'data' })
    const configPath = path.join(tmp, 'github-config.json')
    await fs.writeFile(configPath, payload, 'utf8')
    expect(await store.read()).toBeNull()
    // Backup must exist with original contents preserved. Filename prefix is
    // deterministic but includes a uniqueness suffix (see retention test below).
    const entries = await fs.readdir(tmp)
    const backup = entries.find((e) => e.startsWith('github-config.json.v9999.'))
    expect(backup).toBeDefined()
    expect(backup!.endsWith('.bak')).toBe(true)
    expect(await fs.readFile(path.join(tmp, backup!), 'utf8')).toBe(payload)
  })

  it('serializes concurrent writes without truncation or lost tmp files', async () => {
    const writes = Array.from({ length: 10 }, (_, i) => {
      const c = sample()
      c.enabledByDefault = i % 2 === 0
      return store.write(c)
    })
    await Promise.all(writes)
    // Only the final config file should remain — no leaked `.tmp` files.
    const entries = await fs.readdir(tmp)
    expect(entries).toEqual(['github-config.json'])
    // File must be valid JSON (not a half-written / interleaved blob).
    const raw = await fs.readFile(path.join(tmp, 'github-config.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('write succeeds when destination file already exists (Windows cross-platform)', async () => {
    // fs.rename(tmp, dest) fails on Windows when dest exists. Repeated writes
    // must overwrite reliably — regression guard so the store never breaks
    // on the second save.
    await store.write(sample())
    const a = sample()
    a.enabledByDefault = true
    await store.write(a)
    const b = sample()
    b.enabledByDefault = false
    await store.write(b)
    const raw = await fs.readFile(path.join(tmp, 'github-config.json'), 'utf8')
    expect(JSON.parse(raw).enabledByDefault).toBe(false)
    // No leaked tmp files.
    const entries = await fs.readdir(tmp)
    expect(entries).toEqual(['github-config.json'])
  })

  it('backup filename is NOT influenced by attacker-controlled schemaVersion (path traversal)', async () => {
    // Attacker writes a config with schemaVersion containing path separators.
    // Must NOT land outside the store's directory.
    const hostile = JSON.stringify({ schemaVersion: '../../pwn', data: 'x' })
    await fs.writeFile(path.join(tmp, 'github-config.json'), hostile, 'utf8')
    expect(await store.read()).toBeNull()
    // Scan the parent of tmp — no file should have been created there.
    const parent = path.dirname(tmp)
    const parentEntries = await fs.readdir(parent)
    // Parent shouldn't have a 'pwn' backup file.
    expect(parentEntries.some((e) => e.includes('pwn'))).toBe(false)
    // Inside tmp the backup name must be sanitized (contain 'unknown' or digits only).
    const entries = await fs.readdir(tmp)
    const backup = entries.find((e) => e.includes('.bak'))
    expect(backup).toBeDefined()
    expect(backup).not.toMatch(/\.\./)
    expect(backup).not.toMatch(/[\\/]/)
  })

  it('backup writes do not overwrite previous backups of the same schema version', async () => {
    // Multiple reads against an unknown schema must keep each backup, not
    // overwrite the first one (data preservation on corruption).
    const payload1 = JSON.stringify({ schemaVersion: 9999, gen: 1 })
    await fs.writeFile(path.join(tmp, 'github-config.json'), payload1, 'utf8')
    await store.read()
    // Simulate a second unknown-schema file a moment later.
    await new Promise((r) => setTimeout(r, 5))
    const payload2 = JSON.stringify({ schemaVersion: 9999, gen: 2 })
    await fs.writeFile(path.join(tmp, 'github-config.json'), payload2, 'utf8')
    await store.read()
    const entries = await fs.readdir(tmp)
    const backups = entries.filter((e) => e.includes('.bak'))
    expect(backups.length).toBeGreaterThanOrEqual(2)
  })
})
