import { mkdtempSync, readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import * as path from 'path'
import { tmpdir } from 'os'
import { isHomeOrAncestor } from './path-utils'
import { z } from 'zod'
import { runCodexStreaming, readCodexAuthStatus } from './providers/codex/auth'
import { recordReview } from './codex-review-usage'
import { logInfo } from './debug-logger'
import { emitCodexReviewComplete } from './channel-emitters'

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes (default)
const MAX_DIFF_BYTES = 50 * 1024  // 50 KB
// P7.7.15: timeoutSeconds bounds. Floor at 30s so a misconfigured request
// can't render the tool unusable (cold-start spawn alone takes >5s on
// Windows); ceiling at 900s = 15 minutes to bound rate-limit + quota damage
// from a runaway review on a huge diff.
const TIMEOUT_SECONDS_MIN = 30
const TIMEOUT_SECONDS_MAX = 900

function formatTimeoutForMessage(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)} seconds`
  const min = Math.round(ms / 60000)
  return `${min} minute${min === 1 ? '' : 's'}`
}

export const codexReviewArgsSchema = z.object({
  // P7.7.10: cccSessionId is resolved server-side from the MCP SSE
  // transport URL (baked in by writeLocalSessionMcpConfig). Kept optional
  // for back-compat with in-flight sessions that pre-date the URL change
  // -- if the connection didn't bind a session id, runCodexReview falls
  // back to this arg before refusing the call.
  cccSessionId: z.string().min(1).optional(),
  mode: z.enum(['working', 'range', 'paths']),
  range: z.string().optional(),
  paths: z.array(z.string().min(1)).optional(),
  focus: z.string().max(500).optional(),
  // P7.7.15: optional caller override of the default 5-minute timeout.
  // Useful for large diffs that overshoot the cold-start budget on
  // mode='paths' with many files or mode='range' on multi-commit windows.
  timeoutSeconds: z.number().int().min(TIMEOUT_SECONDS_MIN).max(TIMEOUT_SECONDS_MAX).optional(),
}).superRefine((data, ctx) => {
  if (data.mode === 'range' && !data.range) {
    ctx.addIssue({ code: 'custom', message: 'range required when mode === "range"', path: ['range'] })
  }
  if (data.mode === 'paths' && (!data.paths || data.paths.length === 0)) {
    ctx.addIssue({ code: 'custom', message: 'paths required when mode === "paths"', path: ['paths'] })
  }
})

export type CodexReviewArgs = z.infer<typeof codexReviewArgsSchema>

export interface CodexReviewResult {
  text: string
  isError: boolean
}

interface TokenCountObserved {
  inputTokens: number
  outputTokens: number
  rateLimit: {
    usedPercent: number
    resetsAt: number
    planType: string
  } | null
}

function parseTokenCountLine(line: string): TokenCountObserved | null {
  try {
    const obj = JSON.parse(line)
    if (obj?.type !== 'event_msg') return null
    const p = obj.payload
    if (p?.type !== 'token_count') return null
    const usage = p.total_token_usage ?? {}
    const rl = p.rate_limits ?? {}
    const primary = rl.primary ?? null
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      rateLimit: primary
        ? { usedPercent: primary.used_percent ?? 0, resetsAt: primary.resets_at ?? 0, planType: rl.plan_type ?? 'unknown' }
        : null,
    }
  } catch {
    return null
  }
}

function buildArgv(args: CodexReviewArgs, cwd: string, tmpfile: string): string[] {
  // P7.7.6: Codex CLI 0.128.0 removed --ask-for-approval from `codex exec`.
  // --sandbox read-only already prevents shell mutations and approval
  // escalation, so dropping the flag is safe. The interactive top-level
  // `codex` command still accepts --ask-for-approval; that path lives in
  // providers/codex/spawn.ts and is unchanged.
  const argv = ['exec', '--json', '--output-last-message', tmpfile,
    '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', cwd,
    '-m', 'gpt-5.5']

  let prompt = 'Review the following change. Be concise. Focus on correctness, security, and obvious bugs.\n'
  switch (args.mode) {
    case 'working':
      prompt += '\nScope: uncommitted working diff in this repo.\n'
      break
    case 'range':
      prompt += `\nScope: git revision range ${args.range}.\n`
      break
    case 'paths':
      prompt += `\nScope: ${(args.paths ?? []).join(', ')}\n`
      break
  }
  if (args.focus) prompt += `\nFocus area: ${args.focus}\n`

  argv.push(prompt)
  return argv
}

function formatFooter(observed: TokenCountObserved | null): string {
  if (!observed?.rateLimit) {
    return '\n\n---\nCodex review -- 1 message used. Rate-limit data unavailable.'
  }
  const used = Math.round(observed.rateLimit.usedPercent * 100)
  const resetIso = new Date(observed.rateLimit.resetsAt * 1000).toISOString().slice(11, 16)
  return `\n\n---\nCodex review -- 1 message used -- window ${used}% used (resets ${resetIso} UTC, plan ${observed.rateLimit.planType}).`
}

export async function runCodexReview(
  rawArgs: unknown,
  optedInSessions: Set<string>,
  resolvedCwd: string,
): Promise<CodexReviewResult> {
  // 1. zod validation
  const parsed = codexReviewArgsSchema.safeParse(rawArgs)
  if (!parsed.success) {
    return { isError: true, text: `Invalid arguments: ${parsed.error.message}` }
  }
  const args = parsed.data

  // 1.5. P7.7.10: cccSessionId is now optional in the schema (resolved
  // server-side from the MCP transport URL). At this layer it MUST be
  // present -- the MCP tool wrapper is responsible for merging in the
  // bound sid before calling runCodexReview. A direct call without sid
  // is a wiring bug worth surfacing.
  if (!args.cccSessionId) {
    return {
      isError: true,
      text: 'Codex review unavailable: no Conductor session id bound to this MCP connection. Spawn the Claude session from inside AI Code Conductor.',
    }
  }
  // Narrow once and reuse so a future refactor adding an `await` between
  // the guard and downstream usage can't silently widen the type back to
  // `string | undefined`. Aliasing also keeps the rest of the function
  // independent of zod schema cardinality.
  const cccSessionId: string = args.cccSessionId

  // 2. ACL
  if (!optedInSessions.has(cccSessionId)) {
    return {
      isError: true,
      text: `Codex review is not enabled for session ${cccSessionId}. It is available to local Claude Code sessions when Codex is enabled in Settings → Codex, and only when the session has a real project directory.`,
    }
  }

  // 2.5. SECURITY (adversarial review, #188): defence-in-depth against the
  // home-directory review root. Registration already refuses when the launch cwd
  // is home or an ancestor of it (pty-manager), so such a session should never be
  // in optedInSessions — but re-check here so mode:'paths' can never reach
  // ~/.ssh, ~/.claude, ~/.aws even if a future caller re-introduces one.
  // isHomeOrAncestor canonicalises with realpath so a case-variant / \\?\ /
  // junction form of home is caught, not just the exact string.
  if (isHomeOrAncestor(resolvedCwd)) {
    return {
      isError: true,
      text: 'Codex review refused: the session has no project directory (its working directory resolves to your home folder). Set a real project directory in the session config.',
    }
  }

  // 3. Auth + install check
  const auth = await readCodexAuthStatus()
  if (!auth.installed) {
    return { isError: true, text: 'Codex CLI not installed. Run "npm i -g @openai/codex" or see Settings > Codex.' }
  }
  if (auth.authMode === 'none') {
    return { isError: true, text: "You're not logged into Codex. Open Settings > Codex and sign in." }
  }

  // 3.5. Path traversal containment for mode 'paths'
  //      (--sandbox read-only is defence-in-depth; this is the primary gate.)
  if (args.mode === 'paths' && args.paths) {
    for (const p of args.paths) {
      const abs = path.resolve(resolvedCwd, p)
      const rel = path.relative(resolvedCwd, abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          isError: true,
          text: `Paths must be inside the session cwd. Rejected: ${p}`,
        }
      }
    }
  }

  // 3.6. Git-repo guard for modes that require diff history.
  //      Codex itself surfaces "not a git repo" but the UX is muddy: we pay
  //      latency + a quota hit before the failure shows up. Fast-fail with a
  //      clear redirect to mode='paths'. mode='paths' is intentionally exempt
  //      since it operates on explicit file paths and works outside a repo.
  if (args.mode === 'working' || args.mode === 'range') {
    if (!existsSync(path.join(resolvedCwd, '.git'))) {
      return {
        isError: true,
        text: `Mode '${args.mode}' requires a git repository, but ${resolvedCwd} is not one. Use mode='paths' with explicit file paths instead.`,
      }
    }
  }

  // 4. Tmpfile for last-message capture
  const tmpDir = mkdtempSync(join(tmpdir(), 'ccc-codex-review-'))
  const tmpfile = join(tmpDir, 'review.md')

  // 5. Build argv
  const argv = buildArgv(args, resolvedCwd, tmpfile)

  // P7.7.9: log spawn args so the debug log shows exactly what flags were
  // passed to codex on each invocation. Useful when diagnosing future CLI
  // drift or argv-construction regressions.
  logInfo('[codex-review] spawning: codex ' + argv.join(' '))

  // 6. Spawn streaming. P7.7.15: honour caller-supplied timeoutSeconds when
  // provided; zod already clamped it to [TIMEOUT_SECONDS_MIN, TIMEOUT_SECONDS_MAX].
  const timeoutMs = args.timeoutSeconds != null ? args.timeoutSeconds * 1000 : REVIEW_TIMEOUT_MS
  let observed: TokenCountObserved | null = null
  const result = await runCodexStreaming(argv, {
    timeoutMs,
    cwd: resolvedCwd,
    onStdoutLine: (line: string) => {
      const parsedLine = parseTokenCountLine(line)
      if (parsedLine) observed = parsedLine
    },
  })

  // 7. Error mapping
  if (result.timedOut) {
    return { isError: true, text: `Codex review timed out after ${formatTimeoutForMessage(timeoutMs)}. Try a smaller scope (e.g. mode: "paths") or raise timeoutSeconds (max ${TIMEOUT_SECONDS_MAX}).` }
  }
  if (result.code !== 0) {
    const excerpt = (result.stderr || '').slice(0, 500)
    return { isError: true, text: `Codex review failed (exit ${result.code}): ${excerpt}${formatFooter(observed)}` }
  }

  // 8. Read tmpfile
  if (!existsSync(tmpfile)) {
    return { isError: true, text: 'Codex review produced no output (tmpfile missing).' }
  }
  let review = readFileSync(tmpfile, 'utf-8')
  if (statSync(tmpfile).size > MAX_DIFF_BYTES) {
    review = '[review truncated -- output exceeded 50KB]\n\n' + review.slice(-MAX_DIFF_BYTES)
  }

  // 9. Record usage
  if (observed) {
    const obsInner = observed as TokenCountObserved
    recordReview(cccSessionId, {
      inputTokens: obsInner.inputTokens,
      outputTokens: obsInner.outputTokens,
      rateLimit: obsInner.rateLimit,
    })
  }

  // Emit internal event so channel rules (Codex Routing) can forward the
  // review to the PR author session. Best-effort: never breaks the review result.
  try {
    // Count numbered list items or "issue:" lines as a rough finding count.
    const findingCount = (review.match(/^\s*\d+\./gm) ?? []).length || 1
    emitCodexReviewComplete({
      prNumber: undefined,
      authorSessionId: cccSessionId,
      findingCount,
      findings: review.slice(0, 500),
    })
  } catch { /* channels emit is best-effort */ }

  return { isError: false, text: review + formatFooter(observed) }
}

/** Register the codex_review tool on a conductor-mcp-server McpServer instance.
 *
 * The session id comes SOLELY from `getBoundSessionId()` — the CCC session id
 * parsed from the transport URL (`?cccSessionId=<sid>`, baked in per-session by
 * writeLocalSessionMcpConfig). The `cccSessionId` tool ARG is ignored entirely
 * (adversarial review, #188): once every local session is opted-in, trusting an
 * LLM-supplied id would let a session name another session's id and review its
 * tree. An unbound connection (legacy/in-flight, pre-P7.7.10 URL bake) is refused
 * and self-heals on the session's next respawn.
 *
 * NOTE — this binds the id to the transport URL, not to an unforgeable secret.
 * The endpoint is still gated only by the loopback token, which is written into
 * each session's readable ~/.claude/mcp-<sid>.json (a documented local-trust
 * posture, SECURITY.md). A local process already running as the user could read
 * that token and POST a chosen ?cccSessionId — but such a process can read the
 * target files directly and needs no codex_review, so this is not an escalation
 * over the existing local-trust boundary. Minting a per-session capability token
 * (so the sid can't be restated in the URL) is tracked as a follow-up; it is a
 * pre-existing hardening, not introduced by this change.
 */
export function registerCodexReviewTool(
  server: any,  // McpServer (lazy-typed in conductor-mcp-server.ts)
  zMod: any,    // zod module (lazy-loaded)
  getOptedIn: () => Set<string>,
  getCwdForSession: (sessionId: string) => string | null,
  getBoundSessionId: () => string | null = () => null,
): void {
  server.tool(
    'codex_review',
    'Get a Codex (gpt-5.5) code review on a change. Use when the user asks for a "Codex review" or "second opinion". The mode arg picks scope: "working" for uncommitted changes (no extra arg), "range" for a git revision range (provide range, e.g. "HEAD~1..HEAD"), "paths" for specific files (provide paths). Optional focus directs Codex\'s attention. Returns the review markdown plus a residual rate-limit footer so you can self-govern usage. The Conductor session id is resolved automatically from the MCP connection -- no need to pass it.',
    {
      cccSessionId: zMod.string().optional().describe('Ignored — the session id is resolved from the MCP connection and cannot be set here. Leave unset.'),
      mode: zMod.enum(['working', 'range', 'paths']).describe('Scope: working diff, git range, or explicit paths'),
      range: zMod.string().optional().describe('Git range (e.g. "HEAD~1..HEAD") -- required when mode === "range"'),
      paths: zMod.array(zMod.string()).optional().describe('File paths -- required when mode === "paths"'),
      focus: zMod.string().max(500).optional().describe('Optional focus directive (e.g. "race conditions")'),
      timeoutSeconds: zMod.number().int().min(30).max(900).optional().describe('Optional override of the default 5-minute timeout. Allowed range 30-900 seconds. Raise for large diffs that overshoot the default; lower for fast-fail experiments.'),
    },
    async (rawArgs: any) => {
      // SECURITY (adversarial review, #188): trust ONLY the transport-bound
      // session id. The old code fell back to the LLM-supplied cccSessionId when
      // the connection hadn't bound one — harmless while the opt-in set was tiny
      // and user-curated, but once every local session is opted-in that fallback
      // becomes a cross-session read primitive: a prompt-injected session could
      // pass ANOTHER session's id, clear the (now-universal) ACL, and have codex
      // review that session's working tree. Binding the id to the transport URL
      // (baked in per-session by writeLocalSessionMcpConfig) makes it
      // unforgeable from inside the model. Legacy in-flight sessions that
      // pre-date the URL bake self-heal on their next respawn.
      const sid = getBoundSessionId()
      if (!sid) {
        return {
          content: [{ type: 'text' as const, text: 'Codex review unavailable: this MCP connection has no bound Conductor session. Restart the Claude session from inside AI Code Conductor.' }],
          isError: true,
        }
      }
      const cwd = getCwdForSession(sid)
      if (!cwd) {
        return {
          content: [{ type: 'text' as const, text: `Codex review is not enabled for this session. It is available to local Claude Code sessions with a real project directory when Codex is enabled in Settings → Codex.` }],
          isError: true,
        }
      }
      const mergedArgs: Record<string, unknown> = { ...rawArgs, cccSessionId: sid }
      const result = await runCodexReview(mergedArgs, getOptedIn(), cwd)
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      }
    },
  )
}
