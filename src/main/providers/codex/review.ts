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
import { ANALYSIS_UNREACHABLE_WORDS } from '../../../shared/sentinel-analysis-contract'

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

/** What a reader tells its caller as the stream arrives (WP2 PR 4, P4.5: a
 *  Cloud Agent shows each reply as it completes). A hook that throws never
 *  breaks the reader. */
export interface CodexExecEventHooks {
  /** Each completed agent message's text, in order. */
  onAgentMessage?: (text: string) => void
  /** PR 4: each error event's message, in order (Codex's reconnects among them). */
  onError?: (message: string) => void
  /** PR 4 (owner answers review): each completed turn, as it completes. */
  onTurnCompleted?: () => void
}

/** PR 4 (owner answers, the Sentinel chase): Codex's own words once it has
 *  given up reaching its model and waits for the network to come back. On
 *  the Windows test VM (0.153.4 and 0.155.1, every proxy a dead port) it
 *  reconnected five times over WebSockets, fell back to HTTPS, and from 33.8 s
 *  said "Reconnecting... waiting for network (...)" every 20 s or so without
 *  end. Its reconnects before that are not the signal: the HTTPS fallback
 *  follows them, and may work where WebSockets do not. */
export function codexWaitingForNetwork(message: string): boolean {
  return /\bwaiting for network\b/i.test(message)
}

/** How an analysis that ended that way begins its message. Sentinel reads
 *  ANALYSIS_UNREACHABLE_WORDS in it to report the failure as unreachable and
 *  not try again, so the words come from that one shared source. */
export const CODEX_UNREACHABLE_PREFIX = `Codex ${ANALYSIS_UNREACHABLE_WORDS} its model`

/** Reads the pinned CLI's `exec --json` stream as it arrives. The last agent
 *  message is the review; usage is summed over completed turns; a failed
 *  turn or an error event is kept as the error. Lines that are not JSON, or
 *  not these events, are ignored. Memory is bounded by one event line. */
export function createCodexExecEventReader(hooks: CodexExecEventHooks = {}): { push(chunk: string): void; end(): CodexExecOutcome } {
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
      if (item && item.type === 'agent_message' && typeof item.text === 'string') {
        text = item.text
        if (hooks.onAgentMessage) { try { hooks.onAgentMessage(item.text) } catch { /* a hook never breaks the reader */ } }
      }
    } else if (e.type === 'turn.completed') {
      const u = (e.usage ?? {}) as Record<string, unknown>
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + num(u.input_tokens),
        cachedInputTokens: (usage?.cachedInputTokens ?? 0) + num(u.cached_input_tokens),
        outputTokens: (usage?.outputTokens ?? 0) + num(u.output_tokens),
      }
      if (hooks.onTurnCompleted) { try { hooks.onTurnCompleted() } catch { /* a hook never breaks the reader */ } }
    } else if (e.type === 'turn.failed') {
      const err = e.error as Record<string, unknown> | undefined
      if (err && typeof err.message === 'string') error = err.message
    } else if (e.type === 'error') {
      if (typeof e.message === 'string') {
        error = e.message
        if (hooks.onError) { try { hooks.onError(e.message) } catch { /* a hook never breaks the reader */ } }
      }
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

/** How long an exec run waits for its output pipes to close after codex
 *  has exited (P3.9 round 2): the last lines arrive well inside it. */
export const CODEX_EXEC_EXIT_SETTLE_MS = 2_000

export function createCodexReviewOperations(deps: { platform?: NodeJS.Platform; runDeps?: () => CodexRunDeps } = {}): ProviderReviewOperations {
  const platform = deps.platform ?? process.platform
  return {
    async run(input: ReviewRunInput): Promise<ReviewRunResult> {
      const win32 = platform === 'win32'
      const env = reviewerEnv(input.env, platform)
      // P3.9 round 1: a text-only analysis runs its own constant argv (no
      // tools, no instructions from the folder; cli-runner.ts, `analysis`).
      const cmd = codexCommandLine(input.executable, input.purpose === 'analysis' ? 'analysis' : 'review', platform, codexShellEnv(env, platform))
      if ('refused' in cmd) return { ok: false, code: 'not-started', message: `Codex could not be started: ${cmd.refused}.` }
      // cmd.exe cannot use a network path as its current directory: it would
      // start the shim in the Windows folder and Codex would review that.
      if (win32 && cmd.verbatim && /^[\\/]{2}/.test(input.cwd)) {
        return { ok: false, code: 'not-started', message: 'Codex review cannot run an npm-installed Codex in a project on a network path (cmd.exe would start it in the Windows folder, not the project). Use a project on a local drive, or the standalone Codex executable.' }
      }
      // PR 4 (owner answers, the Sentinel chase): an analysis whose Codex says
      // it is waiting for the network is stopped then (its run's tree, as a
      // cancel), so Sentinel says so within a minute instead of at the
      // deadline. A review keeps its deadline. Only while the run is still
      // streaming and no turn has completed: a reply already finished is kept,
      // and a line read after the run ended changes nothing.
      const unreachable = input.purpose === 'analysis' ? { ac: new AbortController(), message: null as string | null, streaming: true, completed: false } : null
      const reader = createCodexExecEventReader(unreachable ? {
        onError: (m) => {
          if (!unreachable.streaming || unreachable.completed || unreachable.message !== null || !codexWaitingForNetwork(m)) return
          unreachable.message = m
          unreachable.ac.abort()
        },
        onTurnCompleted: () => { unreachable.completed = true },
      } : {})
      const signal = unreachable ? (input.signal ? AbortSignal.any([input.signal, unreachable.ac.signal]) : unreachable.ac.signal) : input.signal
      let errTail = ''
      let errCut = false
      const onChunk = (t: string, stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout') { reader.push(t); return }
        errTail += t
        if (errTail.length > WINDOW + MARGIN) { errTail = errTail.slice(-(WINDOW + MARGIN)); errCut = true }
      }
      const r = await runCodexCli(
        { ...cmd, cwd: input.cwd },
        // P3.9 round 2: settle soon after codex exits, even while a process it
        // started still holds the output pipes, and a stop takes everything
        // below the root (an exec run starts no program of the user's).
        { env, timeoutMs: input.timeoutMs, stdin: input.prompt, maxOutput: REVIEW_MAX_CAPTURE, onChunk, settleAfterExitMs: CODEX_EXEC_EXIT_SETTLE_MS, killScope: 'tree', ...(signal ? { signal } : {}) },
        ...(deps.runDeps ? [deps.runDeps()] : []),
      )
      if (unreachable) unreachable.streaming = false
      const out = reader.end()
      const usage = out.usage ? { usage: out.usage } : {}
      // Only a stopped run can carry one: the lease is held until it ends.
      const kill = r.killSettled ? { killSettled: r.killSettled } : {}
      if (unreachable?.message != null && !input.signal?.aborted) {
        return { ok: false, code: 'failed', message: `${CODEX_UNREACHABLE_PREFIX}: ${clip(redactHead(unreachable.message, redact))}.`, ...usage, ...kill }
      }
      if (r.stopped === 'cancel' || input.signal?.aborted) return { ok: false, code: 'cancelled', message: 'The review was cancelled.', ...usage, ...kill }
      if (r.timedOut || r.stopped === 'deadline') return { ok: false, code: 'timed-out', message: 'The review timed out.', ...usage, ...kill }
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
