import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { createInitialHealth } from '../../shared/service-health'
import type { DiagnosticsSnapshot } from '../../shared/service-health'
import type { ServiceSupervisor } from '../services/service-supervisor'

type SupGetter = () => Pick<ServiceSupervisor, 'getDiagnosticsSnapshot' | 'manualRestart'> | null

/** Pure: returns the live supervisor snapshot, or an honest synthetic "hooks off"
 *  snapshot (state:'stopped') when no supervisor exists (hooksEnabled=false). */
export function buildHealthGet(getSup: SupGetter): () => DiagnosticsSnapshot {
  return () => {
    const sup = getSup()
    if (sup) return sup.getDiagnosticsSnapshot()
    const h = { ...createInitialHealth('hooks', 'Hooks gateway'), state: 'stopped' as const }
    return { capturedAt: Date.now(), services: [h], log: [] }
  }
}

/** Pure: delegates to the supervisor's manualRestart, or declines honestly when
 *  there is no supervisor. */
export function buildRestart(getSup: SupGetter): (serviceId: string) => { ok: boolean; reason?: string } {
  return (serviceId) => {
    const sup = getSup()
    if (!sup) return { ok: false, reason: 'no-supervisor' }
    return sup.manualRestart(serviceId)
  }
}

export function registerServiceHealthHandlers(getSup: SupGetter): void {
  const get = buildHealthGet(getSup)
  const restart = buildRestart(getSup)
  ipcMain.handle(IPC.SERVICE_HEALTH_GET, async () => get())
  ipcMain.handle(IPC.SERVICE_RESTART, async (_e, serviceId: string) => restart(serviceId))
}
