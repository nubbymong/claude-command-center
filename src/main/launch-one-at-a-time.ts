// P3.13 (row 72; the C item "the one-at-a-time Multi Spawn rule is enforced
// only in the renderer"): main holds a saved config to its rule at pty:spawn,
// the one path every launch of a session takes (a new launch, a restored
// session, a Restart, each copy of a Multi Spawn, Quick Start).
//
// THE RULE (src/shared/multi-spawn-rule.ts, the one the renderer's launch
// surfaces ask too): a saved config that is not Multi Spawn runs ONE copy at a
// time. The rule gates NEW copies. A spawn that names such a config while
// another session of it is live is refused, before anything is installed,
// prepared, leased or spawned, with the refusal the terminal tab already knows
// how to say (answered, never thrown). A session that already has the right to
// run keeps it (below).
//
// WHAT MAIN KNOWS, and no more: whether a config is Multi Spawn is read from
// the saved configs on disk, never from the request (a request that says
// `allowMultiSpawn` is not asked). Which sessions are copies of it is main's
// own record of the spawns it accepted: `inflight` for a spawn that passed this
// gate and is not yet accepted by pty-manager, `held` for one it accepted, and
// `restored` for the sessions saved at the last quit. Whether a copy is LIVE is
// asked of pty-manager at the moment of asking, never counted here, so nothing
// has to be told when a session ends.
//
// ATOMIC: the question and the in-flight claim are one synchronous step, taken
// in the same tick as pty:spawn's provider check and before its first await.
// Every path with an await registers its spawn with pty-manager before it (a
// launch preparation), and a path with none reaches the PTY in the same tick,
// so a second copy asked for in between always finds the first.
//
// WHO KEEPS THE RIGHT TO RUN (never a new copy, so never refused):
//   - a session accepted for this config in THIS RUN: a Restart, a Switch of
//     account, a Recover and an SSH reattach respawn their own session, with or
//     without another copy live, whatever the config says now (Multi Spawn may
//     have been unticked while the copies ran). The right outlives the process
//     (a Restart kills it first) and is bounded (HELD_MAX, the oldest first);
//   - a session RESTORED at this start: the ids main read from the saved
//     session state at the first load (seedRestoredSessions, from
//     app-session-durability's read-back, never from anything the renderer
//     sends), each for the config it was saved with, until its first accepted
//     spawn. Remotes left running count too (their reattach reuses the id).
//   A right is for ONE config: the same id naming another config is a new copy
//   of that one.
//
// WHAT IS NOT A COPY OF A CONFIG (and carries no exemption beyond this):
//   - a spawn that names no saved config (nothing to count);
//   - the renderer's own partner terminal, in its exact shape: shell-only, the
//     id `<session id>-partner`, the config's id, no ssh block, no terminal
//     options and no elevation, and only for a session main holds (accepted in
//     this run, or restored). It is the one plain shell of a session; anything
//     with more on it (credentials, a secret argument) is a copy like any other.
//
// A spawn is recorded as a copy only once it is ACCEPTED (settleConfigLaunch,
// called by pty:spawn straight after pty-manager took it). A live session's
// record is never re-pointed by a spawn that is refused or throws; a session
// later spawned as a non-copy stops counting as a copy.
//
// NOT A SECURITY BOUNDARY, as the rule was not in the renderer: a request made
// by something that can choose its own spawn options can leave the config out.
// What this closes is the renderer being the only place the rule lived: a
// launch surface that forgot to ask, a stale render, a second path.
import { findSavedConfig } from './spawn-credential-binding'
import { isOneAtATimeBlocked, alreadyRunningRefusalMessage, isPartnerPtyId, partnerBaseId } from '../shared/multi-spawn-rule'
import { stripSpoofableText } from '../shared/safe-text'
import type { ProviderId, SpawnRefusal } from '../shared/providers'
import { logWarn } from './debug-logger'

/** What the rule reads of a spawn request. */
export interface ConfigLaunchRequest {
  configId?: string
  shellOnly?: boolean
  provider?: ProviderId
  elevated?: boolean
  /** Only whether these are present is read (the partner shell carries neither). */
  ssh?: unknown
  terminalOptions?: unknown
}

export interface ConfigLaunchDeps {
  /** The saved configs as main reads them from disk. Called only when the
   *  request names a config the rule applies to. */
  savedConfigs: () => unknown
  /** Whether main holds this session: running, or accepted and starting. */
  isLive: (sessionId: string) => boolean
}

/** Sessions accepted in this run: session id -> the saved config it runs. Their
 *  right to respawn outlives their process; past the bound the oldest go. */
const held = new Map<string, string>()
export const HELD_MAX = 512

/** Spawns that passed the gate and are not yet accepted: session id -> the
 *  config they would be a copy of, or null for a spawn that is not a copy.
 *  Dropped at the next look once the session is not live. */
const inflight = new Map<string, string | null>()

/** Sessions saved at the last quit, read from the saved session state: id ->
 *  the config each was saved with. A right until the id's first accepted spawn. */
const restored = new Map<string, string>()
export const RESTORED_MAX = 1024
let restoreSeeded = false

/** The same charset pty:spawn holds a session id to (sessionIdSchema). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/

/** The config's name as the refusal says it: the user's own text for it, made
 *  safe to show in a terminal. */
function labelOf(saved: object): string {
  const label = (saved as { label?: unknown }).label
  const text = typeof label === 'string' ? stripSpoofableText(label, 100).trim() : ''
  return text === '' ? 'This config' : text
}

/** The spawn is not a copy of a config: nothing to ask, and it stops counting
 *  as a copy once it is accepted. */
function notACopy(sessionId: string): null {
  inflight.set(sessionId, null)
  return null
}

/** Whether main holds this session for this config: accepted in this run, or
 *  restored at this start. */
function holds(sessionId: string, configId: string): boolean {
  return held.get(sessionId) === configId || restored.get(sessionId) === configId
}

/** The renderer's own partner terminal, exactly as it starts one. */
function isPartnerShell(sessionId: string, configId: string, request: ConfigLaunchRequest): boolean {
  return request.shellOnly === true
    && isPartnerPtyId(sessionId)
    && request.ssh === undefined
    && request.terminalOptions === undefined
    && request.elevated !== true
    && holds(partnerBaseId(sessionId), configId)
}

/**
 * Ask the rule for a spawn about to start `sessionId`, and, when it passes,
 * record it as in flight. Returns the refusal to answer with (nothing is
 * recorded then), or null to go ahead.
 */
export function claimConfigLaunch(sessionId: string, request: ConfigLaunchRequest | undefined, deps: ConfigLaunchDeps): SpawnRefusal | null {
  const configId = request?.configId
  if (!request || typeof configId !== 'string' || configId === '') return notACopy(sessionId)
  if (isPartnerShell(sessionId, configId, request)) return notACopy(sessionId)
  const saved = findSavedConfig(deps.savedConfigs(), configId)
  if (!saved) return notACopy(sessionId)

  // The other copies of this config that main still holds. A session counts for
  // the config it was ACCEPTED for (held), else for the one it is starting for
  // (inflight); a spawn that did not start is dropped on the way.
  for (const id of inflight.keys()) if (id !== sessionId && !deps.isLive(id)) inflight.delete(id)
  let others = 0
  for (const id of new Set([...held.keys(), ...inflight.keys()])) {
    if (id === sessionId) continue
    if ((held.get(id) ?? inflight.get(id)) === saved.id && deps.isLive(id)) others++
  }

  const keepsItsRight = holds(sessionId, saved.id)
  if (!keepsItsRight && isOneAtATimeBlocked((saved as { allowMultiSpawn?: unknown }).allowMultiSpawn, others)) {
    logWarn(`[launch] session ${sessionId} refused: config ${stripSpoofableText(saved.id, 64)} is not Multi Spawn and is already running`)
    return { code: 'already-running', providerId: request.provider ?? 'claude', message: alreadyRunningRefusalMessage(labelOf(saved)) }
  }
  inflight.set(sessionId, saved.id)
  return null
}

/**
 * pty-manager accepted the spawn the gate passed for `sessionId`: main now
 * holds the session's right to run again (or, for a spawn that is not a copy,
 * none). Never called for a spawn that was refused or threw, so such a spawn
 * changes nothing about what main already holds.
 */
export function settleConfigLaunch(sessionId: string): void {
  if (!inflight.has(sessionId)) return
  const config = inflight.get(sessionId)
  inflight.delete(sessionId)
  held.delete(sessionId)
  if (typeof config !== 'string') return
  held.set(sessionId, config)
  restored.delete(sessionId)
  for (const id of held.keys()) {
    if (held.size <= HELD_MAX) break
    if (id !== sessionId && !inflight.has(id)) held.delete(id)
  }
}

/**
 * Seed the sessions restored at this start from the saved session state main
 * read at the first load of this run (app-session-durability's read-back): the
 * sessions it saved, and the remotes it recorded as left running, each for the
 * config it was saved with. Only the first load seeds, so a later load (the
 * resume prompt's Refresh, which can list tabs opened in this run) adds
 * nothing. A restored copy that comes back Not started keeps its right until it
 * starts.
 */
export function seedRestoredSessions(state: unknown): void {
  if (restoreSeeded || !state || typeof state !== 'object') return
  restoreSeeded = true
  const { sessions, detachedRemotes } = state as { sessions?: unknown; detachedRemotes?: unknown }
  const add = (id: unknown, configId: unknown): void => {
    if (restored.size >= RESTORED_MAX) return
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return
    if (typeof configId !== 'string' || configId === '' || configId.length > 200) return
    restored.set(id, configId)
  }
  if (Array.isArray(sessions)) {
    for (const s of sessions.slice(0, RESTORED_MAX)) {
      if (!s || typeof s !== 'object') continue
      const e = s as { id?: unknown; configId?: unknown; kind?: unknown }
      if (e.kind === 'ask') continue
      add(e.id, e.configId)
    }
  }
  if (Array.isArray(detachedRemotes)) {
    for (const r of detachedRemotes.slice(0, RESTORED_MAX)) {
      if (!r || typeof r !== 'object') continue
      const e = r as { sessionId?: unknown; configId?: unknown }
      add(e.sessionId, e.configId)
    }
  }
}

/** Test seam: how many sessions the rule is holding (accepted or in flight). */
export function _claimedSessionCountForTest(): number {
  return held.size + inflight.size
}

/** Test seam: forget everything, as at a fresh start. */
export function _resetConfigLaunchClaimsForTest(): void {
  held.clear()
  inflight.clear()
  restored.clear()
  restoreSeeded = false
}
