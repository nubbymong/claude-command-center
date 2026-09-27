// Usage track MP10 (owner decision Q1.4): Claude usage is attributed to the
// account whose profile it runs under, from now on. A local Claude session
// reports its live transcript path (the hook POSTs and the statusline, the
// same paths the transcript binder hears, whether logging is on or off). The
// path decides, as a Codex realm's folder does (MP10 round 1): a transcript
// under `<profiles root>/<profile id>/projects/` belongs to that profile, and
// the profile names the account through its registry link; the file name is
// the session id. When the same session id later shows under another
// profile (a session resumed under another account), the new account applies
// from then on; what was already attributed keeps its account.
//
// Nothing is attributed by hand. Only a local session's report counts (one
// with a launch profile recorded at spawn): an SSH session's transcript is on
// the remote host and never in the index here. A transcript outside the
// profiles root (the default home) has no account to name. Older sessions
// and sessions run outside the app stay "not recorded".

import * as path from 'node:path'
import type { TkAccountKey } from './tk-types'
import { tkAccountKey, TK_ACCOUNT_NOT_RECORDED } from './tk-types'

/** The file name a Claude transcript has, exactly: `<session uuid>.jsonl`. */
const TRANSCRIPT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/
/** Longest transcript path looked at. */
const MAX_PATH = 4096
/** Session ids remembered with their last account, the oldest forgotten
 *  first (one forgotten and sent again with the same account changes
 *  nothing in the index). */
export const TK_ATTRIBUTION_REMEMBERED = 4096

export interface TkAttributionDeps {
  /** Whether the reporting app session is local (it has a launch profile
   *  recorded at spawn); an SSH session is not. */
  isLocal(appSessionId: string): boolean
  /** The folder the app's Claude profile homes live in: each profile's
   *  config folder is `<root>/<profile id>`. Null when not known. */
  profilesRoot(): string | null
  /** Whether a folder name is a profile id the app could have made. */
  isProfileId(name: string): boolean
  /** The account that profile is linked to in the registry, or null. */
  accountOf(profileId: string): string | null
  /** Hand the attribution to the usage index; false when it is not running
   *  (the session id is then tried again on its next report). */
  record(sessionId: string, accountKey: TkAccountKey): boolean
  /** Test seam: the path rules (default: this platform's). */
  platform?: NodeJS.Platform
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

/** The profile whose config folder holds a transcript, or undefined: the
 *  path must be `<profiles root>/<profile id>/projects/<...>/<file>`, with a
 *  folder name that is a profile id. Compared as the platform compares paths
 *  (without case on Windows). */
export function transcriptProfile(
  transcriptPath: string,
  profilesRoot: string,
  isProfileId: (name: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (!p.isAbsolute(transcriptPath) || !p.isAbsolute(profilesRoot)) return undefined
  const rel = p.relative(p.resolve(profilesRoot), p.resolve(transcriptPath))
  if (!rel || rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) return undefined
  const parts = rel.split(p.sep)
  const projects = platform === 'win32' ? parts[1]?.toLowerCase() : parts[1]
  if (parts.length < 4 || projects !== 'projects') return undefined
  return isProfileId(parts[0]) ? parts[0] : undefined
}

/** The sink composed beside the transcript binder's: called with an app
 *  session id and the transcript path it reported. Never throws. */
export function createTranscriptAttribution(deps: TkAttributionDeps): (appSessionId: string, transcriptPath: string) => void {
  const cap = Math.max(1, Math.floor(deps.remember ?? TK_ATTRIBUTION_REMEMBERED))
  // Insertion ordered by the last change: the first entry is the oldest.
  const sent = new Map<string, TkAccountKey>()
  return (appSessionId, transcriptPath) => {
    try {
      const sessionId = transcriptSessionId(transcriptPath)
      if (!sessionId) return
      if (typeof appSessionId !== 'string' || appSessionId.length === 0 || deps.isLocal(appSessionId) !== true) return
      const root = deps.profilesRoot()
      if (typeof root !== 'string' || root.length === 0) return
      const profileId = transcriptProfile(transcriptPath, root, (n) => deps.isProfileId(n) === true, deps.platform ?? process.platform)
      if (!profileId) return
      const accountKey = tkAccountKey('claude', deps.accountOf(profileId))
      if (accountKey === TK_ACCOUNT_NOT_RECORDED || sent.get(sessionId) === accountKey) return
      if (deps.record(sessionId, accountKey) !== true) return
      sent.delete(sessionId)
      sent.set(sessionId, accountKey)
      if (sent.size > cap) {
        const oldest = sent.keys().next()
        if (!oldest.done) sent.delete(oldest.value)
      }
    } catch {
      // Attribution never breaks the transcript fan-out.
    }
  }
}
