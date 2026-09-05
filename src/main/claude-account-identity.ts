// src/main/claude-account-identity.ts
// Spawn-time Claude account capture, mirroring the Codex pattern in pty-manager.
// RELIABLE + drift-immune: read once at spawn from the session's profile (or the
// default ~/.claude.json for single-account sessions), never re-read. Fixes the
// v1.5.9 chip removal (whose source was the GLOBAL last-login at tick time).
import fs, { promises as fsp } from 'node:fs'; import path from 'node:path'
import { BrowserWindow } from 'electron'
import { readProfileAccountEmail, getProfileConfigDir, sharedRoot, listProfiles, isValidProfileId, backupProfileHomeToCanonical } from './account-profiles'
import { hasTransientProfileConsumer } from './profile-consumers'
import { IPC } from '../shared/ipc-channels'
import { colourForEmail } from './account-color'
import { canonicaliseEmail } from '../shared/account-chip-color'
import type { IdentityColorKey } from '../shared/identity-colors'
import { getLogSupervisor } from './logging/logging-service'

const bySession = new Map<string, string>()
// sessionId -> the profileId the session spawned under (undefined => default/single-account).
// Captured at spawn alongside the email, first-write-wins, so tokenomics can stamp a stable
// account key that survives a friendly-name/email change.
const profileBySession = new Map<string, string>()

export function getDefaultAccountEmail(): string | null {
  try {
    // The default account's identity lives in ~/.claude.json (home root), a
    // SIBLING of sharedRoot() (~/.claude) -- NOT a file inside it. Reading
    // sharedRoot()/.claude.json (the prior bug) always missed on real machines,
    // so the account chip stayed blank for every single-account user.
    // dirname(sharedRoot()) resolves to the home root in production and still
    // routes through the _setRootsForTest seam in tests.
    const raw = fs.readFileSync(path.join(path.dirname(sharedRoot()), '.claude.json'), 'utf8')
    const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } })?.oauthAccount?.emailAddress
    return typeof email === 'string' && email ? email : null
  } catch { return null }
}

/** Capture once at spawn. profileId undefined => single-account/default.
 *  Reads the account's shared PROFILE home (Bug 2: sessions of an account share it). */
export function captureClaudeAccount(sessionId: string, profileId: string | undefined): void {
  // Record the profileId first (before the email guard) so it is captured even on a
  // retry tick where the email read failed the first time. First-write-wins.
  if (profileId && !profileBySession.has(sessionId)) profileBySession.set(sessionId, profileId)
  if (bySession.has(sessionId)) return // drift-immune: first capture wins
  const email = profileId
    ? readProfileAccountEmail(profileId)
    : getDefaultAccountEmail()
  if (email) bySession.set(sessionId, email)
}
export function getClaudeAccount(sessionId: string): string | null { return bySession.get(sessionId) ?? null }
/** The profileId a session spawned under (undefined => default/single-account). */
export function getClaudeProfileId(sessionId: string): string | undefined { return profileBySession.get(sessionId) }
export function getClaudeAccountMap(): ReadonlyMap<string, string> { return bySession }
export function clearClaudeAccount(sessionId: string): void { bySession.delete(sessionId); profileBySession.delete(sessionId) }

export function getAccountIdentity(sessionId: string): { email: string; colourKey: IdentityColorKey } | null {
  const email = bySession.get(sessionId)
  return email ? { email, colourKey: colourForEmail(email) } : null
}

/** Push the captured identity to all renderer windows (one-shot, at spawn). */
export function pushAccountIdentity(sessionId: string): void {
  const id = getAccountIdentity(sessionId)
  if (!id) return
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(IPC.ACCOUNT_IDENTITY_UPDATE, { sessionId, email: id.email, colourKey: id.colourKey }) } catch { /* window destroyed */ }
  }
  // T11: backfill the account email on the session's latest open run so the logs
  // can be filtered and labelled by account. Identity may be null at spawn (the
  // account file isn't always written before PTY starts), so this wires the resolved
  // email into the log row the first time it becomes known — and again on any
  // subsequent /login change (recheckAll calls pushAccountIdentity on a change).
  if (id.email) getLogSupervisor()?.runAccount(sessionId, id.email)
}

// ---- mid-session account watch ---------------------------------------------
// The spawn-time capture above is "first capture wins" and never re-reads. But a
// user can change a session's account WITHOUT a respawn by running `/login` in
// the terminal -- that rewrites the session's own .claude.json (the profile dir
// for a profile session, or ~/.claude.json for the default account). We poll
// each live session's identity file and, on a real change, update the map and
// re-push so the status strip, the session-card account line, and the statusline
// chip all follow. mtime-guarded so the JSON is only parsed when the file
// actually changes (the default account's ~/.claude.json can be multi-MB).

const watched = new Map<string, string | undefined>() // sessionId -> profileId
const lastMtimeMs = new Map<string, number>()         // sessionId -> last seen identity-file mtime
// profileId -> last seen `.credentials.json` mtime of that PROFILE home (rc.14
// review F6). A change with the email unchanged is a token ROTATION, and the
// canonical backup must follow it: it used to be refreshed only at exit, so a
// capture/restore mid-session could put a pre-rotation (spent) refresh token
// back and strand the account. Keyed by PROFILE, not session: several sessions
// on one account share one credential file, and one rotation must cost one
// backup, not one per session. Only ever observed by stat; never read here.
// profileId -> the last credential/identity stamp seen, and whether it changed
// on the previous poll (armed = "back up once it stops moving").
const rotationStampByProfile = new Map<string, { last: string; armed: boolean }>()
// profileId -> the email we last broadcast a "new account detected" prompt for.
// Sessions sharing a profile home all observe the same /login, so this dedups the
// prompt to one per (profile, email) instead of one per session.
const detectedByProfile = new Map<string, string>()
let pollTimer: ReturnType<typeof setInterval> | null = null
// One shared timer ticks every POLL_MS and stats each watched session's identity
// file (mtime-guarded, so the possibly-multi-MB JSON is only parsed on an actual
// /login change). A mid-session account switch is rare and not latency-critical,
// so 5s keeps the per-tick stat fan-out (N sessions x 1 stat) off the hot path
// without a perceptible delay -- 3s woke the main thread ~40% more often for no
// real benefit at scale.
const POLL_MS = 5000

/** Resolve the .claude.json that holds a session's account identity. For a profile
 *  session this is the account's shared profile home (Bug 2); for the default
 *  account it is ~/.claude.json. */
function identityFilePath(profileId: string | undefined): string {
  // Validate before the join. This runs on a 5s poll timer, so letting
  // getProfileConfigDir's throw escape here would take down the main process on
  // a bad id; an invalid one resolves the shared identity file instead.
  return isValidProfileId(profileId)
    ? path.join(getProfileConfigDir(profileId), '.claude.json')
    : path.join(path.dirname(sharedRoot()), '.claude.json')
}

/**
 * Re-read a session's identity file; if the account email changed since the last
 * captured value, update the map and return the NEW email (else null). Exported
 * for the poll loop and for tests. mtime-guarded: returns null fast when the file
 * has not changed, so the (possibly large) JSON is only parsed on a real change.
 */
export function recheckSessionIdentity(sessionId: string, profileId: string | undefined): string | null {
  const file = identityFilePath(profileId)
  let mtime: number
  try { mtime = fs.statSync(file).mtimeMs } catch { return null }
  if (lastMtimeMs.get(sessionId) === mtime) return null
  lastMtimeMs.set(sessionId, mtime)
  let email: string | null = null
  try { email = profileId ? readProfileAccountEmail(profileId) : getDefaultAccountEmail() } catch { return null }
  if (!email || bySession.get(sessionId) === email) return null
  bySession.set(sessionId, email) // mid-session change: bypass the first-capture guard
  return email
}

/** Notify renderers that a session's /login authenticated an account not yet
 *  known as a profile, so the UI can offer to add + name it. */
function broadcastNewAccountDetected(sessionId: string, profileId: string, email: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(IPC.ACCOUNT_NEW_DETECTED, { sessionId, profileId, email }) } catch { /* window destroyed */ }
  }
}

export function recheckAll(): void {
  for (const [sessionId, profileId] of watched) {
    const before = bySession.get(sessionId) ?? null
    let changed: string | null = null
    try { changed = recheckSessionIdentity(sessionId, profileId) } catch { /* best-effort */ }
    if (!changed) continue
    pushAccountIdentity(sessionId)
    if (!profileId) continue // bare-global/default session: no profile context to detect against
    // Detection: a /login to an email that is not yet a known account.
    const known = listProfiles().map((p) => p.accountEmail).filter((e): e is string => !!e)
    if (classifyIdentityChange(sessionId, changed, before, known).kind === 'capture') {
      // Sessions sharing one profile home all observe the same /login; broadcast the
      // "new account" prompt ONCE per (profile, email) so we never double-prompt or
      // double-capture.
      if (detectedByProfile.get(profileId) === changed) continue
      detectedByProfile.set(profileId, changed)
      broadcastNewAccountDetected(sessionId, profileId, changed)
    } else {
      // Home is back on a known account -> let a future switch re-broadcast.
      detectedByProfile.delete(profileId)
    }
  }
}

/** The profileId a live session is watching -- used by the capture-detected IPC
 *  handler to read the right shared profile home. */
export function getWatchedProfileId(sessionId: string): string | undefined {
  return watched.get(sessionId)
}

/** True when `profileId` is in use by a live session OR a transient credential
 *  consumer -- i.e. that profile's home is the active USERPROFILE/credential
 *  store of something running now. Used to refuse a profile delete that would
 *  half-destroy a live account's creds (R-006) and to gate the usage page's auto
 *  token refresh (a rotation under a live consumer strands its token).
 *  Checks the active-watcher map (added at spawn, removed at exit), the
 *  spawn-captured map (cleared on exit), AND the transient-consumer registry
 *  (the `claude auth status` probe, #258 -- which spawns the CLI under a profile
 *  home and can rotate the token itself; it registers for its short duration).
 *  KNOWN GAP: SSH sessions never enter any of these (they spawn ssh.exe without
 *  account capture). Safe today because SSH sessions don't use account-home
 *  isolation -- nothing of theirs lives in the profile dir -- but if SSH ever
 *  gains profile binding this check must learn about it. */
export function isProfileInUseByLiveSession(profileId: string): boolean {
  if (!profileId) return false
  for (const pid of watched.values()) if (pid === profileId) return true
  for (const pid of profileBySession.values()) if (pid === profileId) return true
  if (hasTransientProfileConsumer(profileId)) return true
  return false
}

/**
 * Async variant of recheckSessionIdentity. Uses fsp.stat (async) for the
 * per-tick mtime check so the Electron main event loop is not blocked.
 * The expensive JSON parse only runs on a real mtime change (rare) and may
 * remain synchronous -- it is not on the hot path.
 */
export async function recheckSessionIdentityAsync(
  sessionId: string,
  profileId: string | undefined,
): Promise<string | null> {
  const file = identityFilePath(profileId)
  let mtime: number
  try { mtime = (await fsp.stat(file)).mtimeMs } catch { return null }
  if (lastMtimeMs.get(sessionId) === mtime) return null
  lastMtimeMs.set(sessionId, mtime)
  let email: string | null = null
  try { email = profileId ? readProfileAccountEmail(profileId) : getDefaultAccountEmail() } catch { return null }
  if (!email || bySession.get(sessionId) === email) return null
  bySession.set(sessionId, email) // mid-session change: bypass the first-capture guard
  return email
}

// In-flight guard: a slow disk can make a 5s poll tick outlast the interval, so
// the next tick must not start a second concurrent fan-out (overlapping stat
// storms + duplicate broadcasts). Set on entry, cleared in `finally`.
let recheckInFlight = false

/** Async poll loop: iterates all watched sessions with async mtime checks off
 *  the synchronous hot path. Mirrors recheckAll logic but uses fsp.stat. */
export async function recheckAllAsync(): Promise<void> {
  if (recheckInFlight) return
  recheckInFlight = true
  try {
    await recheckAllAsyncInner()
  } finally {
    recheckInFlight = false
  }
}

async function recheckAllAsyncInner(): Promise<void> {
  for (const [sessionId, profileId] of [...watched]) {
    // Guard the WHOLE per-session body (not just the stat) so a throw in
    // pushAccountIdentity/listProfiles/classify/broadcast can never abort the poll
    // or reject this promise (it's void'd in a setInterval -> would be an unhandled
    // rejection). One bad session is skipped; the rest still poll.
    try {
      if (profileId) await followCredentialRotation(profileId)
      const before = bySession.get(sessionId) ?? null
      const changed = await recheckSessionIdentityAsync(sessionId, profileId)
      if (!changed) continue
      pushAccountIdentity(sessionId)
      if (!profileId) continue // bare-global/default session: no profile context to detect against
      const known = listProfiles().map((p) => p.accountEmail).filter((e): e is string => !!e)
      if (classifyIdentityChange(sessionId, changed, before, known).kind === 'capture') {
        if (detectedByProfile.get(profileId) === changed) continue
        detectedByProfile.set(profileId, changed)
        broadcastNewAccountDetected(sessionId, profileId, changed)
      } else {
        detectedByProfile.delete(profileId)
      }
    } catch { /* best-effort per-session; never abort the poll or reject */ }
  }
}

/**
 * The stat stamp the rotation follower compares between polls: the credential
 * file's mtime and the identity file's (`.claude.json`, the email the backup
 * guard reads). Stat-only -- neither file's CONTENTS are read here. null when
 * there is no credential file to follow.
 */
async function credentialRotationStamp(profileId: string): Promise<string | null> {
  const home = getProfileConfigDir(profileId)
  let creds: number
  try { creds = (await fsp.stat(path.join(home, '.claude', '.credentials.json'))).mtimeMs } catch { return null }
  let identity = 'none'
  try { identity = String((await fsp.stat(path.join(home, '.claude.json'))).mtimeMs) } catch { /* no identity file yet */ }
  return `${creds}:${identity}`
}

/**
 * Keep the canonical backup current through a mid-session token rotation
 * (rc.14 review F6, aicc_planning#50). Stat-only: the first observation just
 * records the stamp; a later change re-snapshots the profile home into
 * canonical. `backupProfileHomeToCanonical` is itself EMAIL-GUARDED, so a
 * /login that switched the home to a different account is refused there --
 * this only ever lands rotations of the profile's own account.
 *
 * SETTLED, not merely changed (adversarial pass on #598): a change is backed up
 * only once the same stamp has been seen on two consecutive polls. The CLI's
 * /login rewrites `.credentials.json` and `.claude.json` as two separate
 * writes, and a poll landing between them saw the profile's own email beside
 * another account's token -- the one state the email guard cannot see through,
 * and a snapshot of it would have restored a mixed identity later. Waiting one
 * poll for both files to stop moving hands the guard the finished picture. A
 * rotation (one file, one write) costs the same single backup, one poll later.
 */
async function followCredentialRotation(profileId: string): Promise<void> {
  const stamp = await credentialRotationStamp(profileId)
  if (stamp === null) return
  const seen = rotationStampByProfile.get(profileId)
  if (!seen) { rotationStampByProfile.set(profileId, { last: stamp, armed: false }); return }
  if (stamp !== seen.last) { seen.last = stamp; seen.armed = true; return } // still moving: look again next poll
  if (!seen.armed) return
  seen.armed = false
  try { backupProfileHomeToCanonical(profileId) } catch { /* best-effort, like the exit-time backup */ }
}

/** Start polling a live session's identity file for mid-session account changes. */
export function startWatchingAccountIdentity(sessionId: string, profileId: string | undefined): void {
  watched.set(sessionId, profileId)
  if (!pollTimer) {
    pollTimer = setInterval(() => { void recheckAllAsync() }, POLL_MS)
    // Never keep the process alive just for this poll.
    if (typeof (pollTimer as { unref?: () => void }).unref === 'function') (pollTimer as { unref: () => void }).unref()
  }
}

/** Stop polling a session (called alongside clearClaudeAccount on PTY exit). */
export function stopWatchingAccountIdentity(sessionId: string): void {
  const profileId = watched.get(sessionId)
  watched.delete(sessionId)
  lastMtimeMs.delete(sessionId)
  // The rotation stamp is per profile: drop it only when no watched session is
  // left on that profile, so the next session starts with a fresh observation.
  if (profileId && ![...watched.values()].includes(profileId)) rotationStampByProfile.delete(profileId)
  if (watched.size === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

// ---- pure classifier (no side effects, fully unit-testable) ----------------

export type IdentityChange = { kind: 'refresh' | 'adopt' | 'capture' }

/** Classify what a session's identity-file change means. Pure + unit-testable.
 *  refresh = same account (token refresh); adopt = switched to an existing
 *  account; capture = switched to an email not yet known as a profile. */
export function classifyIdentityChange(
  _sessionId: string,
  newEmail: string,
  currentEmail: string | null,
  knownEmails: string[],
): IdentityChange {
  const ne = canonicaliseEmail(newEmail)
  if (currentEmail && canonicaliseEmail(currentEmail) === ne) return { kind: 'refresh' }
  if (knownEmails.some((e) => canonicaliseEmail(e) === ne)) return { kind: 'adopt' }
  return { kind: 'capture' }
}

/** Test seam. */
export function _resetClaudeAccounts(): void {
  bySession.clear()
  profileBySession.clear()
  watched.clear()
  lastMtimeMs.clear()
  rotationStampByProfile.clear()
  detectedByProfile.clear()
  recheckInFlight = false
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

/** Alias for the async-poll test suite (same semantics, shorter name). */
export const _resetForTest = _resetClaudeAccounts

/** Test seam: exposes the in-flight guard state so a test can assert overlapping
 *  poll ticks do not run concurrently. */
export function __isRecheckInFlightForTest(): boolean { return recheckInFlight }
