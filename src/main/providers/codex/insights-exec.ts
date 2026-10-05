// WP2 PR 4, P4.7 (row 68): the one model run of a Codex Insights report (and
// of a cross-account roll-up's written analysis when it runs on Codex).
//
// The form of Sentinel's text-only Codex analysis (P3.9; cli-runner.ts,
// `analysis`), as its own constant argv (`insights`): `codex exec --json`,
// read-only, no tool that runs a command, browses or connects anything, web
// search off, none of the account's config, rules or AGENTS.md, no `-m`
// (Codex's default model for the account). The one change from that form:
// no `--ephemeral` (mockup D13): the run is kept, so its cost reaches
// Tokenomics on the account. The instructions and all the material go on
// stdin; no path rides the argv (completion plan 9.6 item 20): the caller
// runs it in an empty folder it made for the run, never a project or the
// sessions folder (9.6 item 22). From a launch the accounts service
// prepared, which holds the account's lease until the caller lets go.
//
// The environment is the reviewer's (reviewerEnv). The JSONL stream is read
// as it arrives (review.ts); the last agent message is the reply. As
// Sentinel's analysis, a Codex that says it is waiting for the network is
// stopped then, so the page says so within a minute, not at the deadline.
import { reviewerEnv, redactFailure as redact, redactHead, clip, WINDOW, MARGIN, MAX_MESSAGE } from '../review-support'
import { codexCommandLine, codexShellEnv, runCodexCli } from './cli-runner'
import type { CodexRunDeps } from './cli-runner'
import { createCodexExecEventReader, codexWaitingForNetwork, CODEX_EXEC_EXIT_SETTLE_MS } from './review'
import type { ReviewUsage, ProviderInsightsOperations } from '../core'

/** A report run's deadline, as Claude's report steps have (10 minutes). */
export const CODEX_INSIGHTS_TIMEOUT_MS = 600_000

/** stdout is read as it streams: the runner's head-capped capture is not used. */
const INSIGHTS_MAX_CAPTURE = 64 * 1024

export interface CodexInsightsExecInput {
  /** From the prepared launch: the executable setup proved. */
  executable: string
  /** From the prepared launch: the realm's environment. */
  env: Readonly<Record<string, string>>
  /** The empty folder made for this run. */
  cwd: string
  /** The instructions and the material, handed over on stdin. */
  prompt: string
  timeoutMs?: number
  signal?: AbortSignal
}

export type CodexInsightsExecResult =
  | { ok: true; text: string; usage?: ReviewUsage }
  | { ok: false; code: 'not-started' | 'failed' | 'timed-out' | 'cancelled' | 'no-output'; message: string; usage?: ReviewUsage; killSettled?: Promise<void> }

/** Runs the report's model run (see the module comment). Never throws. */
export async function runCodexInsightsExec(input: CodexInsightsExecInput, deps: { platform?: NodeJS.Platform; runDeps?: () => CodexRunDeps } = {}): Promise<CodexInsightsExecResult> {
  try {
    const platform = deps.platform ?? process.platform
    const env = reviewerEnv(input.env, platform)
    const cmd = codexCommandLine(input.executable, 'insights', platform, codexShellEnv(env, platform))
    if ('refused' in cmd) return { ok: false, code: 'not-started', message: `Codex could not be started: ${cmd.refused}.` }
    // cmd.exe cannot use a network path as its current directory.
    if (platform === 'win32' && cmd.verbatim && /^[\\/]{2}/.test(input.cwd)) {
      return { ok: false, code: 'not-started', message: 'Codex could not be started: the report folder is on a network path.' }
    }
    const waiting = { ac: new AbortController(), message: null as string | null, streaming: true, completed: false }
    const reader = createCodexExecEventReader({
      onError: (m) => {
        if (!waiting.streaming || waiting.completed || waiting.message !== null || !codexWaitingForNetwork(m)) return
        waiting.message = m
        waiting.ac.abort()
      },
      onTurnCompleted: () => { waiting.completed = true },
    })
    const signal = input.signal ? AbortSignal.any([input.signal, waiting.ac.signal]) : waiting.ac.signal
    let errTail = ''
    let errCut = false
    const onChunk = (t: string, stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') { reader.push(t); return }
      errTail += t
      if (errTail.length > WINDOW + MARGIN) { errTail = errTail.slice(-(WINDOW + MARGIN)); errCut = true }
    }
    const timeoutMs = input.timeoutMs ?? CODEX_INSIGHTS_TIMEOUT_MS
    const r = await runCodexCli(
      { ...cmd, cwd: input.cwd },
      { env, timeoutMs, stdin: input.prompt, maxOutput: INSIGHTS_MAX_CAPTURE, onChunk, settleAfterExitMs: CODEX_EXEC_EXIT_SETTLE_MS, killScope: 'tree', signal },
      ...(deps.runDeps ? [deps.runDeps()] : []),
    )
    waiting.streaming = false
    const out = reader.end()
    const usage = out.usage ? { usage: out.usage } : {}
    const kill = r.killSettled ? { killSettled: r.killSettled } : {}
    if (waiting.message !== null && !input.signal?.aborted) {
      return { ok: false, code: 'failed', message: `Codex could not reach its model: ${clip(redactHead(waiting.message, redact))}.`, ...usage, ...kill }
    }
    if (r.stopped === 'cancel' || input.signal?.aborted) return { ok: false, code: 'cancelled', message: 'The report was cancelled.', ...usage, ...kill }
    if (r.timedOut || r.stopped === 'deadline') return { ok: false, code: 'timed-out', message: `Codex did not finish the report within ${Math.round(timeoutMs / 1000)}s.`, ...usage, ...kill }
    if (r.spawnError) return { ok: false, code: 'not-started', message: `Codex could not be started: ${clip(redactHead(r.spawnError, redact))}.` }
    if (r.exitCode !== 0) {
      const stderr = (errCut ? redact(errTail).slice(MARGIN) : redact(errTail)).trim()
      const detail = out.error !== undefined ? clip(redactHead(out.error, redact)) : stderr.slice(-MAX_MESSAGE)
      return { ok: false, code: 'failed', message: `Codex exited with code ${r.exitCode}${detail ? `: ${detail}` : ''}.`, ...usage }
    }
    if (out.text === null || !out.text.trim()) {
      const why = out.error !== undefined ? clip(redactHead(out.error, redact)) : 'Codex returned no reply.'
      return { ok: false, code: 'no-output', message: why, ...usage }
    }
    return { ok: true, text: out.text, ...usage }
  } catch {
    return { ok: false, code: 'not-started', message: 'Codex could not be started.' }
  }
}

/** The package's Insights port (P4.7): the report run above, under its own
 *  deadline (CODEX_INSIGHTS_TIMEOUT_MS). The runner reaches it through the
 *  registered package, never by importing this module. */
export function createCodexInsightsOperations(deps: { platform?: NodeJS.Platform; runDeps?: () => CodexRunDeps } = {}): ProviderInsightsOperations {
  return {
    run: (input) => runCodexInsightsExec({ executable: input.executable, env: input.env, cwd: input.cwd, prompt: input.prompt, ...(input.signal ? { signal: input.signal } : {}) }, deps),
  }
}
