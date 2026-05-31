// src/main/channel-permissions.ts
import { getGateway } from './hooks/index'
import { getSessionMeta } from './session-registry'
import { appendLedger } from './channel-ledger'
import { pushPendingPermissions } from './ipc/channel-handlers'
import { readConfig } from './config-manager'
import { detectHighRisk } from './permission-core'
import type { PendingPermission } from '../shared/channel-types'
import type { HookEvent } from '../shared/hook-types'

// Genuine-only tray (v1.5.17+). CCC is NOT the permission gate; Claude's own
// settings decide. We surface ONLY `Notification(permission_prompt)` events
// (they fire only when settings did NOT auto-approve), enriched with the
// session's blocked tool. Cards deep-link or dismiss -- they never answer Claude.
const PENDING_CAP = 50
const pending = new Map<string, PendingPermission>()
// Per session: tools that fired PreToolUse with no matching PostToolUse yet,
// keyed by Claude's `tool_use_id` (insertion-ordered). A permission_prompt
// Notification carries NO tool detail, so the still-in-flight tool is the
// blocked one and is used to enrich the card. v1.5.18: keying by tool_use_id
// (instead of a single per-session slot) means an auto-approved SIBLING tool
// completing no longer wipes the blocked tool's detail -- that was the v1.5.17
// "Claude needs your permission" generic-message bug under parallel tool calls.
const inflight = new Map<string, Map<string, { tool: string; preview: string }>>()
// cardRequestId -> the tool_use_id we enriched it from, so the MATCHING
// PostToolUse dismisses exactly that card and a sibling's PostToolUse does not.
const cardTool = new Map<string, string | undefined>()
let started = false

export function getPending(): PendingPermission[] { return [...pending.values()] }

/** Test seam: reset module state between cases. */
export function _resetPending(): void { pending.clear(); inflight.clear(); cardTool.clear() }

function trayEnabled(): boolean {
  // Mirror cloud-agent-manager.ts -- read AppSettings fresh; default ON.
  return readConfig<{ permissionTrayEnabled?: boolean }>('settings')?.permissionTrayEnabled !== false
}

function isPermissionPrompt(e: HookEvent): boolean {
  return e.event === 'Notification' &&
    (e.payload as { notification_type?: string }).notification_type === 'permission_prompt'
}

function toolUseId(e: HookEvent): string | undefined {
  const id = (e.payload as { tool_use_id?: unknown }).tool_use_id
  return typeof id === 'string' ? id : undefined
}

function previewFor(e: HookEvent): { tool: string; preview: string } {
  const pl = e.payload as {
    tool?: string; command?: string; arguments?: string
    tool_input?: { command?: string; file_path?: string; url?: string; query?: string }
  }
  const tool = e.toolName ?? pl.tool ?? 'tool'
  // Bash -> command, Edit/Write/Read -> file_path, WebFetch -> url, WebSearch -> query.
  const preview = String(
    pl.tool_input?.command ?? pl.tool_input?.file_path ?? pl.tool_input?.url ??
    pl.tool_input?.query ?? pl.command ?? pl.arguments ?? '',
  )
  return { tool, preview }
}

function dismissForSession(sessionId: string): void {
  let changed = false
  for (const [id, p] of pending) if (p.sessionId === sessionId) { pending.delete(id); cardTool.delete(id); changed = true }
  if (changed) pushPendingPermissions(getPending())
}

// Dismiss exactly the card(s) enriched from this tool_use_id (the approve path:
// the blocked tool ran, so its PostToolUse arrives and the prompt is resolved).
function dismissCardByTool(sessionId: string, tuid: string): void {
  let changed = false
  for (const [id, p] of pending) {
    if (p.sessionId === sessionId && cardTool.get(id) === tuid) {
      pending.delete(id); cardTool.delete(id); changed = true
    }
  }
  if (changed) pushPendingPermissions(getPending())
}

function captureNotification(e: HookEvent): void {
  if (!trayEnabled()) return
  const meta = getSessionMeta(e.sessionId)
  // The blocked tool is whatever is still in-flight; pick the most recent.
  const m = inflight.get(e.sessionId)
  const entries = m ? [...m.entries()] : []
  const [enrichTuid, enrich] = entries.length ? entries[entries.length - 1] : [undefined, undefined]
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
    if (oldest) { pending.delete(oldest); cardTool.delete(oldest) }
  }
  pending.set(id, p)
  cardTool.set(id, enrichTuid)
  appendLedger({ source: 'permission', target: p.sessionLabel, transport: null, kind: 'permission-prompt', summary: `${p.tool}: ${p.payloadPreview}` })
  pushPendingPermissions(getPending())
}

function track(e: HookEvent): void {
  if (e.event === 'PreToolUse') {
    const tuid = toolUseId(e) ?? `${e.sessionId}-${e.ts}`
    const m = inflight.get(e.sessionId) ?? new Map<string, { tool: string; preview: string }>()
    m.set(tuid, previewFor(e))
    inflight.set(e.sessionId, m)
    return
  }
  if (e.event === 'PostToolUse') {
    const tuid = toolUseId(e)
    const m = inflight.get(e.sessionId)
    if (m && tuid) { m.delete(tuid); if (m.size === 0) inflight.delete(e.sessionId) }
    // Approve path: the blocked tool ran -> dismiss exactly its card.
    if (tuid) dismissCardByTool(e.sessionId, tuid)
    return
  }
  if (e.event === 'Stop') {
    // Turn ended -> any still-open prompt is moot; clear tracking + cards.
    inflight.delete(e.sessionId)
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
  cardTool.delete(p.requestId)
  appendLedger({ source: 'permission', target: card.sessionLabel, transport: null, kind: 'permission-dismiss', summary: `ignored ${card.tool}` })
  pushPendingPermissions(getPending())
  return { ok: true }
}
