// src/main/permission-core.ts
import type { HookEvent } from '../shared/hook-types'
import type { PendingPermission } from '../shared/channel-types'

// `--force-with-lease` is the SAFER replacement for `--force` and intentionally
// excluded from the force-push label. The (?!-with-lease) lookahead lets a real
// `git push --force` still match while letting the lease form pass.
//
// `sudo` is anchored to a command position (start of payload, or after a shell
// separator) so it does not fire on `cat /etc/sudoers`, `# sudo foo`, or string
// literals like `echo "sudo is a tool"`.
const SUDO_RE = /(?:^|[\s;&|`(])sudo(?=\s|$)/
const HIGH_RISK: Array<{ re: RegExp; label: string }> = [
  { re: /git\s+push\s+(?:[^\n]*\s)?--force(?!-with-lease)\b/, label: 'git push --force' },
  { re: /rm\s+-rf|rm\s+-fr/, label: 'rm -rf' },
  { re: /--force(?!-with-lease)\b/, label: '--force' },
  { re: /chmod\s+777/, label: 'chmod 777' },
  { re: SUDO_RE, label: 'sudo' },
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
  // v1.5.11: also reads `tool_input.command` because Claude Code's PreToolUse
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

// Tools with no external effect: auto-approved silently so the tray isn't a wall
// of cards in an agent loop. TodoWrite mutates only the internal todo list (no
// external effect) and is included deliberately. Everything not listed SHOWS
// (err toward surfacing). High-risk is always shown regardless.
const AUTO_ALLOW_TOOLS = new Set<string>([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'BashOutput', 'TodoWrite',
])

export function decideDisposition(p: PendingPermission, hasStandingApproval: (tool: string) => boolean): Disposition {
  if (p.highRisk) return 'show'                  // safety: never auto-allow a destructive payload
  if (hasStandingApproval(p.tool)) return 'auto-allow'
  if (AUTO_ALLOW_TOOLS.has(p.tool)) return 'auto-allow'
  return 'show'
}
