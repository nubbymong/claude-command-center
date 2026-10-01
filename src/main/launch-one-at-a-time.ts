// P3.13 (row 72; the C item "the one-at-a-time Multi Spawn rule is enforced
// only in the renderer"): main holds a saved config to its rule at pty:spawn,
// the one path every launch of a session takes (a new launch, a restored
// session, a Restart, each copy of a Multi Spawn, Quick Start).
//
// THE RULE (src/shared/multi-spawn-rule.ts, the one the renderer's launch
// surfaces ask too): a saved config that is not Multi Spawn runs ONE copy at a
// time. A spawn that names such a config while another session of it is live is
// refused, before anything is installed, prepared, leased or spawned, with the
// typed refusal the terminal tab already knows how to say.
//
// WHAT MAIN KNOWS, and no more: whether a config is Multi Spawn is read from
// the saved configs on disk, never from the request (a request that says
// `allowMultiSpawn` is not asked); which sessions are copies of it is main's
// own record of the spawns it accepted (`claims`), and whether one is still
// held comes from pty-manager at the moment of asking, never from a count kept
// here. So nothing has to be told when a session ends: a claim whose session is
// gone is dropped the next time the rule looks, and a launch that fails after
// its claim (a refused account, a spawn that threw) leaves a claim nothing
// holds. There is no release to forget.
//
// ATOMIC: the question and the claim are one synchronous step, taken in the
// same tick as pty:spawn's provider check and before its first await. Every
// path with an await registers its spawn with pty-manager before that await (a
// launch preparation), and a path with none reaches the PTY in the same tick,
// so a second copy asked for in between always finds the first.
//
// NOT A SECURITY BOUNDARY, as the rule was not in the renderer: a spawn that
// names no config is not a copy of one, and a request made by something that
// can choose its own spawn options can leave the config out. What this closes
// is the renderer being the only place the rule lived: a launch surface that
// forgot to ask, a stale render, a restore or Restart the rule never saw.
//
// WHAT IS NOT A COPY OF A CONFIG:
//   - Ask Conductor and a spawn that names no saved config (nothing to count);
//   - the partner terminal, a plain shell started under `<session id>-partner`
//     with the config's id (the renderer's own count skips it: it is not a
//     session). Recognised by shape: shell-only AND that suffix;
//   - the same session id again: a Restart, a Switch of account, a respawn
//     replace their own process, they do not add one;
//   - an SSH reattach (`ssh.reconnect`): it re-adopts a session that already
//     exists on the remote rather than making a copy, which is why the
//     renderer's own backstop does not sit on that path either. It counts as a
//     copy from then on.
import { findSavedConfig } from './spawn-credential-binding'
import { isOneAtATimeBlocked, alreadyRunningRefusalMessage, isPartnerPtyId } from '../shared/multi-spawn-rule'
import { stripSpoofableText } from '../shared/safe-text'
import type { ProviderId, ProviderLaunchRefusal } from '../shared/providers'
import { logWarn } from './debug-logger'

/** What the rule reads of a spawn request. */
export interface ConfigLaunchRequest {
  configId?: string
  isAsk?: boolean
  shellOnly?: boolean
  provider?: ProviderId
  ssh?: { reconnect?: boolean }
}

export interface ConfigLaunchDeps {
  /** The saved configs as main reads them from disk. Called only when the
   *  request names a config the rule applies to. */
  savedConfigs: () => unknown
  /** Whether main holds this session: running, or accepted and starting. */
  isLive: (sessionId: string) => boolean
}

/** Session id -> the id of the saved config it was spawned from. Only a config
 *  main found on disk is recorded, so it is bounded by what is saved and by the
 *  sessions held: every look drops the sessions that are gone. */
const claims = new Map<string, string>()

/** The config's name as the refusal says it: the user's own text for it, made
 *  safe to show in a terminal. */
function labelOf(saved: object): string {
  const label = (saved as { label?: unknown }).label
  const text = typeof label === 'string' ? stripSpoofableText(label, 100).trim() : ''
  return text === '' ? 'This config' : text
}

/**
 * Ask the rule for a spawn about to start `sessionId`, and, when it passes,
 * record the session as a copy of its config. Returns the refusal to answer
 * with (nothing is recorded then), or null to go ahead.
 */
export function claimConfigLaunch(sessionId: string, request: ConfigLaunchRequest | undefined, deps: ConfigLaunchDeps): ProviderLaunchRefusal | null {
  const configId = request?.configId
  if (typeof configId !== 'string' || configId === '') return null
  if (request?.isAsk === true) return null
  if (request?.shellOnly === true && isPartnerPtyId(sessionId)) return null
  const saved = findSavedConfig(deps.savedConfigs(), configId)
  if (!saved) return null

  // The other copies of this config that main still holds. Anything it no
  // longer holds is dropped on the way.
  let others = 0
  for (const [id, claimed] of claims) {
    if (id === sessionId) continue
    if (!deps.isLive(id)) { claims.delete(id); continue }
    if (claimed === saved.id) others++
  }

  const reattach = request?.ssh?.reconnect === true
  if (!reattach && isOneAtATimeBlocked((saved as { allowMultiSpawn?: unknown }).allowMultiSpawn, others)) {
    logWarn(`[launch] session ${sessionId} refused: config ${saved.id} is not Multi Spawn and is already running`)
    return { code: 'already-running', providerId: request?.provider ?? 'claude', message: alreadyRunningRefusalMessage(labelOf(saved)) }
  }
  claims.set(sessionId, saved.id)
  return null
}

/** Test seam: how many sessions the rule is holding as copies of a config. */
export function _claimedSessionCountForTest(): number {
  return claims.size
}

/** Test seam: forget every claim. */
export function _resetConfigLaunchClaimsForTest(): void {
  claims.clear()
}
