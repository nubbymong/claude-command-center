import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GitHubCache } from '../../../shared/github-types'
import {
  CACHE_CORRUPT_BACKUPS_KEEP,
  CACHE_MAX_REPOS,
  GITHUB_CACHE_SCHEMA_VERSION,
} from '../../../shared/github-constants'
import { redactTokens } from '../security/token-redactor'
import { AsyncMutex } from '../async-mutex'

const FILENAME = 'github-cache.json'
const CORRUPT_PREFIX = 'github-cache.corrupt-'

function empty(): GitHubCache {
  return {
    schemaVersion: GITHUB_CACHE_SCHEMA_VERSION,
    repos: {},
    notificationsByProfile: {},
    lru: [],
  }
}

export class CacheStore {
  private mutex = new AsyncMutex()

  constructor(private dir: string) {}
  private get filePath() {
    return path.join(this.dir, FILENAME)
  }

  async load(): Promise<GitHubCache> {
    return this.mutex.run(async () => {
      let raw: string
      try {
        raw = await fs.readFile(this.filePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty()
        console.warn('[github-cache] read failed:', redactTokens(String(err)))
        return empty()
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed.schemaVersion !== GITHUB_CACHE_SCHEMA_VERSION) {
          await this.backupCorrupt()
          return empty()
        }
        return parsed as GitHubCache
      } catch {
        await this.backupCorrupt()
        return empty()
      }
    })
  }

  /**
   * Atomic read-modify-write. Prefer this over separate `load`/`save` calls
   * when concurrent writers are possible (e.g. the SyncOrchestrator running
   * multiple sessions): two sessions both loading the same snapshot and
   * saving sequentially will lose the earlier write.
   *
   * IMPORTANT: AsyncMutex is NOT re-entrant. `fn` MUST NOT call load(),
   * save(), or update() on the same CacheStore — doing so will deadlock.
   * The internal readUnlocked / writeUnlocked helpers side-step the public
   * API precisely because they execute inside the already-held mutex.
   */
  async update(fn: (cache: GitHubCache) => void | Promise<void>): Promise<void> {
    await this.mutex.run(async () => {
      const cache = await this.readUnlocked()
      await fn(cache)
      await this.writeUnlocked(cache)
    })
  }

  private async readUnlocked(): Promise<GitHubCache> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      console.warn('[github-cache] read failed:', redactTokens(String(err)))
      return empty()
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed.schemaVersion !== GITHUB_CACHE_SCHEMA_VERSION) {
        await this.backupCorrupt()
        return empty()
      }
      return parsed as GitHubCache
    } catch {
      await this.backupCorrupt()
      return empty()
    }
  }

  private async writeUnlocked(cache: GitHubCache): Promise<void> {
    const lru = cache.lru.filter((s) => s in cache.repos)
    while (Object.keys(cache.repos).length > CACHE_MAX_REPOS && lru.length > 0) {
      const evict = lru.shift()!
      delete cache.repos[evict]
    }
    cache.lru = lru
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(cache), 'utf8')
    try {
      if (existsSync(this.filePath)) {
        await fs.copyFile(tmp, this.filePath)
        try {
          await fs.unlink(tmp)
        } catch {
          /* ignore */
        }
      } else {
        await fs.rename(tmp, this.filePath)
      }
    } catch (err) {
      try {
        await fs.unlink(tmp)
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  async save(cache: GitHubCache): Promise<void> {
    await this.mutex.run(async () => {
      // LRU: drop entries no longer in repos (stale after manual edits), then
      // evict oldest while over cap. LRU ordering is owned by the caller —
      // see SyncOrchestrator (remove-if-present, push on every access).
      const lru = cache.lru.filter((s) => s in cache.repos)
      while (Object.keys(cache.repos).length > CACHE_MAX_REPOS && lru.length > 0) {
        const evict = lru.shift()!
        delete cache.repos[evict]
      }
      cache.lru = lru

      // Windows cross-platform write: fs.rename fails when dest exists,
      // copyFile gives us overwrite compatibility. Mutex above already
      // serializes against concurrent load()/save().
      const tmp = `${this.filePath}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(cache), 'utf8')
      try {
        if (existsSync(this.filePath)) {
          await fs.copyFile(tmp, this.filePath)
          try {
            await fs.unlink(tmp)
          } catch {
            /* ignore */
          }
        } else {
          await fs.rename(tmp, this.filePath)
        }
      } catch (err) {
        try {
          await fs.unlink(tmp)
        } catch {
          /* ignore */
        }
        throw err
      }
    })
  }

  private async backupCorrupt(): Promise<void> {
    // Uniqueness suffix — Date.now() alone can collide if called twice in
    // the same millisecond (seen during fast test retries).
    const ts = Date.now()
    const suffix = randomUUID().slice(0, 8)
    const dest = path.join(this.dir, `${CORRUPT_PREFIX}${ts}-${suffix}.json`)
    try {
      await fs.rename(this.filePath, dest)
    } catch {
      /* ignore — source may already be gone */
    }
    await this.pruneCorrupt()
  }

  private async pruneCorrupt(): Promise<void> {
    try {
      const entries = await fs.readdir(this.dir)
      const backups = entries
        .filter((e) => e.startsWith(CORRUPT_PREFIX) && e.endsWith('.json'))
        .sort() // lexical sort on timestamp prefix = chronological
      const excess = backups.length - CACHE_CORRUPT_BACKUPS_KEEP
      for (let i = 0; i < excess; i++) {
        await fs.unlink(path.join(this.dir, backups[i])).catch(() => {})
      }
    } catch {
      /* best-effort */
    }
  }
}
