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
import { codexCommandLine, codexShellEnv, runCodexCli } from './cli-runner'
import type { CodexRunDeps } from './cli-runner'
import { redactSecrets } from '../../hooks/hook-payload-redactor'
import { redactTokens } from '../../github/security/token-redactor'

/** Credential shapes removed from the review itself. Case-sensitive and
 *  token-shaped (a digit, a length), so prose about "basic validation" or a
 *  call to `rt_sigprocmask` is left alone. Quantifiers are bounded. */
const CREDENTIALS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-(?=[A-Za-z_-]{0,512}[0-9])[A-Za-z0-9_-]{20,512}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])(?:gh[pousri]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g, '[REDACTED]'],
  [/\bxox[bpsar]-[A-Za-z0-9-]{10,256}/g, '[REDACTED]'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]'],
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, '[REDACTED]'],
  [/\b(Bearer|Basic) (?=[A-Za-z._~+/=-]{0,4096}[0-9])[A-Za-z0-9._~+/=-]{16,4096}/g, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{6,4096}\.eyJ[A-Za-z0-9_-]{6,4096}(?:\.[A-Za-z0-9_-]{0,4096})?/g, '[REDACTED]'],
  [/\brt_(?=[A-Za-z._-]{0,512}[0-9])[A-Za-z0-9._-]{20,512}/g, '[REDACTED]'],
  [/("(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|OPENAI_API_KEY)"\s*:\s*)"[^"]{0,8192}"/gi, '$1"[REDACTED]"'],
]
/** Failure text only (a review discusses code, where these shapes are
 *  ordinary): looser key and header forms, any secret-named field's value,
 *  and long hex keys. */
const FAILURE_ONLY: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,512}/g, '[REDACTED]'],
  [/\brt_[A-Za-z0-9._-]{8,512}/g, '[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,4096}/gi, '$1 [REDACTED]'],
  [/("?(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password|secret|token)"?\s*[:=]\s*)("[^"]{0,8192}"|[^\s,;}]{1,8192})/gi, '$1[REDACTED]'],
  [/\b[0-9a-f]{32,512}\b/gi, '[REDACTED]'],
]
const scrub = (s: string, set: ReadonlyArray<[RegExp, string]>) => set.reduce((t, [re, to]) => t.replace(re, to), s)
/** The review goes to another agent: a credential it quotes does not. */
const redactReply = (s: string) => scrub(s, CREDENTIALS)
/** Anything else the CLI printed goes back redacted whole, before it is
 *  shortened, so a cut never splits a secret. */
const redact = (s: string) => scrub(scrub(redactTokens(redactSecrets(s)), CREDENTIALS), FAILURE_ONLY)
const MAX_MESSAGE = 500
const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)} [...]` : s)

/** Redaction reads a bounded window, never megabytes. Where the window cuts
 *  the text, MARGIN characters next to the cut are dropped after redacting:
 *  a secret the cut split is not matched, and none is that long (the longest
 *  shape, a private key block, is bounded at 16 KiB). */
const WINDOW = 64 * 1024
const MARGIN = 20 * 1024
function redactHead(s: string, redactor: (s: string) => string): string {
  return s.length <= WINDOW + MARGIN ? redactor(s) : redactor(s.slice(0, WINDOW + MARGIN)).slice(0, -MARGIN)
}
function redactTail(s: string, redactor: (s: string) => string, keep = WINDOW): string {
  return s.length <= keep + MARGIN ? redactor(s) : redactor(s.slice(-(keep + MARGIN))).slice(MARGIN)
}

/** stdout is read as it streams and stderr's tail is kept as it streams:
 *  the runner's own head-capped capture is not used. */
const REVIEW_MAX_CAPTURE = 64 * 1024
/** One JSONL event longer than this is skipped (a huge command output). */
const MAX_EVENT_LINE = 8 * 1024 * 1024
/** The reply is capped for the MCP result (the tail is the conclusion). */
export const REVIEW_MAX_TEXT = 50 * 1024

/** Variables a reviewer never inherits, in any spelling on Windows: every
 *  Conductor variable of the REQUESTING session or the app (its MCP bearer,
 *  session id, status URL, worktree...). Depth one -- a reviewer must not
 *  reach the Conductor tools, and no per-spawn MCP flags are passed to it. */
const DEPTH_GUARD_PREFIXES = ['CCC_', 'CONDUCTOR_', 'CLAUDE_MULTI_']

export interface CodexExecOutcome {
  text: string | null
  usage?: ReviewUsage
  error?: string
  /** An event longer than the reader keeps was skipped. */
  dropped?: true
}

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
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(input.env ?? {})) {
        if (typeof v !== 'string') continue
        const name = win32 ? k.toUpperCase() : k
        if (DEPTH_GUARD_PREFIXES.some((p) => name.startsWith(p))) continue
        env[k] = v
      }
      // Only absolute PATH entries reach the reviewer, and cmd.exe (a .cmd
      // shim) does not search its current directory before PATH.
      for (const k of Object.keys(env)) {
        if ((win32 ? k.toUpperCase() : k) !== 'PATH') continue
        const sep = win32 ? ';' : ':'
        env[k] = env[k].split(sep).filter((p) => (win32 ? /^"?([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p) : p.startsWith('/'))).join(sep)
      }
      if (win32) {
        for (const k of Object.keys(env)) if (k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') delete env[k]
        env.NoDefaultCurrentDirectoryInExePath = '1'
      }
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
      if (out.text.length <= REVIEW_MAX_TEXT) return { ok: true, text: redactReply(out.text), ...usage }
      const tail = redactTail(out.text, redactReply, REVIEW_MAX_TEXT).slice(-REVIEW_MAX_TEXT)
      return { ok: true, text: `[review truncated -- it exceeded ${REVIEW_MAX_TEXT / 1024} KB]\n\n${tail}`, ...usage }
    },
  }
}
