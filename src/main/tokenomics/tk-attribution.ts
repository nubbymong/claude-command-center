// Usage track MP10 (owner decision Q1.4): Claude usage is attributed to the
// account its session launched under, from now on. A local Claude session
// reports its live transcript path (the hook POSTs and the statusline, the
// same paths the transcript binder hears, whether logging is on or off); the
// file name is the transcript's session id. The app session's launch profile,
// recorded at spawn, names the account through its registry link, and the
// usage index records the pair once (the first attribution of a session id
// wins) and re-attributes what it already holds of that session.
//
// Nothing is attributed by hand. A session with no launch profile is never
// attributed: an SSH session's transcript is on the remote host and never in
// the index here, and a default-home session has no account to name. Older
// sessions and sessions run outside the app stay "not recorded".

import type { TkAccountKey } from './tk-types'
import { tkAccountKey, TK_ACCOUNT_NOT_RECORDED } from './tk-types'

/** The file name a Claude transcript has, exactly: `<session uuid>.jsonl`. */
const TRANSCRIPT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/
/** Longest transcript path looked at. */
const MAX_PATH = 4096
/** Session ids remembered as attributed, the oldest forgotten first (a
 *  forgotten one sent again is ignored by the index: the first wins). */
export const TK_ATTRIBUTION_REMEMBERED = 4096

export interface TkAttributionDeps {
  /** The launch profile the app session spawned under; undefined when it has
   *  none (an SSH or default-home session). */
  profileOf(appSessionId: string): string | undefined
  /** The account that profile is linked to in the registry, or null. */
  accountOf(profileId: string): string | null
  /** Hand the attribution to the usage index; false when it is not running
   *  (the session id is then tried again on its next report). */
  record(sessionId: string, accountKey: TkAccountKey): boolean
  /** Test seam: how many attributed session ids to remember. */
  remember?: number
}

/** The session id a transcript path names, or null: its last segment must be
 *  exactly `<lower-case uuid>.jsonl` (a subagent's transcript, a rollout or
 *  anything else is not a session transcript). */
export function transcriptSessionId(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0 || transcriptPath.length > MAX_PATH) return null
  const name = transcriptPath.split(/[\\/]/).pop() ?? ''
  const m = TRANSCRIPT_NAME.exec(name)
  return m ? m[1] : null
}

/** The sink composed beside the transcript binder's: called with an app
 *  session id and the transcript path it reported. Never throws. */
export function createTranscriptAttribution(deps: TkAttributionDeps): (appSessionId: string, transcriptPath: string) => void {
  const cap = Math.max(1, Math.floor(deps.remember ?? TK_ATTRIBUTION_REMEMBERED))
  // Insertion ordered: the first value is the oldest.
  const sent = new Set<string>()
  return (appSessionId, transcriptPath) => {
    try {
      const sessionId = transcriptSessionId(transcriptPath)
      if (!sessionId || sent.has(sessionId)) return
      if (typeof appSessionId !== 'string' || appSessionId.length === 0) return
      const profileId = deps.profileOf(appSessionId)
      if (typeof profileId !== 'string' || profileId.length === 0) return
      const accountKey = tkAccountKey('claude', deps.accountOf(profileId))
      if (accountKey === TK_ACCOUNT_NOT_RECORDED) return
      if (deps.record(sessionId, accountKey) !== true) return
      sent.add(sessionId)
      if (sent.size > cap) {
        const oldest = sent.values().next()
        if (!oldest.done) sent.delete(oldest.value)
      }
    } catch {
      // Attribution never breaks the transcript fan-out.
    }
  }
}
