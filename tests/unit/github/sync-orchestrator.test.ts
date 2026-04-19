import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SyncOrchestrator } from '../../../src/main/github/session/sync-orchestrator'
import type { SyncStateEvent } from '../../../src/main/github/session/sync-orchestrator'
import { CacheStore } from '../../../src/main/github/cache/cache-store'

async function flushMicrotasks() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

describe('SyncOrchestrator', () => {
  let tmp: string
  let cacheStore: CacheStore

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gho-'))
    cacheStore = new CacheStore(tmp)
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('emits synced state on success', async () => {
    const states: SyncStateEvent[] = []
    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => 'gho_x',
      emitData: () => {},
      emitSyncState: (p) => states.push(p),
      fetchers: {
        pr: async () => ({
          status: 'ok',
          data: {
            number: 1,
            title: 't',
            state: 'open',
            draft: false,
            user: { login: 'x' },
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
            mergeable: true,
            html_url: 'https://github.com/a/b/pull/1',
          },
        }),
        runs: async () => ({ status: 'ok', data: [] }),
        reviews: async () => ({ status: 'ok', data: [] }),
      },
    })
    orch.registerSession({
      sessionId: 's1',
      slug: 'a/b',
      branch: 'main',
      integration: { enabled: true, autoDetected: false },
    })
    await orch.syncNow('s1')
    expect(states.some((s) => s.state === 'synced')).toBe(true)
    orch.unregisterSession('s1')
  })

  it('preserves cached PR on "unchanged" (304 path)', async () => {
    const cache = await cacheStore.load()
    cache.repos['a/b'] = {
      etags: {},
      lastSynced: 100,
      accessedAt: 100,
      pr: {
        number: 99,
        title: 'cached',
        state: 'open',
        draft: false,
        author: 'x',
        createdAt: 0,
        updatedAt: 0,
        mergeableState: 'clean',
        url: 'u',
      },
    }
    cache.lru.push('a/b')
    await cacheStore.save(cache)

    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => 'gho_x',
      emitData: () => {},
      emitSyncState: () => {},
      fetchers: {
        pr: async () => ({ status: 'unchanged' }),
        runs: async () => ({ status: 'unchanged' }),
        reviews: async () => ({ status: 'unchanged' }),
      },
    })
    orch.registerSession({
      sessionId: 's1',
      slug: 'a/b',
      branch: 'x',
      integration: { enabled: true, autoDetected: false },
    })
    await orch.syncNow('s1')
    const after = await cacheStore.load()
    expect(after.repos['a/b'].pr?.number).toBe(99)
    orch.unregisterSession('s1')
  })

  it('blanks PR on "empty" (no PR for branch)', async () => {
    const cache = await cacheStore.load()
    cache.repos['a/b'] = {
      etags: {},
      lastSynced: 100,
      accessedAt: 100,
      pr: {
        number: 99,
        title: 'cached',
        state: 'open',
        draft: false,
        author: 'x',
        createdAt: 0,
        updatedAt: 0,
        mergeableState: 'clean',
        url: 'u',
      },
    }
    cache.lru.push('a/b')
    await cacheStore.save(cache)

    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => null,
      emitData: () => {},
      emitSyncState: () => {},
      fetchers: {
        pr: async () => ({ status: 'empty' }),
        runs: async () => ({ status: 'ok', data: [] }),
        reviews: async () => ({ status: 'ok', data: [] }),
      },
    })
    orch.registerSession({
      sessionId: 's1',
      slug: 'a/b',
      branch: 'x',
      integration: { enabled: true, autoDetected: false },
    })
    await orch.syncNow('s1')
    const after = await cacheStore.load()
    expect(after.repos['a/b'].pr).toBeUndefined()
    orch.unregisterSession('s1')
  })

  it('emits rate-limited with nextResetAt from RateLimitError', async () => {
    const states: SyncStateEvent[] = []
    const resetAt = Date.now() + 3_000
    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => 'gho_x',
      emitData: () => {},
      emitSyncState: (p) => states.push(p),
      fetchers: {
        pr: async () => {
          const e = new Error('rate limited') as Error & { resetAt: number }
          e.name = 'RateLimitError'
          e.resetAt = resetAt
          throw e
        },
        runs: async () => ({ status: 'ok', data: [] }),
        reviews: async () => ({ status: 'ok', data: [] }),
      },
    })
    orch.registerSession({
      sessionId: 's1',
      slug: 'a/b',
      branch: 'x',
      integration: { enabled: true, autoDetected: false },
    })
    await orch.syncNow('s1')
    expect(states.some((s) => s.state === 'rate-limited' && s.nextResetAt === resetAt)).toBe(true)
    orch.unregisterSession('s1')
  })

  it('pause blocks new scheduling; resume rearms it', async () => {
    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => null,
      emitData: () => {},
      emitSyncState: () => {},
      fetchers: {
        pr: async () => ({ status: 'empty' }),
        runs: async () => ({ status: 'ok', data: [] }),
        reviews: async () => ({ status: 'ok', data: [] }),
      },
    })
    orch.registerSession({
      sessionId: 's1',
      slug: 'a/b',
      branch: 'x',
      integration: { enabled: true, autoDetected: false },
    })
    orch.pause()
    expect(orch.isPaused()).toBe(true)
    orch.resume()
    expect(orch.isPaused()).toBe(false)
    orch.unregisterSession('s1')
  })

  it('LRU moves a slug to the most-recent end on every sync', async () => {
    const cache = await cacheStore.load()
    cache.repos['other/repo'] = { etags: {}, lastSynced: 0, accessedAt: 0 }
    cache.lru.push('other/repo', 'a/b', 'stale/repo')
    cache.repos['a/b'] = { etags: {}, lastSynced: 0, accessedAt: 0 }
    cache.repos['stale/repo'] = { etags: {}, lastSynced: 0, accessedAt: 0 }
    await cacheStore.save(cache)

    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => null,
      emitData: () => {},
      emitSyncState: () => {},
      fetchers: {
        pr: async () => ({ status: 'empty' }),
        runs: async () => ({ status: 'ok', data: [] }),
        reviews: async () => ({ status: 'ok', data: [] }),
      },
    })
    orch.registerSession({
      sessionId: 's1',
      slug: 'a/b',
      branch: 'x',
      integration: { enabled: true, autoDetected: false },
    })
    await orch.syncNow('s1')
    await flushMicrotasks()
    const after = await cacheStore.load()
    expect(after.lru[after.lru.length - 1]).toBe('a/b')
    orch.unregisterSession('s1')
  })
})
