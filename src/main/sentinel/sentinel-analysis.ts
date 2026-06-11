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
    'Only registry-proposal findings get proposedPatch. If nothing is threatened, return {"findings": []}.',
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
  return { ok: false, error: `analysis produced no valid output after retry${lastStderr ? `: ${lastStderr.slice(0, 200)}` : ''}` }
}
