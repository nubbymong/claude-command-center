import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CacheStore } from '../../../src/main/github/cache/cache-store'
import { GITHUB_CACHE_SCHEMA_VERSION } from '../../../src/shared/github-constants'

describe('CacheStore', () => {
  let tmp: string
  let store: CacheStore

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcache-'))
    store = new CacheStore(tmp)
  })

  it('empty on no file', async () => {
    const c = await store.load()
    expect(c.schemaVersion).toBe(GITHUB_CACHE_SCHEMA_VERSION)
    expect(c.repos).toEqual({})
  })

  it('persists + reloads', async () => {
    const c = await store.load()
    c.repos['a/b'] = { etags: {}, lastSynced: 1, accessedAt: 1 }
    c.lru = ['a/b']
    await store.save(c)
    expect((await store.load()).repos['a/b']).toBeDefined()
  })

  it('LRU evicts over cap', async () => {
    const c = await store.load()
    for (let i = 0; i < 55; i++) {
      const k = `o/r${i}`
      c.repos[k] = { etags: {}, lastSynced: i, accessedAt: i }
      c.lru.push(k)
    }
    await store.save(c)
    const re = await store.load()
    expect(Object.keys(re.repos).length).toBeLessThanOrEqual(50)
    expect(re.repos['o/r0']).toBeUndefined()
    expect(re.repos['o/r54']).toBeDefined()
  })

  it('corrupt file → backup + empty', async () => {
    await fs.writeFile(path.join(tmp, 'github-cache.json'), '{bad', 'utf8')
    const c = await store.load()
    expect(c.repos).toEqual({})
    const entries = await fs.readdir(tmp)
    expect(entries.some((e) => e.startsWith('github-cache.corrupt-'))).toBe(true)
  })

  it('retains at most 3 corrupt backups', async () => {
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `github-cache.corrupt-${1000 + i}.json`), 'x', 'utf8')
    }
    await fs.writeFile(path.join(tmp, 'github-cache.json'), '{bad', 'utf8')
    await store.load()
    const entries = await fs.readdir(tmp)
    const corrupts = entries.filter((e) => e.startsWith('github-cache.corrupt-'))
    expect(corrupts.length).toBe(3)
  })

  it('unknown schemaVersion → backup + empty', async () => {
    await fs.writeFile(
      path.join(tmp, 'github-cache.json'),
      JSON.stringify({ schemaVersion: 999 }),
      'utf8',
    )
    const c = await store.load()
    expect(c.repos).toEqual({})
    const entries = await fs.readdir(tmp)
    expect(entries.some((e) => e.startsWith('github-cache.corrupt-'))).toBe(true)
  })

  it('save works on Windows when destination exists (cross-platform atomic overwrite)', async () => {
    // Same regression guard as GitHubConfigStore — fs.rename fails on Windows
    // when the destination file already exists. First save creates the file;
    // second save must overwrite it reliably.
    const c = await store.load()
    c.repos['a/b'] = { etags: {}, lastSynced: 1, accessedAt: 1 }
    c.lru = ['a/b']
    await store.save(c)
    c.repos['a/b'].lastSynced = 2
    await store.save(c)
    const reloaded = await store.load()
    expect(reloaded.repos['a/b']?.lastSynced).toBe(2)
  })
})
