import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { createInitialHealth } from '../../shared/service-health'
import type { DiagnosticsSnapshot, PtyIntegritySnapshot, ServiceLogEntry } from '../../shared/service-health'
import type { ServiceSupervisor } from '../services/service-supervisor'
import { getLogSupervisor } from '../logging/logging-service'

type SupGetter = () => Pick<ServiceSupervisor, 'getDiagnosticsSnapshot' | 'manualRestart'> | null
type PtyGetter = () => { snapshot: PtyIntegritySnapshot; logs: ServiceLogEntry[] } | null

// Mirrors ServiceSupervisor's own LOG_CAP (service-supervisor.ts) so the merged
// tail matches the size the diagnostics panel already expects.
const LOG_CAP = 200

/** Pure: the live supervisor snapshot (or an honest synthetic "hooks off"
 *  snapshot when no supervisor exists), with the PTY-integrity block merged in,
 *  the pty log ring folded into the global log (sorted by ts, capped), and the
 *  logging supervisor's service entry appended (§14 Phase-1 verifiability —
 *  lets the Conductor pill/panel surface the logging worker's health). */
export function getMergedDiagnostics(getSup: SupGetter, getPty: PtyGetter): DiagnosticsSnapshot {
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
  if (!pd) return merged
  const log = [...merged.log, ...pd.logs].sort((a, b) => a.ts - b.ts)
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
  return { ...merged, log, pty: pd.snapshot }
}

export function buildRestart(getSup: SupGetter): (serviceId: string) => { ok: boolean; reason?: string } {
  return (serviceId) => {
    const sup = getSup()
    if (!sup) return { ok: false, reason: 'no-supervisor' }
    return sup.manualRestart(serviceId)
  }
}

export function registerServiceHealthHandlers(getSup: SupGetter, getPty: PtyGetter = () => null): void {
  const restart = buildRestart(getSup)
  ipcMain.handle(IPC.SERVICE_HEALTH_GET, async () => getMergedDiagnostics(getSup, getPty))
  ipcMain.handle(IPC.SERVICE_RESTART, async (_e, serviceId: string) => restart(serviceId))
}
