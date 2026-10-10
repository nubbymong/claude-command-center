import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { parseRepoUrl } from '../security/repo-url-parser'
import { findGit } from '../../review-diff'
import { withoutCurrentFolderLookup } from '../../windows-programs'

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

/** git's own switches on every run here: no pager, no fsmonitor and no
 *  signature display, whatever the repository's configuration says. */
export const GIT_RUN_PREFIX: readonly string[] = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false']

/** What a run without git says (every caller reads an error as "no integration"). */
const NO_GIT = 'git was not found in a folder PATH names'

/**
 * Default local-git runner: git by its full path from PATH's absolute folders
 * (review-diff.ts findGit, the reviewer's own lookup), started with an
 * argument list and no shell, with GIT_RUN_PREFIX before the caller's
 * arguments. On Windows git also looks for the programs it starts by name
 * only in PATH's folders. The project folder is git's working directory only:
 * git is never looked for there. No git: the run rejects. `deps` is for the
 * test.
 */
export function defaultGitRun(deps: {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isFile?: (p: string) => boolean
} = {}): RunGit {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const isFile = deps.isFile ?? ((p: string) => fs.statSync(p).isFile())
  let git: string | null | undefined
  return (cwd, args) =>
    new Promise<string>((resolve, reject) => {
      if (git === undefined) {
        const pathKey = Object.keys(env).find((k) => (platform === 'win32' ? k.toUpperCase() : k) === 'PATH')
        git = findGit(pathKey ? env[pathKey] : undefined, platform, isFile)
      }
      if (!git) { reject(new Error(NO_GIT)); return }
      const proc = spawn(git, [...GIT_RUN_PREFIX, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: platform === 'win32' ? withoutCurrentFolderLookup(env) : env,
      })
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
