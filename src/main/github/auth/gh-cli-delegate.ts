import { spawn } from 'node:child_process'
import { redactTokens } from '../security/token-redactor'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}
export type RunGh = (args: string[]) => Promise<RunResult>

/**
 * Parses `gh auth status` output for github.com accounts only.
 * Ignores enterprise hosts (ghe.*, etc.) so we never try to hit them with
 * github.com URLs.
 */
export function parseGhAuthStatus(output: string): string[] {
  const users: string[] = []
  for (const m of output.matchAll(/Logged in to github\.com account (\S+)/g)) {
    users.push(m[1])
  }
  return users
}

/**
 * Fetches a token for the given gh account. `--user` is mandatory — relying
 * on the active account would race with `gh auth switch` in another shell.
 */
export async function ghAuthToken(username: string, run: RunGh): Promise<string> {
  const r = await run(['auth', 'token', '--user', username])
  if (r.code !== 0) {
    throw new Error(redactTokens(r.stderr || `gh auth token exited ${r.code}`))
  }
  return r.stdout.trim()
}

/**
 * Enumerates authed github.com accounts. Tolerates missing binary / spawn
 * errors by returning [] — callers treat that as "no gh auth available".
 * gh writes the account list to stderr even on exit 0, so we read both.
 */
export async function ghAuthStatus(run: RunGh): Promise<string[]> {
  try {
    const r = await run(['auth', 'status'])
    return parseGhAuthStatus(r.stdout + '\n' + r.stderr)
  } catch (err) {
    console.warn('[gh-cli] auth status failed:', redactTokens(String(err)))
    return []
  }
}

/**
 * Default `gh` runner using child_process.spawn. Windows: Node's spawn
 * finds `gh.cmd` on PATH without needing shell:true.
 */
export function defaultGhRun(): RunGh {
  return (args) =>
    new Promise<RunResult>((resolve, reject) => {
      const proc = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (c) => (stdout += c.toString()))
      proc.stderr.on('data', (c) => (stderr += c.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
    })
}
