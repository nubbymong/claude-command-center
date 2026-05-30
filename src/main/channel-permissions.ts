// src/main/channel-permissions.ts
import { getGateway } from './hooks/index'
import { getSessionMeta } from './session-registry'
import { matchApproval } from './standing-approvals-store'
import { appendLedger } from './channel-ledger'
import { pushPendingPermissions } from './ipc/channel-handlers'
import { normalizePermission, decideDisposition } from './permission-core'
import { resolveResponder } from './permission-responders'
import type { PendingPermission } from '../shared/channel-types'
import type { HookEvent } from '../shared/hook-types'

const PENDING_CAP = 50
const pending = new Map<string, PendingPermission>()
let started = false

export function getPending(): PendingPermission[] { return [...pending.values()] }

// The responder map moved to ./permission-responders so the hook gateway can
// import it directly without the historic circular-import workaround. Re-
// export the two surface functions for the existing call-sites (gateway uses
// the lazy require path below for backward compat with on-the-wire callers).
export { registerResponder, deregisterResponder } from './permission-responders'

function isPermissionEvent(e: HookEvent): boolean {
  if (e.event === 'PermissionRequest') return true
  if (e.event === 'PreToolUse') return true
  // Notification(permission_prompt) is NOT a tray card: under the universal gate
  // CCC decides before Claude would prompt, so it rarely fires; when it does
  // (a settings ask-rule overriding a hook allow) it is an unanswerable on-screen
  // prompt -> handled by the attention flasher (attention-source.ts), not here.
  return false
}

function capture(e: HookEvent): void {
  const meta = getSessionMeta(e.sessionId)
  const p = normalizePermission(e, { label: meta?.label ?? e.sessionId, provider: meta?.provider, identityColorKey: meta?.identityColorKey })

  const disposition = decideDisposition(p, (tool) => matchApproval(tool))
  if (disposition === 'auto-allow') {
    // Only ledger when a standing approval drove the allow (worth a record).
    // Read-only safelist tools fire on every Read/Grep; ledgering them would
    // hammer the disk + redactor on the hot path (spec section 4.3).
    if (matchApproval(p.tool)) {
      appendLedger({ source: 'permission', target: p.sessionLabel, transport: null, kind: 'permission-auto-allow', summary: `${p.tool}: ${p.payloadPreview}` })
    }
    resolveResponder(p.requestId, 'approved')
    return
  }

  if (pending.size >= PENDING_CAP) {
    appendLedger({ source: 'permission', target: p.sessionLabel, transport: null, kind: 'tray-overflow', summary: `released to Claude (tray full): ${p.tool}` })
    // Release to Claude's own prompt rather than denying real work. 'defer' closes
    // the held-open response with an empty body IMMEDIATELY (no 120s stall), so
    // Claude falls back to its in-terminal prompt right away.
    resolveResponder(p.requestId, 'defer')
    return
  }

  pending.set(p.requestId, p)
  appendLedger({ source: 'permission', target: p.sessionLabel, transport: null, kind: 'permission-prompt', summary: `${p.tool}: ${p.payloadPreview}` })
  pushPendingPermissions(getPending())
}

export function startPermissionTray(): void {
  if (started) return
  started = true
  const gw = getGateway()
  if (gw) gw.subscribe((e) => { if (isPermissionEvent(e)) capture(e) })
}

export function resolvePending(requestId: string, decision: 'approved' | 'denied'): void {
  const p = pending.get(requestId)
  if (!p) return
  pending.delete(requestId)
  appendLedger({ source: 'permission', target: p.sessionLabel, transport: p.transport === 'mcp' ? 'mcp' : null, kind: decision === 'approved' ? 'permission-approve' : 'permission-deny', summary: `${p.tool}: ${p.payloadPreview}` })
  resolveResponder(requestId, decision)
  pushPendingPermissions(getPending())
}

export function respondPermission(p: { requestId: string; decision: 'allow' | 'deny' | 'allow-once' }): { ok: boolean } {
  const had = pending.has(p.requestId)
  const mapped = p.decision === 'deny' ? 'denied' : 'approved'
  resolvePending(p.requestId, mapped)
  return { ok: had }
}
