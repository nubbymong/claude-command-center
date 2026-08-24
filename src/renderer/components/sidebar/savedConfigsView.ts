// Running-config detection for the sessions panel.
//
// History: this module held the pure half of the #362 cards/find views. The
// two-mode Sessions panel (design pass 2026-08-24) superseded those views and
// their helpers went with them; what remains is the one fact several surfaces
// still share — which saved configs have a live session. The Saved tab locks
// those rows, Quick Start omits them, and launch paths skip them.

import type { Session } from '../../stores/sessionStore'

/**
 * Ids of the saved configs that currently have a live session. The Ask
 * Conductor session is deliberately config-less (see sessionStore.Session.kind)
 * and is skipped here too, so it can never hide a config.
 */
export function runningConfigIds(sessions: ReadonlyArray<Pick<Session, 'configId' | 'kind'>>): Set<string> {
  const ids = new Set<string>()
  for (const s of sessions) {
    if (s.kind === 'ask') continue
    if (s.configId) ids.add(s.configId)
  }
  return ids
}
