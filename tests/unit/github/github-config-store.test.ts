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
    // Backup must exist with original contents preserved.
    const entries = await fs.readdir(tmp)
    const backup = entries.find((e) => e.startsWith('github-config.json.v9999.bak'))
    expect(backup).toBeDefined()
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
})
