import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubConfig } from '../../shared/github-types'
import { GITHUB_CONFIG_SCHEMA_VERSION } from '../../shared/github-constants'
import { redactTokens } from './security/token-redactor'

const FILENAME = 'github-config.json'

export class GitHubConfigStore {
  constructor(private dir: string) {}
  private get filePath() {
    return path.join(this.dir, FILENAME)
  }

  async read(): Promise<GitHubConfig | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed.schemaVersion !== GITHUB_CONFIG_SCHEMA_VERSION) {
        console.warn(`[github-config] unknown schemaVersion ${parsed.schemaVersion}`)
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
    const tmp = this.filePath + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
