// src/main/permission-core.ts
import type { HookEvent } from '../shared/hook-types'
import type { PendingPermission } from '../shared/channel-types'

const HIGH_RISK: Array<{ re: RegExp; label: string }> = [
  { re: /git push\s+--force|--force-with-lease/, label: 'git push --force' },
  { re: /rm\s+-rf|rm\s+-fr/, label: 'rm -rf' },
  { re: /--force\b/, label: '--force' },
  { re: /chmod\s+777/, label: 'chmod 777' },
  { re: /\bsudo\b/, label: 'sudo' },
  { re: /\bdd\s+if=/, label: 'dd if=' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: 'fork bomb' },
]
export function detectHighRisk(tool: string, payload: string): { matched: string } | undefined {
  if (tool !== 'Bash') return undefined
  for (const { re, label } of HIGH_RISK) if (re.test(payload)) return { matched: label }
  return undefined
}

interface SessionInfo { label: string; provider?: string; identityColorKey?: string }

export function normalizePermission(e: HookEvent, info: SessionInfo, transport: 'hook' | 'mcp' = 'hook'): PendingPermission {
  const pl = e.payload as { tool?: string; arguments?: string; command?: string; reason?: string; requestId?: string }
  const tool = pl.tool ?? e.toolName ?? 'unknown'
  const preview = String(pl.arguments ?? pl.command ?? '')
  return {
    requestId: pl.requestId ?? `${e.sessionId}-${e.ts}`,
    sessionId: e.sessionId,
    sessionLabel: info.label,
    identityColorKey: info.identityColorKey,
    provider: info.provider,
    tool,
    payloadPreview: preview,
    reason: pl.reason,
    capturedAt: Date.now(),
    transport,
    tierLabel: transport === 'mcp' ? 'channel-relay' : 'hooks',
    highRisk: detectHighRisk(tool, preview),
  }
}

export type Disposition = 'auto-allow' | 'show'
export function decideDisposition(p: PendingPermission, hasStandingApproval: (tool: string) => boolean): Disposition {
  if (p.highRisk) return 'show'                       // never auto-allow destructive payloads
  return hasStandingApproval(p.tool) ? 'auto-allow' : 'show'
}
