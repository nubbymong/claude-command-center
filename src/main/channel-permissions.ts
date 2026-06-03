// src/main/channel-permissions.ts
import { getGateway } from './hooks/index'
import { getSessionMeta } from './session-registry'
import { appendLedger } from './channel-ledger'
import { pushPendingPermissions } from './ipc/channel-handlers'
import { readConfig } from './config-manager'
import { detectHighRisk } from './permission-core'
import { getActiveSessionId } from './active-session'
import { logDebug } from './debug-logger'
import type { PendingPermission } from '../shared/channel-types'
import type { HookEvent } from '../shared/hook-types'

// Genuine-only tray (v1.5.17+). CCC is NOT the permission gate; Claude's own
// settings decide. We surface ONLY `Notification(permission_prompt)` events,
// enriched with the session's blocked tool. Cards deep-link or dismiss -- they
// never answer Claude.
//
// Bug 1 (false-positive cards): a permission_prompt can fire (or mis-enrich a
// stale in-flight tool that never blocks, e.g. Glob/read-only/MCP query) for a
// tool that then PROCEEDS. Such a card was surfaced immediately and -- when the
// tool's PostToolUse carried no matching tool_use_id -- never dismissed, so it
// lingered as a phantom "needs your permission". Fix: a permission card now
// represents "Claude is genuinely still waiting". We DEFER surfacing by a short
// grace window; if the enriched tool's PostToolUse arrives first (it proceeded),
// the candidate is cancelled and no card ever appears. Genuinely-blocked tools
// have no PostToolUse, so they surface after the grace window as before.
const PENDING_CAP = 50
// Grace window before a permission_prompt becomes a visible card. Long enough to
// catch an auto-approved/proceeding tool's PostToolUse, short enough that a real
// block surfaces without a perceptible lag.
const GRACE_MS = 500
const pending = new Map<string, PendingPermission>()
// Per session: tools that fired PreToolUse with no matching PostToolUse yet,
// keyed by Claude's `tool_use_id` (insertion-ordered) -> { tool, preview }.
const inflight = new Map<string, Map<string, { tool: string; preview: string }>>()
// cardRequestId -> the tool_use_id we enriched it from, so the MATCHING
// PostToolUse dismisses exactly that card and a sibling's PostToolUse does not.
const cardTool = new Map<string, string | undefined>()
// Per session: deferred candidates awaiting the grace window. A candidate is
// cancelled by the matching PostToolUse (tool proceeded) or by Stop.
type Candidate = { card: PendingPermission; tuid: string | undefined; tool: string; timer: ReturnType<typeof setTimeout> }
const candidates = new Map<string, Map<string, Candidate>>()
let started = false

export function getPending(): PendingPermission[] { return [...pending.values()] }

/** Test seam: reset module state between cases. */
export function _resetPending(): void {
  pending.clear(); inflight.clear(); cardTool.clear()
  for (const sm of candidates.values()) for (const c of sm.values()) clearTimeout(c.timer)
  candidates.clear()
}

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

/** A PostToolUse may carry the tool name even when it omits tool_use_id. */
function eventToolName(e: HookEvent): string | undefined {
  const pl = e.payload as { tool_name?: unknown; tool?: unknown }
  return e.toolName ?? (typeof pl.tool_name === 'string' ? pl.tool_name : typeof pl.tool === 'string' ? pl.tool : undefined)
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

/** Cancel deferred candidates for a session that match the resolved tool -- by
 *  tool_use_id when present, else by tool name. Returns nothing; clears timers. */
function cancelCandidates(sessionId: string, tuid: string | undefined, toolName: string | undefined): void {
  const sm = candidates.get(sessionId)
  if (!sm) return
  for (const [id, c] of sm) {
    const match = tuid !== undefined ? c.tuid === tuid : (toolName !== undefined && c.tool === toolName)
    if (match) { clearTimeout(c.timer); sm.delete(id) }
  }
  if (sm.size === 0) candidates.delete(sessionId)
}

function clearCandidates(sessionId: string): void {
  const sm = candidates.get(sessionId)
  if (!sm) return
  for (const c of sm.values()) clearTimeout(c.timer)
  candidates.delete(sessionId)
}

/** Grace window elapsed with the tool still blocked -> surface the card. */
function surfaceCandidate(sessionId: string, candidateId: string): void {
  const sm = candidates.get(sessionId)
  const c = sm?.get(candidateId)
  if (!sm || !c) return
  sm.delete(candidateId)
  if (sm.size === 0) candidates.delete(sessionId)

  if (pending.size >= PENDING_CAP) {
    const oldest = pending.keys().next().value
    if (oldest) { pending.delete(oldest); cardTool.delete(oldest) }
  }
  pending.set(candidateId, c.card)
  cardTool.set(candidateId, c.tuid)
  const active = getActiveSessionId()
  logDebug(`[perm-tray] card session=${sessionId} active=${active ?? 'none'} suppressForActive=${active === sessionId} tool=${c.card.tool} enriched=${c.tool !== 'Permission' ? 'yes' : 'no'}`)
  appendLedger({ source: 'permission', target: c.card.sessionLabel, transport: null, kind: 'permission-prompt', summary: `${c.card.tool}: ${c.card.payloadPreview}` })
  pushPendingPermissions(getPending())
}

function captureNotification(e: HookEvent): void {
  if (!trayEnabled()) return
  const meta = getSessionMeta(e.sessionId)
  // The blocked tool is whatever is still in-flight; pick the most recent.
  const m = inflight.get(e.sessionId)
  const entries = m ? [...m.entries()] : []
  const [enrichTuid, enrich] = entries.length ? entries[entries.length - 1] : [undefined, undefined]
  const id = `${e.sessionId}-${e.ts}`
  const card: PendingPermission = {
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
  // Defer: only surface if the tool is still blocked after the grace window. A
  // proceeding/auto-approved tool's PostToolUse cancels this candidate first.
  const timer = setTimeout(() => surfaceCandidate(e.sessionId, id), GRACE_MS)
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
  let sm = candidates.get(e.sessionId)
  if (!sm) { sm = new Map(); candidates.set(e.sessionId, sm) }
  sm.set(id, { card, tuid: enrichTuid, tool: card.tool, timer })
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
    const toolName = eventToolName(e)
    const m = inflight.get(e.sessionId)
    // Ambiguity guard: when a Post carries no tool_use_id, count how many in-flight
    // tools share its name BEFORE we delete one. With 2+ we cannot tell which one
    // proceeded, so a name-only cancel must NOT fire (it could suppress a genuinely
    // blocked same-named sibling). Computed pre-deletion.
    const sameNameInflight = (!tuid && toolName && m) ? [...m.values()].filter((v) => v.tool === toolName).length : 0
    if (m) {
      if (tuid && m.has(tuid)) {
        m.delete(tuid)
      } else if (toolName) {
        // No id match: drop the oldest in-flight entry for this tool name so a
        // proceeding auto-approved tool (e.g. Glob) can't linger and mis-enrich
        // a later permission_prompt.
        for (const [k, v] of m) { if (v.tool === toolName) { m.delete(k); break } }
      } else {
        const first = m.keys().next().value
        if (first) m.delete(first)
      }
      if (m.size === 0) inflight.delete(e.sessionId)
    }
    // The tool proceeded -> cancel its deferred candidate (no card) and dismiss
    // any already-surfaced card (approve path). Cancel by tool_use_id when present;
    // by name only when unambiguous (exactly one in-flight tool of that name).
    const nameForCancel = tuid !== undefined ? undefined : (sameNameInflight <= 1 ? toolName : undefined)
    cancelCandidates(e.sessionId, tuid, nameForCancel)
    if (tuid) dismissCardByTool(e.sessionId, tuid)
    return
  }
  if (e.event === 'Stop') {
    // Turn ended -> any still-open prompt is moot; clear tracking + candidates + cards.
    inflight.delete(e.sessionId)
    clearCandidates(e.sessionId)
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
