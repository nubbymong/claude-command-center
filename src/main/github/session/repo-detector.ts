import { spawn } from 'node:child_process'
import { parseRepoUrl } from '../security/repo-url-parser'

export type RunGit = (cwd: string, args: string[]) => Promise<string>

/**
 * Attempts to derive the `owner/repo` slug for a local session's working
 * directory by reading `git remote get-url origin` and parsing the result
 * with the shared HTTPS/SSH validator. Non-github remotes and errors both
 * return null so callers can fall back to "no integration".
 */
export async function detectRepoFromCwd(
  cwd: string,
  run: RunGit,
): Promise<string | null> {
  try {
    const out = await run(cwd, ['remote', 'get-url', 'origin'])
    return parseRepoUrl(out)
  } catch {
    return null
  }
}

/**
 * Default local-git runner. node-child_process.spawn with `cwd` is safe:
 * git receives the directory as an API argument, not via shell interpolation.
 */
export function defaultGitRun(): RunGit {
  return (cwd, args) =>
    new Promise<string>((resolve, reject) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (c) => (stdout += c.toString()))
      proc.stderr.on('data', (c) => (stderr += c.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `git exited ${code}`))
        else resolve(stdout)
      })
    })
}
