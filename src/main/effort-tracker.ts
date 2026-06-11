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
import { getRegistry } from './model-registry-service'
import { sentinelObserve } from './sentinel/index'

// DELIBERATE behaviour change (spec 2026-06-11 §3/§4): unknown effort levels
// now display verbatim instead of being silently dropped. A hardcoded VALID set
// would re-create the documented restore crash (see pty-handlers.ts effortLevel
// comment). Unknown levels are also reported to the Sentinel observer seam so
// Phase 2 can detect new CC-shipped effort values automatically.

const lastBySession = new Map<string, string>()
let started = false

let effortObserver: ((value: string) => void) | null = null
/** Sentinel Trigger A hook (wired in Phase 2); test seam until then. */
export function setEffortObserver(fn: ((value: string) => void) | null): void { effortObserver = fn }
export const _setEffortObserverForTest = setEffortObserver

export function effortFromEvent(e: HookEvent): string | undefined {
  const eff = (e.payload as { effort?: unknown }).effort
  if (!eff || typeof eff !== 'object') return undefined
  const level = (eff as { level?: unknown }).level
  if (typeof level !== 'string' || !level) return undefined
  const known = getRegistry().effortLevels.some((l) => l.value === level)
  if (!known) { try { effortObserver?.(level) } catch { /* observer must not break tracking */ } }
  return level                                // permissive: unknown levels still display (spec §3/§4)
}

function pushEffort(sessionId: string, effortLevel: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(IPC.HOOKS_EFFORT_UPDATE, { sessionId, effortLevel }) } catch { /* window destroyed */ }
  }
}

function track(e: HookEvent): void {
  // Turn ended -> drop the session's last-effort so the map can't grow
  // unbounded. Mirrors channel-permissions.ts clearing per-session state on Stop.
  if (e.event === 'Stop') { lastBySession.delete(e.sessionId); return }
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
  // Wire Sentinel Trigger A: unknown effort levels are reported for registry
  // proposals. sentinelObserve is a no-op before initSentinel (fail-open).
  setEffortObserver((v) => { try { sentinelObserve({ kind: 'effort', value: v, source: 'hooks' }) } catch { /* must not break tracking */ } })
  const gw = getGateway()
  if (gw) gw.subscribe(track)
}
