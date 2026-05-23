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
import { join } from 'path'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { applyAttributionPayload, listUnattributedGroups } from '../tokenomics-manager'
import { buildAccountTimeline, listKnownEmails } from '../account-attribution'
import { getConfigDir } from '../config-manager'
import type { AttributionPayload } from '../../shared/types'

// Copilot review on PR #31 (p9.9): validate the incoming payload from the
// renderer at the IPC boundary, matching the convention used by
// src/main/ipc/pty-handlers.ts and src/main/ipc/webview-handlers.ts.
// Mirrors the AttributionPayload sum-type in src/shared/types.ts.
const attributionPayloadSchema: z.ZodType<AttributionPayload> = z.object({
  sessionIds: z.array(z.string().min(1).max(256)).min(1).max(10_000),
  assignment: z.union([
    z.object({ type: z.literal('email'), email: z.string().min(1).max(320) }),
    z.object({ type: z.literal('mixed') }),
    z.object({ type: z.literal('clear') }),
  ]),
})

export function registerAccountAttributionHandlers(): void {
  ipcMain.handle(IPC.TOKENOMICS_LIST_UNATTRIBUTED, async () => {
    const timeline = buildAccountTimeline()
    return listUnattributedGroups(timeline)
  })

  // Copilot review on PR #31 (p9.14): the wizard previously sourced
  // selectable emails only from groups[].suggestedEmail, leaving the user
  // stuck when the timeline could not suggest anything (no backups,
  // unreadable ~/.claude.json). This handler exposes every email we have
  // evidence for so the wizard's <select> always has options.
  //
  // Copilot review on PR #31 (p9.16): the legacy accounts.json lived at
  // `<resources>/CONFIG/accounts.json` (per config-manager's mapping),
  // NOT `~/.claude/accounts.json`. Compute the path here and pass it
  // in so account-attribution.ts stays free of config-manager imports.
  ipcMain.handle(IPC.TOKENOMICS_LIST_KNOWN_EMAILS, async () => {
    return listKnownEmails(join(getConfigDir(), 'accounts.json'))
  })

  ipcMain.handle(IPC.TOKENOMICS_ATTRIBUTE_SESSIONS, async (_event, payload: unknown) => {
    const parsed = attributionPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      return { ok: false, error: `Invalid attribution payload: ${parsed.error.message}` }
    }
    try {
      applyAttributionPayload(parsed.data)
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'attribution failed'
      return { ok: false, error: message }
    }
  })
}
