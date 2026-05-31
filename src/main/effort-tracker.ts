// src/main/effort-tracker.ts
// Live reasoning-effort tracker. Claude reports the active effort on every hook
// event as `payload.effort.level`; CCC's status strip otherwise only knows the
// effort the user picked THROUGH CCC, so a globally-set effort never shows. This
// reads the live value, dedupes per session, and pushes it to the renderer.
// Mirrors channel-permissions.ts (subscribe once at boot; push via webContents).
import { BrowserWindow } from 'electron'
import { getGateway } from './hooks/index'
import { IPC } from '../shared/ipc-channels'
import type { HookEvent } from '../shared/hook-types'

const VALID = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
const lastBySession = new Map<string, string>()
let started = false

export function effortFromEvent(e: HookEvent): string | undefined {
  const eff = (e.payload as { effort?: unknown }).effort
  if (!eff || typeof eff !== 'object') return undefined
  const level = (eff as { level?: unknown }).level
  return typeof level === 'string' && VALID.has(level) ? level : undefined
}

function pushEffort(sessionId: string, effortLevel: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(IPC.HOOKS_EFFORT_UPDATE, { sessionId, effortLevel }) } catch { /* window destroyed */ }
  }
}

function track(e: HookEvent): void {
  const level = effortFromEvent(e)
  if (!level || !e.sessionId) return
  if (lastBySession.get(e.sessionId) === level) return
  lastBySession.set(e.sessionId, level)
  pushEffort(e.sessionId, level)
}

/** Test seam. */
export function _emitForTest(e: HookEvent): void { track(e) }
/** Test seam. */
export function _resetEffort(): void { lastBySession.clear() }

export function startEffortTracker(): void {
  if (started) return
  started = true
  const gw = getGateway()
  if (gw) gw.subscribe(track)
}
