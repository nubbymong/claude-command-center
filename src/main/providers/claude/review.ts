// WP2 commit 5b (plan "Commit 5b"): Claude Code as the reviewer for a Codex
// session. One isolated, non-interactive `claude -p` per review, run from a
// launch the accounts service prepared (kind `review`): the executable
// discovery proved, the reviewer account's profile-home environment (ambient
// authority removed, the realm selector set last), in the reviewed project.
//
// Read-only by construction, from the pinned CLI's own switches (2.1.278;
// each is listed in its --help, and what it does was read in its code):
// `--restricted` removes every tool that runs commands or code, ignores
// user, project and local settings files (so a project cannot widen the
// reviewer or redirect its account), and confines the file tools to the
// working folder; `--tools Read,Grep,Glob` names the
// only tools it has; `--strict-mcp-config` with no config gives it no MCP
// server (depth one: it cannot reach the Conductor tools);
// `--no-session-persistence` writes no transcript. The prompt -- which
// carries the change, produced by the main process -- goes on stdin, never
// argv and never a shell. The run goes through the CLI runner (injected by
// the composition root): no shell, the whole chain killed on a deadline or a
// cancel.
//
// Output contract of the pinned CLI (`--output-format json`): ONE line on
// stdout, the result message as JSON (or, when the user's own config turns
// `verbose` on, which --restricted does not ignore, the array of every
// message, the result last) -- `type: "result"`,
// `subtype` ("success" or "error_*"), `is_error`, `result` (the reply, or the
// failure text when is_error), `errors` (on the error subtypes) and `usage`
// (input, cache creation, cache read and output tokens).
import type { ProviderReviewOperations, ReviewRunInput, ReviewRunResult, ReviewUsage, RealmRef } from '../core'
import { reviewerEnv, finishReview, redactFailure, redactHead, clip, WINDOW, MARGIN, MAX_MESSAGE } from '../core'

/** The reviewer's argv: a constant, so no request text reaches a command
 *  line. Each switch is verified against the pinned CLI's --help. */
export const CLAUDE_REVIEW_ARGS: readonly string[] = Object.freeze([
  '-p',
  '--restricted',
  '--strict-mcp-config',
  '--tools', 'Read,Grep,Glob',
  '--output-format', 'json',
  '--no-session-persistence',
])

/** How the composition root runs a Claude process: the CLI runner and its
 *  command-line rules, handed in so this package imports no other one (R2). */
export interface ClaudeCliCommand { file: string; args: string[]; verbatim: boolean; cwd: string }
export interface ClaudeCliRunOptions {
  env: Record<string, string>
  timeoutMs: number
  stdin?: string
  maxOutput?: number
  onChunk?: (text: string, stream: 'stdout' | 'stderr') => void
  signal?: AbortSignal
}
export interface ClaudeCliRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  stopped?: 'cancel' | 'deadline'
  spawnError?: string
}
export interface ClaudeCliPorts {
  /** A constant argv against one resolved executable, or why not (a Windows
   *  shim goes through the absolute cmd.exe, verbatim). */
  commandLine(executable: string, args: readonly string[], platform: NodeJS.Platform, env: { ComSpec?: string; SystemRoot?: string }): ClaudeCliCommand | { refused: string }
  /** ComSpec and SystemRoot from an environment copy, for commandLine. */
  shellEnv(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): { ComSpec?: string; SystemRoot?: string }
  run(cmd: ClaudeCliCommand, opts: ClaudeCliRunOptions): Promise<ClaudeCliRunResult>
}

export interface ClaudeReviewDeps extends ClaudeCliPorts {
  platform?: NodeJS.Platform
  /** The profile behind the prepared launch's realm, or null. */
  profileOf(realm: RealmRef): Promise<string | null>
  /** Mark the profile as a credential consumer for at most `maxAgeMs`, once
   *  any token refresh in flight for it has settled; returns the release, or
   *  null when the signal fired while it waited (then nothing is held). */
  holdProfile(profileId: string, maxAgeMs: number, signal?: AbortSignal): Promise<(() => void) | null>
  /** The launch's preflight record (a diagnostic; never refuses). */
  recordPreflight(profileId: string, env: Readonly<Record<string, string>>): void
}

/** The consumer hold outlives the run's own deadline by this much at most:
 *  the run settles right after its kill, so a hold older than this could only
 *  be one whose release never ran. */
export const CLAUDE_REVIEW_HOLD_GRACE_MS = 60_000
/** stdout is read as it arrives, up to this much: the result line carries the
 *  whole review. More than this is refused, never parsed from a cut. */
export const CLAUDE_REVIEW_MAX_STDOUT = 8 * 1024 * 1024
/** The runner's own head-capped capture is not used. */
const RUNNER_CAPTURE = 64 * 1024

export interface ClaudeResultOutcome {
  /** The review, or null when the run ended without one. */
  text: string | null
  usage?: ReviewUsage
  error?: string
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** The pinned CLI's usage, in the reviewer contract's terms: every input
 *  token (fresh, cache writes and cache reads), of which cached are the
 *  cache reads, and output. */
function readUsage(u: unknown): ReviewUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const r = u as Record<string, unknown>
  const cacheRead = num(r.cache_read_input_tokens)
  return {
    inputTokens: num(r.input_tokens) + num(r.cache_creation_input_tokens) + cacheRead,
    cachedInputTokens: cacheRead,
    outputTokens: num(r.output_tokens),
  }
}

/** The last result message on stdout (a line holding it, or holding the
 *  verbose array whose last result it is), or null when there is none. Only
 *  a `success` that is not an error, with a string result, is a review. */
export function parseClaudeResult(stdout: string): ClaudeResultOutcome | null {
  const lines = String(stdout ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i].trim()
    if (!l.startsWith('{') && !l.startsWith('[')) continue
    let parsed: unknown
    try { parsed = JSON.parse(l) } catch { continue }
    // The verbose form is an array of messages: its last result is the one.
    const ev = Array.isArray(parsed) ? [...parsed].reverse().find((m) => m && typeof m === 'object' && (m as Record<string, unknown>).type === 'result') : parsed
    if (!ev || typeof ev !== 'object' || (ev as Record<string, unknown>).type !== 'result') continue
    const e = ev as Record<string, unknown>
    const usage = readUsage(e.usage)
    const withUsage = usage ? { usage } : {}
    if (e.subtype === 'success' && e.is_error === false && typeof e.result === 'string') return { text: e.result, ...withUsage }
    const errors = Array.isArray(e.errors) ? e.errors.filter((x): x is string => typeof x === 'string' && x.trim() !== '').join('; ') : ''
    const error = errors || (typeof e.result === 'string' && e.result.trim() ? e.result : `the run ended without a review (${typeof e.subtype === 'string' ? e.subtype : 'no result'})`)
    return { text: null, error, ...withUsage }
  }
  return null
}

export function createClaudeReviewOperations(deps: ClaudeReviewDeps): ProviderReviewOperations {
  const platform = deps.platform ?? process.platform
  return {
    async run(input: ReviewRunInput): Promise<ReviewRunResult> {
      const cancelled: ReviewRunResult = { ok: false, code: 'cancelled', message: 'The review was cancelled.' }
      if (input.signal?.aborted) return cancelled
      const win32 = platform === 'win32'
      const env = reviewerEnv(input.env, platform)
      const cmd = deps.commandLine(input.executable, CLAUDE_REVIEW_ARGS, platform, deps.shellEnv(env, platform))
      if ('refused' in cmd) return { ok: false, code: 'not-started', message: `Claude Code could not be started: ${cmd.refused}.` }
      // cmd.exe cannot use a network path as its current directory: it would
      // start the shim in the Windows folder and Claude would review that.
      if (win32 && cmd.verbatim && /^[\\/]{2}/.test(input.cwd)) {
        return { ok: false, code: 'not-started', message: 'Claude Code review cannot run an npm-installed Claude Code in a project on a network path (cmd.exe would start it in the Windows folder, not the project). Use a project on a local drive, or the native Claude Code installer.' }
      }
      let profileId: string | null = null
      try { profileId = input.realm ? await deps.profileOf(input.realm) : null } catch { profileId = null }
      if (!profileId) return { ok: false, code: 'not-started', message: "Claude Code could not be started: the reviewer account's home could not be located." }
      // The account's own credentials are in use for the whole run: the hold
      // comes BEFORE the wait for a refresh in flight (claude-headless's
      // order), so no new rotation can start in between.
      let release: (() => void) | null
      try {
        release = await deps.holdProfile(profileId, input.timeoutMs + CLAUDE_REVIEW_HOLD_GRACE_MS, input.signal)
      } catch {
        return { ok: false, code: 'not-started', message: "Claude Code could not be started: the reviewer account's sign-in is busy." }
      }
      if (!release) return cancelled
      try {
        if (input.signal?.aborted) return cancelled
        deps.recordPreflight(profileId, env)
        let stdout = ''
        let overflow = false
        let errTail = ''
        const onChunk = (t: string, stream: 'stdout' | 'stderr') => {
          if (stream === 'stdout') {
            if (overflow) return
            stdout += t
            if (stdout.length > CLAUDE_REVIEW_MAX_STDOUT) { stdout = ''; overflow = true }
            return
          }
          // Only the tail is reported; it is redacted on a window far wider
          // than the tail, so a secret cut at the window's start never shows.
          errTail += t
          if (errTail.length > WINDOW + MARGIN) errTail = errTail.slice(-(WINDOW + MARGIN))
        }
        const r = await deps.run(
          { ...cmd, cwd: input.cwd },
          { env, timeoutMs: input.timeoutMs, stdin: input.prompt, maxOutput: RUNNER_CAPTURE, onChunk, ...(input.signal ? { signal: input.signal } : {}) },
        )
        const out = overflow ? null : parseClaudeResult(stdout)
        const usage = out?.usage ? { usage: out.usage } : {}
        if (r.stopped === 'cancel' || input.signal?.aborted) return { ...cancelled, ...usage }
        if (r.timedOut || r.stopped === 'deadline') return { ok: false, code: 'timed-out', message: 'The review timed out.', ...usage }
        if (r.spawnError) return { ok: false, code: 'not-started', message: `Claude Code could not be started: ${clip(redactHead(r.spawnError, redactFailure))}.` }
        if (overflow) return { ok: false, code: 'no-output', message: `Claude Code printed more than this app reads (${CLAUDE_REVIEW_MAX_STDOUT / (1024 * 1024)} MB).` }
        if (!out) {
          if (r.exitCode === 0) return { ok: false, code: 'no-output', message: 'Claude Code returned no review.' }
          const detail = redactFailure(errTail).trim().slice(-MAX_MESSAGE)
          return { ok: false, code: 'failed', message: `Claude Code exited with code ${r.exitCode}${detail ? `: ${detail}` : ''}.` }
        }
        if (out.text === null) return { ok: false, code: 'failed', message: `Claude Code could not review: ${clip(redactHead(out.error ?? '', redactFailure))}.`, ...usage }
        if (!out.text.trim()) return { ok: false, code: 'no-output', message: 'Claude Code returned no review.', ...usage }
        return { ok: true, text: finishReview(out.text), ...usage }
      } finally {
        release()
      }
    },
  }
}
