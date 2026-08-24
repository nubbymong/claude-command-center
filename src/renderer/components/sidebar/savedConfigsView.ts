// Running-config detection for the sessions panel.
//
// History: this module held the pure half of the #362 cards/find views. The
// two-mode Sessions panel (design pass 2026-08-24) superseded those views and
// their helpers went with them; what remains is the one fact several surfaces
// still share — which saved configs have live sessions, and HOW MANY (owner
// revision 2026-08-24: a config may relaunch while running, so the surfaces
// show a count instead of locking).

import type { Session } from '../../stores/sessionStore'

/**
 * Live-session COUNT per saved config id. The Ask Conductor session is
 * deliberately config-less (see sessionStore.Session.kind) and is skipped, so
 * it can never mark a config running.
 */
export function runningConfigCounts(sessions: ReadonlyArray<Pick<Session, 'configId' | 'kind'>>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    if (s.kind === 'ask') continue
    if (s.configId) counts.set(s.configId, (counts.get(s.configId) ?? 0) + 1)
  }
  return counts
}

