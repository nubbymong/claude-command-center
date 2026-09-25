// WP2 commit 5a (plan: provider review through MCP): Codex as a reviewer.
// One isolated, non-interactive `codex exec` per review, run from a launch
// the accounts service prepared (kind `review`): the executable setup proved,
// the realm's environment (ambient credentials removed, CODEX_HOME set), in
// the reviewed project, read-only sandbox, nothing persisted. The prompt goes
// on stdin -- never argv, never a shell -- so no text in it is re-read by
// cmd.exe. The run goes through the CLI runner: no shell, the whole chain
// killed on a deadline or a cancel.
//
// Output contract of the pinned CLI (openai/codex rust-v0.155.1,
// codex-rs/exec/src/exec_events.rs): JSONL on stdout, one ThreadEvent per
// line -- `item.completed` whose item is `agent_message` carries the reply
// text; `turn.completed` carries `usage`; `turn.failed` / `error` carry a
// message. The stream is read as it arrives (command output rides in item
// events and can be large), so no output cap can cut the reply off.
import type { ProviderReviewOperations, ReviewRunInput, ReviewRunResult, ReviewUsage } from '../core'
import { reviewerEnv, finishReview, redactFailure as redact, redactHead, clip, WINDOW, MARGIN, MAX_MESSAGE, REVIEW_MAX_TEXT } from '../review-support'
import { codexCommandLine, codexShellEnv, runCodexCli } from './cli-runner'
import type { CodexRunDeps } from './cli-runner'

/** stdout is read as it streams and stderr's tail is kept as it streams:
 *  the runner's own head-capped capture is not used. */
const REVIEW_MAX_CAPTURE = 64 * 1024
/** One JSONL event longer than this is skipped (a huge command output). */
const MAX_EVENT_LINE = 8 * 1024 * 1024

export interface CodexExecOutcome {
  text: string | null
  usage?: ReviewUsage
  error?: string
  /** An event longer than the reader keeps was skipped. */
  dropped?: true
}

/** The reply cap, kept exported here for the package's existing consumers. */
export { REVIEW_MAX_TEXT }

/** Reads the pinned CLI's `exec --json` stream as it arrives. The last agent
 *  message is the review; usage is summed over completed turns; a failed
 *  turn or an error event is kept as the error. Lines that are not JSON, or
 *  not these events, are ignored. Memory is bounded by one event line. */
export function createCodexExecEventReader(): { push(chunk: string): void; end(): CodexExecOutcome } {
  let text: string | null = null
  let usage: ReviewUsage | undefined
  let error: string | undefined
  let partial = ''
  let skipping = false
  let dropped = false
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const line = (raw: string) => {
    const l = raw.trim()
    if (!l.startsWith('{')) return
    let ev: unknown
    try { ev = JSON.parse(l) } catch { return }
    if (!ev || typeof ev !== 'object') return
    const e = ev as Record<string, unknown>
    if (e.type === 'item.completed') {
      const item = e.item as Record<string, unknown> | undefined
      if (item && item.type === 'agent_message' && typeof item.text === 'string') text = item.text
    } else if (e.type === 'turn.completed') {
      const u = (e.usage ?? {}) as Record<string, unknown>
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + num(u.input_tokens),
        cachedInputTokens: (usage?.cachedInputTokens ?? 0) + num(u.cached_input_tokens),
        outputTokens: (usage?.outputTokens ?? 0) + num(u.output_tokens),
      }
    } else if (e.type === 'turn.failed') {
      const err = e.error as Record<string, unknown> | undefined
      if (err && typeof err.message === 'string') error = err.message
    } else if (e.type === 'error') {
      if (typeof e.message === 'string') error = e.message
    }
  }
  return {
    push(chunk: string) {
      let start = 0
      for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', start)) {
        if (skipping) skipping = false
        else line(partial + chunk.slice(start, nl))
        partial = ''
        start = nl + 1
      }
      if (skipping) return
      partial += chunk.slice(start)
      if (partial.length > MAX_EVENT_LINE) { partial = ''; skipping = true; dropped = true }
    },
    end() {
      if (!skipping && partial) line(partial)
      partial = ''
      return { text, ...(usage ? { usage } : {}), ...(error !== undefined ? { error } : {}), ...(dropped ? { dropped: true as const } : {}) }
    },
  }
}

/** The whole stream at once (tests, and any caller that already holds it). */
export function parseCodexExecEvents(stdout: string): CodexExecOutcome {
  const reader = createCodexExecEventReader()
  reader.push(stdout)
  return reader.end()
}

export function createCodexReviewOperations(deps: { platform?: NodeJS.Platform; runDeps?: () => CodexRunDeps } = {}): ProviderReviewOperations {
  const platform = deps.platform ?? process.platform
  return {
    async run(input: ReviewRunInput): Promise<ReviewRunResult> {
      const win32 = platform === 'win32'
      const env = reviewerEnv(input.env, platform)
      const cmd = codexCommandLine(input.executable, 'review', platform, codexShellEnv(env, platform))
      if ('refused' in cmd) return { ok: false, code: 'not-started', message: `Codex could not be started: ${cmd.refused}.` }
      // cmd.exe cannot use a network path as its current directory: it would
      // start the shim in the Windows folder and Codex would review that.
      if (win32 && cmd.verbatim && /^[\\/]{2}/.test(input.cwd)) {
        return { ok: false, code: 'not-started', message: 'Codex review cannot run an npm-installed Codex in a project on a network path (cmd.exe would start it in the Windows folder, not the project). Use a project on a local drive, or the standalone Codex executable.' }
      }
      const reader = createCodexExecEventReader()
      let errTail = ''
      let errCut = false
      const onChunk = (t: string, stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout') { reader.push(t); return }
        errTail += t
        if (errTail.length > WINDOW + MARGIN) { errTail = errTail.slice(-(WINDOW + MARGIN)); errCut = true }
      }
      const r = await runCodexCli(
        { ...cmd, cwd: input.cwd },
        { env, timeoutMs: input.timeoutMs, stdin: input.prompt, maxOutput: REVIEW_MAX_CAPTURE, onChunk, ...(input.signal ? { signal: input.signal } : {}) },
        ...(deps.runDeps ? [deps.runDeps()] : []),
      )
      const out = reader.end()
      const usage = out.usage ? { usage: out.usage } : {}
      if (r.stopped === 'cancel' || input.signal?.aborted) return { ok: false, code: 'cancelled', message: 'The review was cancelled.', ...usage }
      if (r.timedOut || r.stopped === 'deadline') return { ok: false, code: 'timed-out', message: 'The review timed out.', ...usage }
      if (r.spawnError) return { ok: false, code: 'not-started', message: `Codex could not be started: ${clip(redactHead(r.spawnError, redact))}.` }
      if (r.exitCode !== 0) {
        const stderr = (errCut ? redact(errTail).slice(MARGIN) : redact(errTail)).trim()
        const detail = out.error !== undefined ? clip(redactHead(out.error, redact)) : stderr.slice(-MAX_MESSAGE)
        return { ok: false, code: 'failed', message: `Codex exited with code ${r.exitCode}${detail ? `: ${detail}` : ''}.`, ...usage }
      }
      if (out.text === null || !out.text.trim()) {
        const why = out.error !== undefined ? clip(redactHead(out.error, redact)) : out.dropped ? 'Codex printed an event larger than this app reads, and no review after it.' : 'Codex returned no review.'
        return { ok: false, code: 'no-output', message: why, ...usage }
      }
      return { ok: true, text: finishReview(out.text), ...usage }
    },
  }
}
