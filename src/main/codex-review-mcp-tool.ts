import { mkdtempSync, readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import * as path from 'path'
import { tmpdir } from 'os'
import { z } from 'zod'
import { runCodexStreaming, readCodexAuthStatus } from './providers/codex/auth'
import { recordReview } from './codex-review-usage'
import { logInfo } from './debug-logger'

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes
const MAX_DIFF_BYTES = 50 * 1024  // 50 KB

export const codexReviewArgsSchema = z.object({
  cccSessionId: z.string().min(1),
  mode: z.enum(['working', 'range', 'paths']),
  range: z.string().optional(),
  paths: z.array(z.string().min(1)).optional(),
  focus: z.string().max(500).optional(),
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

  // 2. ACL
  if (!optedInSessions.has(args.cccSessionId)) {
    return {
      isError: true,
      text: `Codex review is not enabled for session ${args.cccSessionId}. Toggle "Enable Codex code review" in the session config.`,
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

  // 6. Spawn streaming
  let observed: TokenCountObserved | null = null
  const result = await runCodexStreaming(argv, {
    timeoutMs: REVIEW_TIMEOUT_MS,
    cwd: resolvedCwd,
    onStdoutLine: (line: string) => {
      const parsedLine = parseTokenCountLine(line)
      if (parsedLine) observed = parsedLine
    },
  })

  // 7. Error mapping
  if (result.timedOut) {
    return { isError: true, text: 'Codex review timed out after 5 minutes. Try a smaller scope (e.g. mode: "paths").' }
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
    recordReview(args.cccSessionId, {
      inputTokens: obsInner.inputTokens,
      outputTokens: obsInner.outputTokens,
      rateLimit: obsInner.rateLimit,
    })
  }

  return { isError: false, text: review + formatFooter(observed) }
}

/** Register the codex_review tool on a conductor-mcp-server McpServer instance. */
export function registerCodexReviewTool(
  server: any,  // McpServer (lazy-typed in conductor-mcp-server.ts)
  zMod: any,    // zod module (lazy-loaded)
  getOptedIn: () => Set<string>,
  getCwdForSession: (sessionId: string) => string | null,
): void {
  server.tool(
    'codex_review',
    'Get a Codex (gpt-5.5) code review on a change. Use when the user asks for a "Codex review" or "second opinion". Required arg cccSessionId: read with the Bash tool via `echo $CLAUDE_MULTI_SESSION_ID`. The mode arg picks scope: "working" for uncommitted changes (no extra arg), "range" for a git revision range (provide range, e.g. "HEAD~1..HEAD"), "paths" for specific files (provide paths). Optional focus directs Codex\'s attention. Returns the review markdown plus a residual rate-limit footer so you can self-govern usage.',
    {
      cccSessionId: zMod.string().describe('CCC session id, read from $CLAUDE_MULTI_SESSION_ID env var'),
      mode: zMod.enum(['working', 'range', 'paths']).describe('Scope: working diff, git range, or explicit paths'),
      range: zMod.string().optional().describe('Git range (e.g. "HEAD~1..HEAD") -- required when mode === "range"'),
      paths: zMod.array(zMod.string()).optional().describe('File paths -- required when mode === "paths"'),
      focus: zMod.string().max(500).optional().describe('Optional focus directive (e.g. "race conditions")'),
    },
    async (rawArgs: any) => {
      const cwd = getCwdForSession(rawArgs?.cccSessionId) ?? process.cwd()
      const result = await runCodexReview(rawArgs, getOptedIn(), cwd)
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      }
    },
  )
}
