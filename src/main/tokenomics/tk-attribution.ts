// Usage track MP10 (owner decision Q1.4): Claude usage is attributed to the
// account whose profile it runs under, from now on. A local Claude session
// reports its live transcript path (the hook POSTs and the statusline, the
// same paths the transcript binder hears, whether logging is on or off). The
// path decides, as a Codex realm's folder does (MP10 round 1): a transcript
// under a profile's own projects folder belongs to that profile (its layout,
// `<profiles root>/<profile id>/.claude/projects/`, comes from the one place
// profile homes are built, never restated here), and
// the profile names the account through its registry link; the file name is
// the session id. When the same session id later shows under another
// profile (a session resumed under another account), the new account applies
// from then on; what was already attributed keeps its account.
//
// Nothing is attributed by hand. Only a local session's report counts (one
// with a launch profile recorded at its latest spawn), and only for a
// transcript in that profile's own projects folder: a session attributes
// usage to the account it runs under now, never to another. An SSH session's
// transcript is on the remote host and never in the index here. A transcript
// outside the profiles root (the default home) has no account to name. Older
// sessions and sessions run outside the app stay "not recorded" until one is
// resumed in the app under a profile; then its rows with no account take that
// profile's account too (tk-db setSessionAccount).

import * as path from 'node:path'
import type { TkAccountKey } from './tk-types'
import { tkAccountKey, TK_ACCOUNT_NOT_RECORDED } from './tk-types'
import { lowerAsciiLetters } from '../../shared/profile-id'

/** The file name a Claude transcript has, exactly: `<session uuid>.jsonl`. */
const TRANSCRIPT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/
/** Longest transcript path looked at. */
const MAX_PATH = 4096
/** Session ids remembered with their last account, the oldest forgotten
 *  first (one forgotten and sent again with the same account changes
 *  nothing in the index). */
export const TK_ATTRIBUTION_REMEMBERED = 4096

export interface TkAttributionDeps {
  /** The profile the reporting app session runs under now (recorded at its
   *  latest spawn, so a session restarted on another profile names that
   *  one), or undefined: an SSH session, or one on the default home. Asked on
   *  every report. */
  launchProfile(appSessionId: string): string | undefined
  /** The folder the app's Claude profile homes live in (`<root>/<profile
   *  id>`). Null when not known. */
  profilesRoot(): string | null
  /** Whether a folder name is a profile id the app could have made. */
  isProfileId(name: string): boolean
  /** The projects folder a profile's Claude writes its transcripts to, as
   *  the profile home is built (the single source of the layout). */
  projectsDirOf(profileId: string): string
  /** The profiles root with every link resolved, or null: a transcript
   *  reported through the root's real path still matches. Only the root is
   *  resolved (a profile's projects folder is itself a link to the shared
   *  one, so resolving the whole path would leave the root). */
  realRoot?(root: string): string | null
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

/** `child` inside `parent`: the path from one to the other, else null. */
function inside(p: typeof path.win32, parent: string, child: string): string | null {
  const rel = p.relative(parent, child)
  if (!rel || rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) return null
  return rel
}

/** The profile whose projects folder holds a transcript, or undefined: the
 *  path must be inside `projectsDirOf(<id>)` (a project folder, then the
 *  file), for a folder name under the profiles root that is a profile id.
 *  The layout below the root is taken from `projectsDirOf`, and matched
 *  from the root as configured and, when given, its real path. Compared as
 *  the platform compares paths (without case on Windows). */
export function transcriptProfile(
  transcriptPath: string,
  profilesRoot: string,
  isProfileId: (name: string) => boolean,
  projectsDirOf: (profileId: string) => string,
  platform: NodeJS.Platform = process.platform,
  realRoot?: string | null,
): string | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (!p.isAbsolute(transcriptPath) || !p.isAbsolute(profilesRoot)) return undefined
  const file = p.resolve(transcriptPath)
  const root = p.resolve(profilesRoot)
  const roots = realRoot && p.isAbsolute(realRoot) && p.resolve(realRoot) !== root ? [root, p.resolve(realRoot)] : [root]
  for (const base of roots) {
    const rel = inside(p, base, file)
    if (!rel) continue
    // Windows compares paths without case, and a profile id is lower case:
    // the folder name is lowered before it is checked, or a path reported
    // in other case would never reach the case-free account lookup. Only
    // ASCII letters are lowered: a profile id is ASCII.
    const segment = rel.split(p.sep)[0]
    const id = platform === 'win32' ? lowerAsciiLetters(segment) : segment
    if (!isProfileId(id)) continue
    // Where this profile's transcripts go, relative to the root.
    const layout = inside(p, root, p.resolve(projectsDirOf(id)))
    if (!layout) continue
    const within = inside(p, p.join(base, layout), file)
    if (within && within.split(p.sep).length >= 2) return id
  }
  return undefined
}

/** Where main keeps the Claude profiles' transcripts: the part of the
 *  attribution's dependencies that locates them. */
export type TkProfileFolders = Pick<TkAttributionDeps, 'profilesRoot' | 'isProfileId' | 'projectsDirOf' | 'realRoot' | 'platform'>

/** The profile whose folder holds a transcript, or undefined: the rule of
 *  transcriptProfile, on main's folders. Never throws. Shared by the
 *  Tokenomics attribution and the live usage recorder (account-usage.ts). */
export function profileOfTranscript(folders: TkProfileFolders, transcriptPath: string): string | undefined {
  try {
    const root = folders.profilesRoot()
    if (typeof root !== 'string' || root.length === 0) return undefined
    return transcriptProfile(transcriptPath, root, (n) => folders.isProfileId(n) === true, (id) => folders.projectsDirOf(id), folders.platform ?? process.platform, folders.realRoot?.(root) ?? null)
  } catch {
    return undefined
  }
}

/** Two profile ids the same, as the platform compares folder names (ASCII
 *  letters without case on Windows, exactly elsewhere). */
function sameProfile(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? lowerAsciiLetters(a) === lowerAsciiLetters(b) : a === b
}

/** The sink composed beside the transcript binder's: called with an app
 *  session id and the transcript path it reported. A report counts only when
 *  the transcript lies in the folder of the profile that app session runs
 *  under now. Never throws. */
export function createTranscriptAttribution(deps: TkAttributionDeps): (appSessionId: string, transcriptPath: string) => void {
  const cap = Math.max(1, Math.floor(deps.remember ?? TK_ATTRIBUTION_REMEMBERED))
  // Insertion ordered by the last change: the first entry is the oldest.
  const sent = new Map<string, TkAccountKey>()
  return (appSessionId, transcriptPath) => {
    try {
      const sessionId = transcriptSessionId(transcriptPath)
      if (!sessionId) return
      if (typeof appSessionId !== 'string' || appSessionId.length === 0) return
      const launched = deps.launchProfile(appSessionId)
      if (typeof launched !== 'string' || launched.length === 0) return
      const profileId = profileOfTranscript(deps, transcriptPath)
      if (!profileId || !sameProfile(profileId, launched, deps.platform ?? process.platform)) return
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
