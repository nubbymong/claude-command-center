import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { createInitialHealth } from '../../shared/service-health'
import type { DiagnosticsSnapshot, PtyIntegritySnapshot, ServiceLogEntry } from '../../shared/service-health'
import type { ServiceSupervisor } from '../services/service-supervisor'

type SupGetter = () => Pick<ServiceSupervisor, 'getDiagnosticsSnapshot' | 'manualRestart'> | null
type PtyGetter = () => { snapshot: PtyIntegritySnapshot; logs: ServiceLogEntry[] } | null

// Mirrors ServiceSupervisor's own LOG_CAP (service-supervisor.ts) so the merged
// tail matches the size the diagnostics panel already expects.
const LOG_CAP = 200

/** Pure: the live supervisor snapshot (or an honest synthetic "hooks off"
 *  snapshot when no supervisor exists), with the PTY-integrity block merged in
 *  and the pty log ring folded into the global log (sorted by ts, capped). */
export function getMergedDiagnostics(getSup: SupGetter, getPty: PtyGetter): DiagnosticsSnapshot {
  const sup = getSup()
  const base: DiagnosticsSnapshot = sup
    ? sup.getDiagnosticsSnapshot()
    : { capturedAt: Date.now(), services: [{ ...createInitialHealth('hooks', 'Hooks gateway'), state: 'stopped' }], log: [] }
  const pd = getPty()
  if (!pd) return base
  const log = [...base.log, ...pd.logs].sort((a, b) => a.ts - b.ts)
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
  return { ...base, log, pty: pd.snapshot }
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
