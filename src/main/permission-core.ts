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
  // v2.0.0: also reads `tool_input.command` because Claude Code's PreToolUse
  // hook delivers Bash args under `tool_input.command`, not the top-level
  // `command`/`arguments` fields the spec'd PermissionRequest event used.
  const pl = e.payload as {
    tool?: string; arguments?: string; command?: string; reason?: string; requestId?: string;
    tool_input?: { command?: string }
  }
  const tool = pl.tool ?? e.toolName ?? 'unknown'
  const preview = String(pl.arguments ?? pl.command ?? pl.tool_input?.command ?? '')
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
export function decideDisposition(p: PendingPermission, _hasStandingApproval: (tool: string) => boolean): Disposition {
  // v2.0.0: the gateway is wired to CC's PreToolUse hook, so every tool
  // call flows through here. Show the tray ONLY for the dangerous Bash
  // patterns detectHighRisk recognises; auto-allow everything else so the
  // user isn't drowned in prompts for ls/cat/Read/Edit.
  if (p.highRisk) return 'show'
  return 'auto-allow'
}
