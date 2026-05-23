/**
 * P8.14: IPC handlers backing the account-attribution back-fill wizard.
 *
 *   - TOKENOMICS_LIST_UNATTRIBUTED: returns groups of unattributed sessions
 *     bucketed by configId, each with a suggested email computed from the
 *     account-change timeline (oauthAccount.json backups).
 *   - TOKENOMICS_ATTRIBUTE_SESSIONS: writes wizard / per-record choices
 *     (assign-email | mark-mixed | clear) to the tokenomics store.
 */

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { applyAttributionPayload, listUnattributedGroups } from '../tokenomics-manager'
import { buildAccountTimeline } from '../account-attribution'
import type { AttributionPayload } from '../../shared/types'

export function registerAccountAttributionHandlers(): void {
  ipcMain.handle(IPC.TOKENOMICS_LIST_UNATTRIBUTED, async () => {
    const timeline = buildAccountTimeline()
    return listUnattributedGroups(timeline)
  })

  ipcMain.handle(IPC.TOKENOMICS_ATTRIBUTE_SESSIONS, async (_event, payload: AttributionPayload) => {
    try {
      applyAttributionPayload(payload)
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'attribution failed'
      return { ok: false, error: message }
    }
  })
}
