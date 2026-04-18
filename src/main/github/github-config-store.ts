import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GitHubConfig } from '../../shared/github-types'
import { GITHUB_CONFIG_SCHEMA_VERSION } from '../../shared/github-constants'
import { redactTokens } from './security/token-redactor'
import { AsyncMutex } from './async-mutex'

const FILENAME = 'github-config.json'

export class GitHubConfigStore {
  private mutex = new AsyncMutex()

  constructor(private dir: string) {}
  private get filePath() {
    return path.join(this.dir, FILENAME)
  }

  async read(): Promise<GitHubConfig | null> {
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
  }

  async write(config: GitHubConfig): Promise<void> {
    await this.mutex.run(async () => {
      // Unique tmp per write — prevents parallel writers from colliding on a
      // shared `.tmp` path and corrupting each other's output.
      const tmp = `${this.filePath}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
      await fs.rename(tmp, this.filePath)
    })
  }

  /**
   * Runs `fn` with exclusive write access. Callers perform their own read of
   * the latest config inside `fn`, then call `this.write()` — mutex is
   * re-entrant via promise chaining.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn)
  }

  private async backupUnknownSchemaFile(raw: string, schemaVersion: unknown): Promise<void> {
    // Unknown schema → likely written by a newer app version. Preserve the
    // original file before any downstream code issues a `write()` that would
    // clobber it with an empty / downgraded config.
    try {
      const backup = `${this.filePath}.v${schemaVersion ?? 'unknown'}.bak`
      await fs.writeFile(backup, raw, 'utf8')
      console.warn(
        `[github-config] unknown schemaVersion ${schemaVersion}; backed up to ${backup}`,
      )
    } catch (err) {
      console.warn('[github-config] backup failed:', redactTokens(String(err)))
    }
  }
}
