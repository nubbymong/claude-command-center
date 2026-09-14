// AI half of Trigger B: one self-contained claude -p call, strict zod-validated
// JSON out, one retry, 3-minute cap. Severe-breaking-changes-only (spec
// 2026-07-04): the prompt is a LEAN ~2KB (changelog slice + CCC's 4-item
// breaking surface), which also removes the large-stdin hang that stalled the
// old ~21KB manifest prompt (anthropics/claude-code#7263).
import { z } from 'zod'
import type { SentinelFinding } from '../../shared/sentinel-types'

// The only things that, if CC changes them, actually stop CCC working. The AI
// checks the changelog against ONLY these four surfaces.
const CCC_BREAKING_SURFACE = [
  '1. Session launch — how `claude` is spawned (CLI flags, env vars, PATH, install layout). Break = Conductor sessions will not start.',
  '2. Terminal embedding — mouse modes, clickable UI, alternate-screen, OSC/escape sequences; the Conductor renders claude inside xterm.js. Break = the session renders garbled or unusable.',
  '3. Statusline hook — the statusLine settings/hook contract the Conductor installs to read session telemetry. Break = telemetry / rate-limit readouts die.',
  '4. Config & account files — the shape of ~/.claude/settings.json and ~/.claude.json that the Conductor multi-account isolation and hook install depend on. Break = multi-account or hooks break.',
].join('\n')

const BreakingChangeSchema = z.object({
  title: z.string().min(1).max(200),
  evidence: z.string().min(1).max(2000),   // exact changelog line(s), quoted
  surface: z.number().int().min(1).max(4),
  whatBreaks: z.string().min(1).max(400),
})
const OutputSchema = z.object({ breakingChanges: z.array(BreakingChangeSchema).max(5) })

export function buildAnalysisPrompt(changelog: string): string {
  return [
    'You are Sentinel, the compatibility watcher in AI Code Conductor (the "Conductor"), a desktop app that runs the Claude Code (CC) CLI inside embedded terminals.',
    'Read the CC changelog below and report ONLY changes that would SEVERELY BREAK the Conductor — stop it working — by hitting one of these four surfaces:',
    CCC_BREAKING_SURFACE,
    '',
    'Ignore everything else: new features, new models, model/pricing housekeeping, performance, cosmetic or informational changes, and anything that only affects enterprise / managed-settings installs. A change is NOT breaking just because it is new.',
    '',
    'Output STRICT JSON only — no markdown, no prose: {"breakingChanges": [ ... ]} where each item is',
    '{"title": "<short>", "evidence": "<exact changelog line(s), quoted verbatim>", "surface": <1-4>, "whatBreaks": "<one sentence: what stops working in the Conductor>"}.',
    'Quote the changelog verbatim in evidence. List at most 5. If nothing severely breaks the Conductor, return {"breakingChanges": []}.',
    '',
    '--- CHANGELOG ---',
    changelog,
  ].join('\n')
}

function unwrapPayload(stdout: string): string {
  let text = stdout.trim()
  // claude -p --output-format json wraps the reply in an envelope { type:'result', result: '...' }
  try {
    const env = JSON.parse(text)
    if (env && typeof env.result === 'string') text = env.result.trim()
  } catch { /* not an envelope — treat as the payload itself */ }
  // strip a markdown fence if the model added one despite instructions
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
  if (fence) text = fence[1]
  return text
}

export function parseAnalysisOutput(stdout: string, from: string, to: string): SentinelFinding[] | null {
  try {
    const parsed = OutputSchema.parse(JSON.parse(unwrapPayload(stdout)))
    // Every breaking change is a high-severity compat finding (the panel has one
    // list now). whatBreaks rides in badgeText; surface tags which contract broke.
    return parsed.breakingChanges.map((b, i) => ({
      id: `cc:${to}:${i}`,
      kind: 'compat' as const,
      severity: 'high' as const,
      title: b.title,
      evidence: b.evidence,
      badgeText: b.whatBreaks,
      surface: b.surface,
      status: 'open' as const,
      createdAt: Date.now(),
      ccVersionFrom: from,
      ccVersionTo: to,
    }))
  } catch { return null }
}

export type HeadlessRunner = (args: string[], timeoutMs: number, stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>

/** The subset of the `claude -p --output-format json` envelope we react to on a
 *  FAILED (non-zero) run. claude -p exits 1 on an API error but still prints the
 *  envelope to stdout, carrying a human `result` (e.g. a rate-limit line) and an
 *  `api_error_status`. */
interface HeadlessEnvelope {
  is_error?: unknown
  api_error_status?: unknown
  terminal_reason?: unknown
  result?: unknown
}

/** Longest envelope `result` we echo. The CLI's error strings are short; the cap
 *  bounds what a surprising payload can put in front of the user. */
const ENVELOPE_REASON_MAX = 160

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g

/**
 * Read a user-facing failure reason out of a non-zero run's JSON envelope, or
 * null when it is not an error envelope we can read (so the caller falls back to
 * the generic message). The old code only ever looked at stderr, so a 429
 * ("You've hit your weekly limit · resets 4am") was shown as the vague "could
 * not complete" with no hint that it was a usage limit or that Re-run was futile
 * until reset (#430).
 */
export function envelopeError(stdout: string): { rateLimited: boolean; reason: string } | null {
  // Parse the RAW top-level envelope — NOT unwrapPayload, which peels `.result`,
  // and on an error envelope `.result` is the human string ("You've hit your
  // weekly limit …"), not nested JSON. The error envelope's is_error /
  // api_error_status / result all live at the top level.
  let env: HeadlessEnvelope
  try {
    env = JSON.parse(stdout.trim()) as HeadlessEnvelope
  } catch {
    return null
  }
  if (!env || typeof env !== 'object') return null
  const status = typeof env.api_error_status === 'number' ? env.api_error_status : null
  const isError = env.is_error === true || env.terminal_reason === 'api_error' || (status !== null && status >= 400)
  if (!isError) return null
  // `result` on an api_error is the CLI's own error string (not model output).
  // Strip control chars + trim + cap, so nothing pathological reaches the panel.
  const raw = typeof env.result === 'string' ? env.result.replace(CONTROL_CHARS, ' ').trim() : ''
  const reason = raw ? raw.slice(0, ENVELOPE_REASON_MAX) : status !== null ? `the account returned HTTP ${status}` : 'the account could not be reached'
  const rateLimited = status === 429 || /\blimit\b/i.test(reason)
  return { rateLimited, reason }
}

// Graceful-degrade copy for a failed AI pass. The deterministic backstop runs
// separately (and is shown regardless), so a failed AI analysis is a soft,
// retryable condition, not an error. Keep it calm and human: never surface raw
// stderr / "Timed out after 180s" to the user (that detail is in the logs). When
// the envelope gives a real reason (a rate limit, an API error), say it — and
// name the analysis account, so the user knows WHICH account to change and that
// the fix is in Settings, not Re-run.
export function analysisFailureMessage(
  stderr: string,
  envErr?: { rateLimited: boolean; reason: string } | null,
  accountLabel?: string | null,
): string {
  const who = accountLabel ? ` (${accountLabel})` : ''
  if (envErr) {
    if (envErr.rateLimited) {
      return `The Sentinel analysis account${who} has hit its usage limit — ${envErr.reason}. Pick a different account in Settings → Sentinel, or Re-run once it resets. The deterministic checks still ran.`
    }
    return `AI analysis could not complete: ${envErr.reason}. The deterministic checks still ran. Use Re-run to try again.`
  }
  const timedOut = /timed out after/i.test(stderr)
  const base = timedOut
    ? `AI analysis could not finish in time this run. This usually means the analysis account${who} is busy or rate limited, or the update was large.`
    : 'AI analysis could not complete this run.'
  return `${base} The deterministic checks still ran. Use Re-run to try again.`
}

export async function runAnalysis(opts: {
  runner: HeadlessRunner; changelog: string; from: string; to: string; accountLabel?: string | null
}): Promise<{ ok: true; findings: SentinelFinding[] } | { ok: false; error: string }> {
  const prompt = buildAnalysisPrompt(opts.changelog)
  const args = ['-p', '--model', 'sonnet', '--output-format', 'json']
  let lastStderr = ''
  let lastEnvErr: { rateLimited: boolean; reason: string } | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await opts.runner(args, 180000, prompt)          // 3-minute cap
    lastStderr = res.stderr
    if (res.code === 0) {
      const findings = parseAnalysisOutput(res.stdout, opts.from, opts.to)
      if (findings) return { ok: true, findings }
      lastEnvErr = null                              // ran, but output unparseable: not an API error
    } else {
      lastEnvErr = envelopeError(res.stdout)
      // A usage limit will not clear on an immediate retry — stop and report it
      // rather than burning the second attempt on the same wall.
      if (lastEnvErr?.rateLimited) break
    }
  }
  return { ok: false, error: analysisFailureMessage(lastStderr, lastEnvErr, opts.accountLabel) }
}
