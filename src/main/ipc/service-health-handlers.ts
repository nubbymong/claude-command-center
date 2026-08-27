import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { createInitialHealth } from '../../shared/service-health'
import type { DiagnosticsSnapshot, PtyIntegritySnapshot, ServiceLogEntry } from '../../shared/service-health'
import type { ServiceSupervisor } from '../services/service-supervisor'
import type { WatchdogManager } from '../watchdog/watchdog-manager'
import { getLogSupervisor } from '../logging/logging-service'
import { stallsLastMin as mainLoopStallsLastMin } from '../services/loop-stall-monitor'

type SupGetter = () => Pick<ServiceSupervisor, 'getDiagnosticsSnapshot' | 'manualRestart'> | null
type PtyGetter = () => { snapshot: PtyIntegritySnapshot; logs: ServiceLogEntry[] } | null
type WatchdogGetter = () => Pick<WatchdogManager, 'getDiagnosticsSnapshot' | 'getMonitorSnapshot' | 'manualRestart'> | null

// Mirrors ServiceSupervisor's own LOG_CAP (service-supervisor.ts) so the merged
// tail matches the size the diagnostics panel already expects.
const LOG_CAP = 200

/** Pure: the live supervisor snapshot (or an honest synthetic "hooks off"
 *  snapshot when no supervisor exists), with the PTY-integrity block merged in,
 *  the pty log ring folded into the global log (sorted by ts, capped), and the
 *  logging supervisor's service entry appended (§14 Phase-1 verifiability —
 *  lets the Conductor pill/panel surface the logging worker's health). */
export function getMergedDiagnostics(getSup: SupGetter, getPty: PtyGetter, getWatchdog: WatchdogGetter = () => null): DiagnosticsSnapshot {
  const sup = getSup()
  const base: DiagnosticsSnapshot = sup
    ? sup.getDiagnosticsSnapshot()
    : { capturedAt: Date.now(), services: [{ ...createInitialHealth('hooks', 'Hooks gateway'), state: 'stopped' }], log: [] }

  // Merge the logging supervisor snapshot (null when logging is disabled or not
  // yet initialised — guard so the hooks-only display is unchanged in that case).
  const logSup = getLogSupervisor()
  let merged: DiagnosticsSnapshot = base
  if (logSup) {
    const logSnap = logSup.getDiagnosticsSnapshot()
    const services = [...base.services, ...logSnap.services]
    const logEntries = [...base.log, ...logSnap.log].sort((a, b) => a.ts - b.ts)
    if (logEntries.length > LOG_CAP) logEntries.splice(0, logEntries.length - LOG_CAP)
    merged = { ...base, services, log: logEntries }
  }

  const pd = getPty()
  let withPty: DiagnosticsSnapshot
  if (!pd) {
    withPty = merged
  } else {
    const log = [...merged.log, ...pd.logs].sort((a, b) => a.ts - b.ts)
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
    withPty = { ...merged, log, pty: pd.snapshot }
  }

  // Fold in the session watchdog (#235): its ServiceHealth row + log, plus the
  // per-session monitor snapshot for the bespoke panel section. Guard so the
  // display is unchanged when the manager is not initialised.
  const wd = getWatchdog()
  let withWd: DiagnosticsSnapshot = withPty
  if (wd) {
    // One monitor snapshot per merge: getDiagnosticsSnapshot derives its
    // ServiceHealth from the same snapshot, and the per-silent-session pane
    // read it now carries (RC8 hasMonitors) should run once, not twice.
    const mon = wd.getMonitorSnapshot()
    const wdSnap = wd.getDiagnosticsSnapshot(mon)
    const log = [...withPty.log, ...wdSnap.log].sort((a, b) => a.ts - b.ts)
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
    withWd = { ...withPty, services: [...withPty.services, ...wdSnap.services], log, watchdog: mon }
  }

  // Stamp the MAIN-process event-loop jank onto EVERY service (both delivery
  // paths — pushDiagnostics in index.ts and the GET handler — funnel through
  // here, so this single stamp covers both). The child loop's own jank arrives
  // per-service over the heartbeat; this is the missing main half of "Jank m/c".
  const mainStalls = mainLoopStallsLastMin()
  return {
    ...withWd,
    services: withWd.services.map((s) => ({ ...s, mainLoopStallsLastMin: mainStalls })),
  }
}

export function buildRestart(getSup: SupGetter, getWatchdog: WatchdogGetter = () => null): (serviceId: string) => { ok: boolean; reason?: string } {
  return (serviceId) => {
    // The logging worker is owned by a SEPARATE supervisor (LogSupervisor) with no
    // in-process fallback; route its restart there so a permanently-degraded logging
    // service can actually be revived (the hooks supervisor would only answer
    // 'unknown-service' for it).
    if (serviceId === 'logging') {
      const logSup = getLogSupervisor()
      if (!logSup) return { ok: false, reason: 'no-supervisor' }
      return logSup.manualRestart(serviceId)
    }
    // The watchdog is its own subsystem (per-session, no supervisor).
    if (serviceId === 'watchdog') {
      const wd = getWatchdog()
      if (!wd) return { ok: false, reason: 'no-supervisor' }
      return wd.manualRestart(serviceId)
    }
    const sup = getSup()
    if (!sup) return { ok: false, reason: 'no-supervisor' }
    return sup.manualRestart(serviceId)
  }
}

export function registerServiceHealthHandlers(getSup: SupGetter, getPty: PtyGetter = () => null, getWatchdog: WatchdogGetter = () => null): void {
  const restart = buildRestart(getSup, getWatchdog)
  ipcMain.handle(IPC.SERVICE_HEALTH_GET, async () => getMergedDiagnostics(getSup, getPty, getWatchdog))
  ipcMain.handle(IPC.SERVICE_RESTART, async (_e, serviceId: string) => restart(serviceId))
}
