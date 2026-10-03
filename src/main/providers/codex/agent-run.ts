// WP2 PR 4, P4.5 (row 57): a Cloud Agent on Codex. One non-interactive
// `codex exec` per agent run, from a launch the accounts service prepared
// (kind `background`): the executable setup proved and the realm's
// environment (ambient credentials removed, CODEX_HOME set). It goes through
// the CLI runner: no shell, the task on stdin (never argv), and on a stop the
// whole tree below codex ends (the model's commands are the agent's own
// work, as a Claude agent's are ended with it).
//
// The argv (VM probe PB5, on both supported versions and both install
// routes):
//   exec --json [-m <model>] [-c model_reasoning_effort=<effort>] -s <level> --skip-git-repo-check -
// No path rides it: the project is the working folder, as the reviewer's run
// is (review.ts), and a project on a network path is refused on the npm
// `.cmd` route, where cmd.exe would start in the Windows folder instead.
// Every element passes the runner's own rule for an argv element
// (cliCommandLine, PLAIN_ARG); the model and the effort are held to the
// launch's own rules here first. `-m` and the effort come from the config the
// agent was started from, as an interactive launch passes them: absent (or
// effort 'none'), Codex's own default. Not `--ephemeral`: the conversation is
// kept, as Claude's agent keeps its transcript. Not `--ignore-user-config`:
// it drops the account's own settings, and did not stop the write below.
// `--skip-git-repo-check`: a project that is not a git repository otherwise
// exits 1 before any request.
//
// Permissions (section 10, question 7, built as its default A): the default
// runs `-s read-only`; the dialog's per-run skip-permissions choice runs as
// Codex's Auto preset, `-s workspace-write` (exec asks nothing, and the agent
// can change files only inside its project). Never danger-full-access, and
// never a flag that bypasses the sandbox: under danger-full-access Codex
// wrote the project's trust entry into the account's config.toml on every
// run (PB5), and a background run changes none of the account's settings.
// On Windows, Codex makes no edits under workspace-write until its sandbox is
// set up for the account (PB5), and under the non-admin sandbox PowerShell
// does not start (PB8). A refused edit exits 0 with the refusal only on
// stderr and in the reply, so stderr is handed on with the output: whole
// lines, redacted as a failure message is, since what is handed on is kept
// in the agent's record and shown.
//
// The environment is the reviewer's (reviewerEnv: no Conductor variable, only
// absolute PATH entries, and on Windows a cmd.exe that does not look in the
// project for a program before PATH -- an npm shim starts in the project
// here), less what the CLI-operation allowlist leaves out because verbose
// logs can print secrets (CODEX_AGENT_DROPPED_ENV).
//
// Usage is summed over the run's `turn.completed` events. A run here is
// always a fresh `exec`, never `exec resume`, so P3.1 answer 9's version
// difference (0.155.1 reports the whole conversation after a resume) does not
// arise.
import path from 'node:path'
import type { BackgroundRunInput, BackgroundRunResult, ProviderBackgroundOperations } from '../core'
import { reviewerEnv, redactFailure as redact, redactHead, clip, WINDOW, MARGIN, MAX_MESSAGE } from '../review-support'
import { cliCommandLine, codexShellEnv, runCodexCli } from './cli-runner'
import type { CodexCommand, CodexRunDeps } from './cli-runner'
import { createCodexExecEventReader, CODEX_EXEC_EXIT_SETTLE_MS } from './review'
import { computeCodexCostUsd } from './pricing'
import { isCodexModelId } from '../../../shared/model-registry'

/** The two sandboxes an agent runs in. Never danger-full-access. */
export type CodexAgentSandbox = 'read-only' | 'workspace-write'

/** The reasoning efforts a run passes on: the CLI's own values (the launch's
 *  CODEX_EFFORTS) less 'none', which means "no override" to every launch. */
export const CODEX_AGENT_EFFORTS: readonly string[] = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/** No deadline, as a Claude agent has none: the runner's longest. */
export const CODEX_AGENT_TIMEOUT_MS = 2_147_483_647

/** stdout is read as it streams and stderr is handed on as it streams: the
 *  runner's own head-capped capture is not used. */
const AGENT_MAX_CAPTURE = 64 * 1024

/** Variables an agent run never inherits, beyond reviewerEnv's rule: those
 *  the CLI-operation allowlist (cli-env.ts) leaves out because verbose logs
 *  can print secrets. Any spelling on Windows, the exact name elsewhere. */
export const CODEX_AGENT_DROPPED_ENV: readonly string[] = Object.freeze(['RUST_LOG'])

/** The environment one agent run starts with (see the module comment). */
export function codexAgentEnv(source: Readonly<Record<string, string>> | undefined, platform: NodeJS.Platform): Record<string, string> {
  const env = reviewerEnv(source, platform)
  for (const k of Object.keys(env)) {
    if (CODEX_AGENT_DROPPED_ENV.includes(platform === 'win32' ? k.toUpperCase() : k)) delete env[k]
  }
  return env
}

/** A private key block's first and last lines, as the redactor matches the
 *  block whole. */
const KEY_EDGE = /-----(BEGIN|END) [A-Z ]{0,40}PRIVATE KEY-----/g

/** Where a private key block that has not ended starts in `s`, or -1. */
function openKeyBlock(s: string): number {
  let open = -1
  for (const m of s.matchAll(KEY_EDGE)) open = m[1] === 'BEGIN' ? (open < 0 ? m.index ?? -1 : open) : -1
  return open
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_-]/.test(ch)

/** The names of the fields the redactor clears the value of (as a suffix:
 *  access_token, client_secret, an API key's name). */
const SECRET_FIELD = /(?:password|secret|token|api[_-]?key)$/i

/** Where `s` up to `end` (whitespace before `end` set aside) ends in a
 *  Bearer or Basic word, or in a secret field's name with its quote and
 *  separator: the start of that word or name (its opening quote included),
 *  else -1. What comes next may be its credential, which the redactor
 *  matches only together with it. Reads of fixed size, plus the whitespace
 *  before `end` and before a separator. */
function secretTailStart(s: string, end: number): number {
  let e = end
  while (e > 0 && isSpace(s[e - 1])) e--
  const word = /(?:^|[^A-Za-z0-9_])(bearer|basic)$/i.exec(s.slice(Math.max(0, e - 7), e))
  if (word) return e - word[1].length
  let f = e
  if (s[f - 1] === ':' || s[f - 1] === '=') { f--; while (f > 0 && isSpace(s[f - 1])) f-- }
  if (s[f - 1] === '"' || s[f - 1] === "'") f--
  const field = SECRET_FIELD.exec(s.slice(Math.max(0, f - 16), f))
  if (!field) return -1
  let start = f - field[0].length
  for (let k = 0; k < 64 && start > 0 && isWordChar(s[start - 1]); k++) start--
  if (s[start - 1] === '"' || s[start - 1] === "'") start--
  return start
}

/** Where a line not ended within WINDOW may be cut: just after its last run
 *  of whitespace that does not follow a Bearer or Basic, or a secret field's
 *  name or separator, else 0. One backward pass over `s` (each character
 *  looked at at most twice, the text before a run read in fixed-size
 *  pieces), so linear in its length. */
function cutAtSpace(s: string): number {
  let i = s.length - 1
  while (i >= 0) {
    if (!isSpace(s[i])) { i--; continue }
    let j = i
    while (j > 0 && isSpace(s[j - 1])) j--
    if (secretTailStart(s, j) < 0) return i + 1
    i = j - 1
  }
  return 0
}

/** Whether a line ends in a secret field's name and its separator (`:` or
 *  `=`), a quote and whitespace allowed between: its value may start the
 *  next line. Trims and fixed-size reads only: linear in the line. */
function endsWithSecretField(line: string): boolean {
  let s = line.trimEnd()
  if (!s.endsWith(':') && !s.endsWith('=')) return false
  s = s.slice(0, -1).trimEnd()
  if (s.endsWith('"') || s.endsWith("'")) s = s.slice(0, -1)
  return SECRET_FIELD.test(s.slice(-16))
}

/** stderr as it is handed on: whole lines, each batch redacted as the
 *  failure message is (review-support's redactFailure), so a credential a
 *  pipe chunk split is still matched whole. A last line that ends in a
 *  secret field's name and separator is held until the next line arrives
 *  (its value may start it, and the redactor matches the two together); a
 *  private key block until its last line; each hold up to MARGIN (past the
 *  redactor's own bound for a key block). A line not ended within WINDOW
 *  goes at its last space (never right after a Bearer or Basic or a secret
 *  field), or with none, up to a Bearer, Basic or secret field at its end.
 *  What is left goes at `end`. Every step is linear in what is pending. */
function createDiagnosticStream(out: (text: string) => void): { push(t: string): void; end(): void } {
  let pending = ''
  const send = (n: number): void => {
    if (n <= 0) return
    const text = pending.slice(0, n)
    pending = pending.slice(n)
    out(redact(text))
  }
  return {
    push(t) {
      pending += t
      let cut = pending.lastIndexOf('\n') + 1
      if (cut > 0) {
        const last = pending.lastIndexOf('\n', cut - 2) + 1
        if (cut - last <= MARGIN && endsWithSecretField(pending.slice(last, cut))) cut = last
      }
      const open = openKeyBlock(pending.slice(0, cut))
      if (open >= 0 && pending.length - open <= MARGIN) cut = open
      else if (cut === 0 && pending.length > WINDOW) {
        cut = cutAtSpace(pending)
        // No such space: up to a credential's lead-in at the end, or one
        // followed by the start of a word (what may be the credential, cut
        // by the read), kept with what follows, up to MARGIN; else all of it.
        if (!cut) {
          let j = pending.length
          while (j > 0 && !isSpace(pending[j - 1])) j--
          const lastWord = j
          while (j > 0 && isSpace(pending[j - 1])) j--
          let lead = secretTailStart(pending, pending.length)
          if (lead < 0 && j > 0 && lastWord < pending.length) lead = secretTailStart(pending, j)
          cut = lead > 0 && pending.length - lead <= MARGIN ? lead : pending.length
        }
      }
      send(cut)
    },
    end() { send(pending.length) },
  }
}

/** Section 10, question 7, default A: the per-run skip-permissions choice
 *  runs as Codex's Auto sandbox; the default as read-only. */
export function codexAgentSandbox(skipPermissions: boolean): CodexAgentSandbox {
  return skipPermissions === true ? 'workspace-write' : 'read-only'
}

/** The argv of one agent run, or why there is none. */
export function codexAgentArgs(opts: { model?: unknown; effort?: unknown; sandbox: unknown }): string[] | { refused: string } {
  const model = opts.model === undefined || opts.model === '' ? undefined : opts.model
  if (model !== undefined && !isCodexModelId(model)) return { refused: 'the model is not one this app passes to Codex' }
  const effort = opts.effort === undefined || opts.effort === '' || opts.effort === 'none' ? undefined : opts.effort
  if (effort !== undefined && (typeof effort !== 'string' || !CODEX_AGENT_EFFORTS.includes(effort))) return { refused: 'the reasoning effort is not one Codex takes' }
  if (opts.sandbox !== 'read-only' && opts.sandbox !== 'workspace-write') return { refused: 'not a sandbox an agent runs in' }
  return [
    'exec', '--json',
    ...(model !== undefined ? ['-m', model as string] : []),
    ...(effort !== undefined ? ['-c', `model_reasoning_effort=${effort}`] : []),
    '-s', opts.sandbox, '--skip-git-repo-check', '-',
  ]
}

/** How to run one agent against one prepared executable, or why not. */
export function codexAgentCommandLine(
  executable: string,
  opts: { model?: unknown; effort?: unknown; sandbox: unknown },
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): CodexCommand | { refused: string } {
  const args = codexAgentArgs(opts)
  if (!Array.isArray(args)) return args
  return cliCommandLine(executable, args, platform, codexShellEnv(env, platform), 'Codex')
}

/** A drive or a share, never `\x` (the current drive's root), `\\?\` or `\\.\`;
 *  on POSIX, an absolute path. */
function absoluteProject(cwd: unknown, platform: NodeJS.Platform): cwd is string {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) return false
  if (platform === 'win32') return /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/?.])/.test(cwd)
  return path.posix.isAbsolute(cwd)
}

/** Hands text to a caller's callback: one that throws never breaks the run. */
function emit(fn: ((text: string) => void) | undefined, text: string): void {
  if (!fn || !text) return
  try { fn(text) } catch { /* the run goes on */ }
}

export function createCodexBackgroundOperations(deps: { platform?: NodeJS.Platform; runDeps?: () => CodexRunDeps } = {}): ProviderBackgroundOperations {
  const platform = deps.platform ?? process.platform
  return {
    async run(input: BackgroundRunInput): Promise<BackgroundRunResult> {
      const win32 = platform === 'win32'
      if (!absoluteProject(input.cwd, platform)) {
        return { ok: false, code: 'not-started', message: 'Codex could not be started: the project folder is not a full path.' }
      }
      if (typeof input.prompt !== 'string') return { ok: false, code: 'not-started', message: 'Codex could not be started: no task was given.' }
      const env = codexAgentEnv(input.env, platform)
      const cmd = codexAgentCommandLine(input.executable, { model: input.model, effort: input.effort, sandbox: codexAgentSandbox(input.skipPermissions === true) }, platform, env)
      if ('refused' in cmd) return { ok: false, code: 'not-started', message: `Codex could not be started: ${cmd.refused}.` }
      // cmd.exe cannot use a network path as its current directory: it would
      // start the shim in the Windows folder, and the agent would work there.
      if (win32 && cmd.verbatim && /^[\\/]{2}/.test(input.cwd)) {
        return { ok: false, code: 'not-started', message: 'An npm-installed Codex cannot run an agent in a project on a network path (cmd.exe would start it in the Windows folder, not the project). Use a project on a local drive, or the standalone Codex executable.' }
      }
      const reader = createCodexExecEventReader({ onAgentMessage: (t) => emit(input.onText, t) })
      const diagnostics = createDiagnosticStream((t) => emit(input.onDiagnostic, t))
      let errTail = ''
      let errCut = false
      const onChunk = (t: string, stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout') { reader.push(t); return }
        diagnostics.push(t)
        errTail += t
        if (errTail.length > WINDOW + MARGIN) { errTail = errTail.slice(-(WINDOW + MARGIN)); errCut = true }
      }
      const r = await runCodexCli(
        { ...cmd, cwd: input.cwd },
        // Settles soon after codex exits even while a process it started
        // still holds the output pipes; a stop takes everything below codex.
        { env, timeoutMs: CODEX_AGENT_TIMEOUT_MS, stdin: input.prompt, maxOutput: AGENT_MAX_CAPTURE, onChunk, settleAfterExitMs: CODEX_EXEC_EXIT_SETTLE_MS, killScope: 'tree', ...(input.signal ? { signal: input.signal } : {}) },
        ...(deps.runDeps ? [deps.runDeps()] : []),
      )
      diagnostics.end()
      const out = reader.end()
      const cost = out.usage && typeof input.model === 'string' && input.model ? computeCodexCostUsd(input.model, out.usage) : null
      const figures = { ...(out.usage ? { usage: out.usage } : {}), ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}) }
      // Only a stopped run can carry one: the lease is held until it ends.
      const kill = r.killSettled ? { killSettled: r.killSettled } : {}
      // Codex exited on its own, even if a stop came after (the settle
      // window): its own exit code stands, not the stop.
      const exitedOnItsOwn = typeof r.exitCode === 'number'
      if (!exitedOnItsOwn && (r.stopped === 'cancel' || input.signal?.aborted)) return { ok: false, code: 'cancelled', message: 'The agent was stopped.', ...figures, ...kill }
      if (!exitedOnItsOwn && (r.timedOut || r.stopped === 'deadline')) return { ok: false, code: 'failed', message: 'The agent ran past the longest run this app allows.', ...figures, ...kill }
      if (r.spawnError) return { ok: false, code: 'not-started', message: `Codex could not be started: ${clip(redactHead(r.spawnError, redact))}.` }
      if (r.exitCode !== 0) {
        const stderr = (errCut ? redact(errTail).slice(MARGIN) : redact(errTail)).trim()
        const detail = out.error !== undefined ? clip(redactHead(out.error, redact)) : stderr.slice(-MAX_MESSAGE)
        const how = r.exitCode === null ? 'Codex ended without an exit code' : `Codex exited with code ${r.exitCode}`
        return { ok: false, code: 'failed', message: `${how}${detail ? `: ${detail}` : ''}.`, ...figures }
      }
      // Exit 0 is a completed run (as a Claude agent's status follows its
      // exit code), but a failed turn with no reply keeps its reason in the
      // output, redacted, rather than reading as a clean run.
      if (out.error !== undefined && (out.text === null || !out.text.trim())) {
        const lead = errTail && !errTail.endsWith('\n') ? '\n' : ''
        emit(input.onDiagnostic, `${lead}Codex reported an error and gave no reply: ${clip(redactHead(out.error, redact))}\n`)
      }
      return { ok: true, ...figures }
    },
  }
}
