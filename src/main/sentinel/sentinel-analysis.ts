// AI half of Trigger B (spec §5): one self-contained claude -p call, strict
// zod-validated JSON out, one retry, 3-minute cap. Proposals only — Apply is
// the sole writer, and only to the overlay (spec §7).
import { z } from 'zod'
import type { SentinelFinding } from '../../shared/sentinel-types'

const FindingSchema = z.object({
  kind: z.enum(['registry-proposal', 'compat', 'info']),
  severity: z.enum(['info', 'warn', 'high']),
  title: z.string().min(1).max(200),
  evidence: z.string().min(1).max(2000),
  affectedFeature: z.string().max(50).optional(),
  badgeText: z.string().max(200).optional(),
  proposedPatch: z.object({
    id: z.string().min(1), patterns: z.array(z.string()).min(1), family: z.string().min(1),
    label: z.string().min(1),
    fallbackPricing: z.object({ input: z.number().positive(), output: z.number().positive(),
      cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative() }).optional(),
    efforts: z.array(z.string()).optional(),
  }).optional(),
})
const OutputSchema = z.object({ findings: z.array(FindingSchema).max(30) })

export function buildAnalysisPrompt(changelog: string, manifestJson: string, registryJson: string): string {
  return [
    'You are CCC Sentinel, analyzing a Claude Code (CC) update for impact on Claude Command Center (CCC).',
    'Below: (1) the CC changelog entries for this update, (2) CCC\'s assumption manifest — the contracts CCC',
    'relies on, each with failureMode and whether it is configFixable, (3) CCC\'s current model registry.',
    '',
    'TASK: identify which manifest contracts the changelog plausibly threatens, and any new models/efforts',
    'mentioned. Output STRICT JSON only — no markdown, no prose: {"findings": [...]} where each finding is',
    '{"kind": "registry-proposal"|"compat"|"info", "severity": "info"|"warn"|"high", "title": "...",',
    ' "evidence": "<exact changelog line(s) quoted>", "affectedFeature": "<manifest affectedFeature>",',
    ' "badgeText": "<one user-facing sentence>", "proposedPatch": {<only for registry-proposal: id, patterns,',
    ' family, label, fallbackPricing?, efforts?>}}.',
    'Rules: evidence MUST quote the changelog verbatim. Do not invent contracts not in the manifest.',
    'EXCEPTION (terminal-interaction watch): CCC embeds CC inside xterm.js, so ALSO emit an "info" finding',
    'for any changelog entry that changes how CC interacts with the HOST TERMINAL itself — mouse modes or',
    'clickable UI elements, keyboard protocols, alternate screen / rendering, OSC or escape-sequence use —',
    'even when no manifest contract names it. These additive changes historically reach CCC users (e.g. the',
    '2.1.195 clickable question options misfired in xterm before CCC gated them).',
    'Only registry-proposal findings get proposedPatch. If nothing is threatened, return {"findings": []}.',
    'Severity: reserve "warn"/"high" for changes that threaten a contract CCC ACTIVELY relies on AND that can',
    'reach an INDIVIDUAL (non-managed) account — CCC\'s default user. Grade as "info" (not warn/high):',
    'enterprise/managed-settings-only changes, and changes to mechanisms CCC does not use (e.g. model-redirect',
    'env vars CCC never sets). When unsure whether CCC actually depends on the changed behavior, prefer "info".',
    '',
    '--- CHANGELOG ---', changelog,
    '--- ASSUMPTION MANIFEST ---', manifestJson,
    '--- MODEL REGISTRY ---', registryJson,
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
    return parsed.findings.map((f, i) => ({
      ...f,
      proposedPatch: f.proposedPatch
        ? { ...f.proposedPatch, provenance: { addedBy: 'sentinel' as const, date: new Date().toISOString().slice(0, 10), ccVersion: to } }
        : undefined,
      id: `cc:${to}:${i}`, status: 'open' as const, createdAt: Date.now(),
      ccVersionFrom: from, ccVersionTo: to,
    }))
  } catch { return null }
}

export type HeadlessRunner = (args: string[], timeoutMs: number, stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>

// Graceful-degrade copy for a failed AI pass. The deterministic min-version
// findings run separately (and are shown regardless), so a failed AI analysis
// is a soft, retryable condition, not an error. Keep it calm and human: never
// surface raw stderr / "Timed out after 180s" to the user (that detail is in the
// main-process logs). A timeout most often means the signed-in account is busy
// or rate limited, so the message hints at that and points to Re-run.
export function analysisFailureMessage(stderr: string): string {
  const timedOut = /timed out after/i.test(stderr)
  const base = timedOut
    ? 'AI analysis could not finish in time this run. This usually means the signed-in account is busy or rate limited, or the update was large.'
    : 'AI analysis could not complete this run.'
  return `${base} The deterministic checks still ran. Use Re-run to try again.`
}

export async function runAnalysis(opts: {
  runner: HeadlessRunner; changelog: string; manifestJson: string; registryJson: string; from: string; to: string
}): Promise<{ ok: true; findings: SentinelFinding[] } | { ok: false; error: string }> {
  const prompt = buildAnalysisPrompt(opts.changelog, opts.manifestJson, opts.registryJson)
  const args = ['-p', '--model', 'sonnet', '--output-format', 'json']
  let lastStderr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await opts.runner(args, 180000, prompt)        // 3-minute cap (spec §5)
    lastStderr = res.stderr
    if (res.code === 0) {
      const findings = parseAnalysisOutput(res.stdout, opts.from, opts.to)
      if (findings) return { ok: true, findings }
    }
  }
  return { ok: false, error: analysisFailureMessage(lastStderr) }
}
