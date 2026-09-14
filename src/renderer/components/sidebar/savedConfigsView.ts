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

/**
 * A 1-based instance ordinal per session id, ONLY for sessions whose config has
 * two or more live instances (#454). Three sessions of "App Dev" become #1/#2/#3
 * so the otherwise-identical rows (same label, same identity colour) are
 * navigable; a config with a single live session gets no ordinal (nothing to
 * disambiguate).
 *
 * Ordered by ARRAY position, not createdAt: createdAt is not persisted and every
 * session restored on relaunch is stamped the same instant (App.tsx), so a
 * createdAt sort is non-deterministic after a restart, whereas array order is
 * creation order in-run and survives restore. (Known wart: an in-session
 * Restart removes+re-adds the record, moving it to the end — a restarted
 * instance renumbers to the highest ordinal. Acceptable: the numbers stay
 * unique and stable until the next Restart, and the pill's "open the latest"
 * already selects that same last-in-array instance.)
 *
 * Derived, never baked into `label`: the label is copied into logs, the SSH
 * close dialog and session-state.json, and is overridden by `customName` at
 * every display site — an ordinal belongs only in the row, computed live.
 */
export function sessionInstanceOrdinals(
  sessions: ReadonlyArray<Pick<Session, 'id' | 'configId' | 'kind'>>,
): Map<string, number> {
  const counts = new Map<string, number>()
  const running = sessions.filter((s) => s.kind !== 'ask' && !!s.configId)
  const totals = new Map<string, number>()
  for (const s of running) totals.set(s.configId!, (totals.get(s.configId!) ?? 0) + 1)
  const ordinals = new Map<string, number>()
  for (const s of running) {
    if ((totals.get(s.configId!) ?? 0) < 2) continue // single instance: no ordinal
    const n = (counts.get(s.configId!) ?? 0) + 1
    counts.set(s.configId!, n)
    ordinals.set(s.id, n)
  }
  return ordinals
}

