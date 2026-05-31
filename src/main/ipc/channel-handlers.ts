// src/main/ipc/channel-handlers.ts
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { send, retract } from '../channel-bus'
import { loadRules, saveRule, deleteRule } from '../channel-rules-store'
import { loadApprovals, addApproval, removeApproval } from '../standing-approvals-store'
import { getFeatureState, setKillSwitch, markIntroShown } from '../channel-feature-state'
import { dismissPermission } from '../channel-permissions'
import { getCapabilityDiagnostics, forceTier } from '../channel-capability'
import type { LedgerRecord, PendingPermission } from '../../shared/channel-types'

// main -> renderer push helpers (broadcast to all windows)
export function pushPendingPermissions(list: PendingPermission[]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.CHANNELS_PENDING_PERMISSIONS, list)
}
export function pushAttention(sessionId: string, needsAttention: boolean): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(IPC.CHANNELS_ATTENTION, { sessionId, needsAttention }) } catch { /* destroyed */ }
  }
}
export function pushLedgerEvent(record: LedgerRecord): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.CHANNELS_LEDGER_EVENT, record)
}

export function registerChannelHandlers(): void {
  ipcMain.handle(IPC.CHANNELS_SEND, (_e, req) => {
    if (!req?.targetSessionId || !req?.payload) return { ok: false, reason: 'bad request' }
    return send(req)
  })
  ipcMain.handle(IPC.CHANNELS_RETRACT, (_e, p) => {
    if (!p?.targetSessionId) return { ok: false, reason: 'bad request' }
    return retract(p.targetSessionId, p.targetLabel)
  })
  ipcMain.handle(IPC.CHANNELS_DISMISS_PERMISSION, (_e, p) => dismissPermission(p))
  ipcMain.handle(IPC.CHANNELS_FORCE_TIER, (_e, p) => forceTier(p.sessionId, p.tier))
  ipcMain.handle(IPC.CHANNELS_RULE_CRUD, (_e, p) => {
    if (p.op === 'list') return loadRules()
    if (p.op === 'save') { saveRule(p.rule); return loadRules() }
    if (p.op === 'delete') { const ok = deleteRule(p.id); return { ok, rules: loadRules() } }
    return loadRules()
  })
  ipcMain.handle(IPC.CHANNELS_STANDING_APPROVAL_CRUD, (_e, p) => {
    if (p.op === 'add') { addApproval(p.tool, p.ttl); return loadApprovals() }
    if (p.op === 'remove') { removeApproval(p.id); return loadApprovals() }
    return loadApprovals()
  })
  ipcMain.handle(IPC.CHANNELS_CAPABILITY_DIAGNOSTICS, () => getCapabilityDiagnostics())
  ipcMain.handle(IPC.CHANNELS_INTRO_DISMISSED, () => { markIntroShown(); return getFeatureState() })
  ipcMain.handle(IPC.CHANNELS_KILL_SWITCH, (_e, p) => { setKillSwitch(!!p.disabled); return getFeatureState() })
  ipcMain.handle(IPC.CHANNELS_RENDERER_READY, () => {
    // Genuine-only (v1.5.17): the renderer mounts its pending-permissions +
    // attention listeners here, but CCC no longer gates permissions, so we do
    // NOT activate the hold-open path. Kept as a handshake the renderer still
    // calls; returning ok keeps the contract stable.
    return { ok: true }
  })
}
