import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GitHubConfig } from '../../shared/github-types'
import {
  GITHUB_CONFIG_SCHEMA_VERSION,
  CACHE_CORRUPT_BACKUPS_KEEP,
} from '../../shared/github-constants'
import { redactTokens } from './security/token-redactor'
import { AsyncMutex } from './async-mutex'

const FILENAME = 'github-config.json'

/**
 * Sanitizes an untrusted schemaVersion value for use in a backup filename.
 * Accepts non-negative integer values; anything else becomes 'unknown'.
 * Prevents path traversal via attacker-controlled JSON that sets schemaVersion
 * to '../../etc' or similar.
 */
function sanitizeSchemaVersionForFilename(raw: unknown): string {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return String(raw)
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return raw
  return 'unknown'
}

export class GitHubConfigStore {
  private mutex = new AsyncMutex()

  constructor(private dir: string) {}
  private get filePath() {
    return path.join(this.dir, FILENAME)
  }

  async read(): Promise<GitHubConfig | null> {
    // Serialize with write() on the same mutex. The overwrite path uses
    // copyFile which is NOT atomic at the byte level — without this, a
    // concurrent read could observe a partially-copied destination and
    // fail JSON.parse. AsyncMutex is exclusive (no reader/writer split),
    // so reads also serialize against other reads. That's acceptable here:
    // read() is called O(1)-ish per feature event (app start, profile
    // list, after a push), not on a hot path.
    return this.mutex.run(async () => {
      try {
        const raw = await fs.readFile(this.filePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed.schemaVersion !== GITHUB_CONFIG_SCHEMA_VERSION) {
          await this.backupUnknownSchemaFile(raw, parsed.schemaVersion)
          return null
        }
        return parsed as GitHubConfig
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        console.warn('[github-config] read failed:', redactTokens(String(err)))
        return null
      }
    })
  }

  async write(config: GitHubConfig): Promise<void> {
    await this.mutex.run(async () => {
      // Unique tmp per write — prevents parallel writers from colliding on a
      // shared `.tmp` path and corrupting each other's output.
      const tmp = `${this.filePath}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
      try {
        // Windows cross-platform atomic write. fs.rename fails on Windows
        // when the destination file already exists — see
        // src/main/config-manager.ts for the reference pattern. copyFile
        // atomically overwrites an existing destination on every OS; plain
        // rename is used only for the first write when no dest exists yet.
        if (existsSync(this.filePath)) {
          await fs.copyFile(tmp, this.filePath)
          try {
            await fs.unlink(tmp)
          } catch {
            /* ignore tmp cleanup failures */
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

  private async backupUnknownSchemaFile(raw: string, schemaVersion: unknown): Promise<void> {
    // Unknown schema → likely written by a newer app version. Preserve the
    // original file before any downstream code issues a `write()` that would
    // clobber it with an empty / downgraded config.
    //
    // `schemaVersion` comes from untrusted file content, so NEVER interpolate
    // it raw into a filename. sanitizeSchemaVersionForFilename limits the
    // value to integers or 'unknown'.
    try {
      const safeVersion = sanitizeSchemaVersionForFilename(schemaVersion)
      // Uniqueness suffix: if the store reads an unknown-schema file multiple
      // times (downgrade → upgrade → downgrade), each backup is preserved
      // independently. Without a suffix, a second read with the same schema
      // would overwrite the first backup, silently destroying recoverable data.
      const suffix = Date.now().toString(36) + '.' + randomUUID().slice(0, 8)
      const backup = path.join(
        this.dir,
        `${FILENAME}.v${safeVersion}.${suffix}.bak`,
      )
      await fs.writeFile(backup, raw, 'utf8')
      console.warn(
        `[github-config] unknown schemaVersion ${safeVersion}; backed up to ${path.basename(backup)}`,
      )
      await this.pruneBackups()
    } catch (err) {
      console.warn('[github-config] backup failed:', redactTokens(String(err)))
    }
  }

  private async pruneBackups(): Promise<void> {
    // Keep the most-recent CACHE_CORRUPT_BACKUPS_KEEP backups; delete older
    // ones so the dir doesn't grow unbounded. Fully async — don't block the
    // event loop with statSync.
    try {
      const entries = await fs.readdir(this.dir)
      const candidates = entries.filter(
        (e) => e.startsWith(`${FILENAME}.v`) && e.endsWith('.bak'),
      )
      // Stat all candidates in parallel. Tolerate races where a file
      // disappears between readdir and stat (another process or retention
      // pass could have removed it).
      const stats = await Promise.all(
        candidates.map(async (name) => {
          const full = path.join(this.dir, name)
          try {
            const s = await fs.stat(full)
            return { full, mtimeMs: s.mtimeMs }
          } catch {
            return null
          }
        }),
      )
      const backups = stats
        .filter((s): s is { full: string; mtimeMs: number } => s !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)

      await Promise.all(
        backups.slice(CACHE_CORRUPT_BACKUPS_KEEP).map(async (old) => {
          try {
            await fs.unlink(old.full)
          } catch {
            /* ignore single-file prune failures */
          }
        }),
      )
    } catch {
      /* best-effort */
    }
  }
}
