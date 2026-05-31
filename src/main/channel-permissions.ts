// src/main/channel-permissions.ts
import { getGateway } from './hooks/index'
import { getSessionMeta } from './session-registry'
import { appendLedger } from './channel-ledger'
import { pushPendingPermissions } from './ipc/channel-handlers'
import { readConfig } from './config-manager'
import { detectHighRisk } from './permission-core'
import type { PendingPermission } from '../shared/channel-types'
import type { HookEvent } from '../shared/hook-types'

// Genuine-only tray (v1.5.17). CCC is NOT the permission gate; Claude's own
// settings decide. We surface ONLY `Notification(permission_prompt)` events
// (fire only when settings did NOT auto-approve), enriched with the session's
// pending tool. Cards deep-link or dismiss -- they never answer Claude.
const PENDING_CAP = 50
const pending = new Map<string, PendingPermission>()
// Per session: the most recent PreToolUse with no following PostToolUse/Stop.
// On a permission_prompt (which carries no tool detail) this IS the blocked tool.
const lastPendingTool = new Map<string, { tool: string; preview: string }>()
let started = false

export function getPending(): PendingPermission[] { return [...pending.values()] }

/** Test seam: reset module state between cases. */
export function _resetPending(): void { pending.clear(); lastPendingTool.clear() }

function trayEnabled(): boolean {
  // Mirror cloud-agent-manager.ts -- read AppSettings fresh; default ON.
  return readConfig<{ permissionTrayEnabled?: boolean }>('settings')?.permissionTrayEnabled !== false
}

function isPermissionPrompt(e: HookEvent): boolean {
  return e.event === 'Notification' &&
    (e.payload as { notification_type?: string }).notification_type === 'permission_prompt'
}

function previewFor(e: HookEvent): { tool: string; preview: string } {
  const pl = e.payload as {
    tool?: string; command?: string; arguments?: string
    tool_input?: { command?: string; file_path?: string }
  }
  const tool = e.toolName ?? pl.tool ?? 'tool'
  const preview = String(pl.tool_input?.command ?? pl.tool_input?.file_path ?? pl.command ?? pl.arguments ?? '')
  return { tool, preview }
}

function dismissForSession(sessionId: string): void {
  let changed = false
  for (const [id, p] of pending) if (p.sessionId === sessionId) { pending.delete(id); changed = true }
  if (changed) pushPendingPermissions(getPending())
}

function captureNotification(e: HookEvent): void {
  if (!trayEnabled()) return
  const meta = getSessionMeta(e.sessionId)
  const enrich = lastPendingTool.get(e.sessionId)
  const id = `${e.sessionId}-${e.ts}`
  const p: PendingPermission = {
    requestId: id,
    sessionId: e.sessionId,
    sessionLabel: meta?.label ?? e.sessionId,
    identityColorKey: meta?.identityColorKey,
    provider: meta?.provider,
    tool: enrich?.tool ?? 'Permission',
    payloadPreview: enrich?.preview || 'Claude needs your permission',
    capturedAt: Date.now(),
    transport: 'hook',
    tierLabel: 'hooks',
    highRisk: enrich ? detectHighRisk(enrich.tool, enrich.preview) : undefined,
  }
  if (pending.size >= PENDING_CAP) {
    const oldest = pending.keys().next().value
    if (oldest) pending.delete(oldest)
  }
  pending.set(id, p)
  appendLedger({ source: 'permission', target: p.sessionLabel, transport: null, kind: 'permission-prompt', summary: `${p.tool}: ${p.payloadPreview}` })
  pushPendingPermissions(getPending())
}

function track(e: HookEvent): void {
  if (e.event === 'PreToolUse') { lastPendingTool.set(e.sessionId, previewFor(e)); return }
  if (e.event === 'PostToolUse' || e.event === 'Stop') {
    lastPendingTool.delete(e.sessionId)
    dismissForSession(e.sessionId)
    return
  }
  if (isPermissionPrompt(e)) captureNotification(e)
}

export function startPermissionTray(): void {
  if (started) return
  started = true
  const gw = getGateway()
  if (gw) gw.subscribe(track)
}

/**
 * Per-card "Ignore". Removes ONLY the tray card; it does not answer Claude's own
 * in-terminal prompt (which stays until the user acts in the session).
 */
export function dismissPermission(p: { requestId: string }): { ok: boolean } {
  const card = pending.get(p.requestId)
  if (!card) return { ok: false }
  pending.delete(p.requestId)
  appendLedger({ source: 'permission', target: card.sessionLabel, transport: null, kind: 'permission-dismiss', summary: `ignored ${card.tool}` })
  pushPendingPermissions(getPending())
  return { ok: true }
}
