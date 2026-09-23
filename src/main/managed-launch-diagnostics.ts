// Layers 3 and 4 of the managed launch: the project-settings GATE and the
// visible preflight record.
//
// READ THIS BEFORE TRUSTING ANYTHING HERE. The gate refuses a launch whose
// working directory carries a DETECTABLE override in its own settings files
// (`.claude/settings.json`, `.claude/settings.local.json`): a credential
// helper, an account pin, a provider switch or an endpoint redirect, as the
// authority manifest defines them. The preflight is the RECORD of what a
// launch did -- the refusal included -- not a proof that a session is isolated.
// What neither can see is a recorded boundary:
//
//   - settings changed AFTER the process started;
//   - remote / organisation-managed settings, which the CLI fetches from the
//     server for a signed-in account;
//   - another process of the same OS user acting on the realm;
//   - a directory the gate cannot read safely (a network path) or in time,
//     which launches UNCHECKED with a warning rather than a refusal;
//   - anything a future CLI version reads that this version does not.
//
// There is no host-side control any more: the flag that suppressed these at
// run time also stopped the profile's own login (owner decision, 2026-09-22;
// evidence Parts 7 and 8). Refusing before launch is what this app can do
// honestly; the rest it says.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logInfo, logWarn } from './debug-logger'
import { managedLaunchPreflightFor, authoritySettingsKeysFor } from './providers'
import { peekClaudeCliVersion, ensureClaudeCliVersion } from './claude-cli-version'
import { decodeSettingsText } from './settings-text'
// From the shared state module, NOT from account-profiles: the choke point in
// account-profiles calls this recorder, so importing back would make the launch
// path and its own diagnostics a cycle (see ./managed-launch-state.ts).
import { lastSettingsSanitiseFor, lastAmbientStripFor } from './managed-launch-state'
import { boundNames } from '../shared/providers'
import { stripSpoofableText } from '../shared/safe-text'
import type { ManagedLaunchPreflight, ManagedLaunchPreflightInput, ProjectGateResult, ProjectScanSkipReason } from '../shared/providers'

/** A launch the USER started, or a PROBE this app ran by itself.
 *
 *  They are not interchangeable on the panel. `readClaudeCliAuth` runs a real
 *  managed launch -- it gets the full hardening, and its report is worth having
 *  in the log -- but it fires on every Accounts row mount, every auth-method
 *  toggle and every session right-click. Treating it as the newest launch meant
 *  OPENING the Accounts panel replaced the report the panel was about to show
 *  with the probe's, displacing exactly the project-settings finding this round
 *  added (adversarial review, MAJOR). */
export type { ManagedLaunchKind } from '../shared/providers'
import type { ManagedLaunchKind } from '../shared/providers'

/** The internal record. `home` is an ABSOLUTE path and therefore carries the OS
 *  username, so it stays in the main process and never reaches the wire.
 *  `input` is kept with the record, for the tests and the log. */
interface StoredReport {
  home: string
  profileId: string
  sessionId: string
  kind: ManagedLaunchKind
  at: number
  /** Monotonic record order. `at` has millisecond resolution, so two launches
   *  in the same tick cannot be ordered by it -- and "newest first" is what the
   *  panel answers with. */
  seq: number
  preflight: ManagedLaunchPreflight
  input: ManagedLaunchPreflightInput
}

/** What a renderer receives: scoped to ONE profile, with no absolute path. */
export interface ManagedLaunchReport {
  profileId: string
  sessionId: string
  kind: ManagedLaunchKind
  at: number
  preflight: ManagedLaunchPreflight
}

/** Bounded so a long-running app cannot accumulate one entry per session for
 *  the life of the process. The newest are the ones anybody looks at.
 *
 *  TWO rings, and that is the point. One shared ring meant probes evicted
 *  launches: this app runs an auth-status probe on every Accounts row mount, so
 *  sixteen panel opens on a three-account install pushed every real launch out
 *  and the panel fell back to showing a probe with no findings -- the exact
 *  report this round exists to surface, invisible again (adversarial re-attack,
 *  MAJOR). Probes are worth keeping and worth logging; they are not worth a
 *  launch's slot. */
const MAX_REPORTS = 50
const MAX_PROBE_REPORTS = 20
const reports: StoredReport[] = []
const probeReports: StoredReport[] = []
let nextSeq = 0
const ringFor = (kind: ManagedLaunchKind): StoredReport[] => (kind === 'probe' ? probeReports : reports)

/** Project- and local-scope settings files, in the order the CLI reads them.
 *  The app never writes or modifies either: they belong to the repository. */
const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

/** The largest settings file the gate reads, and it is the CLI's OWN cap:
 *  Claude Code 2.1.278 reads a settings file through a `maxBytes` of
 *  2,097,152 and reports one over it as unreadable, applying nothing. The two
 *  must match exactly: a gate cap below the CLI's was a window (128 KiB to
 *  2 MiB) in which a repository's settings file was too big for the gate and
 *  small enough for the CLI (adversarial review, MAJOR). A file over the cap
 *  is `not-scanned` with reason `over-cap`, never clean (exact-head review):
 *  the pinned CLI skips it too, but that is a fact about one CLI version, and
 *  the gate did not read the file. The fixed-buffer read stays, so the cost is
 *  bounded by the cap, not by what the file is at the moment of reading. */
const MAX_PROJECT_SETTINGS_BYTES = 2 * 1024 * 1024

// At most MAX_REPORTED_NAMES key names reach the panel; the rest become a
// count (`boundNames`, shared with the settings-copy finding so the two bounds
// cannot drift). Not cosmetic: settings keys are JSON properties and the `env`
// match is case-insensitive, so ONE authority name can appear under hundreds
// of spellings in a file that is still inside the size cap -- which turned the
// finding text into a megabyte of string, crossing IPC and rendering into a
// single list item (adversarial review, MINOR).

/** A path as it may be written to the app log: control and spoofing
 *  characters out (see ../shared/safe-text.ts). The log sink escapes only CR
 *  and LF, and a working directory is user-chosen text. */
const describePath = (p: string): string => stripSpoofableText(p, 300)

/** A path as it may reach the TERMINAL or the ACCOUNTS PANEL: the same strip,
 *  and the user's home directory shortened to `~` -- an absolute path under
 *  the home carries the OS username, which this module keeps off the wire
 *  everywhere else (spec review, MINOR). The rest of the path stays, because
 *  "which directory" is the whole point of naming it. */
export function displayPath(p: string): string {
  let home = ''
  try { home = os.homedir() } catch { /* no home to shorten */ }
  // Case-insensitively on Windows: a configured directory arrives in whatever
  // case the user typed it, and a miss here is the username on the wire
  // (code-quality review, MINOR).
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const under = home !== '' && (fold(p) === fold(home) || fold(p).startsWith(fold(home) + path.sep))
  const shortened = under ? '~' + p.slice(home.length) : p
  return stripSpoofableText(shortened, 300)
}

/** What one `.claude/settings*.json` turned out to be. Only `absent` and
 *  `keys` are certain; `uncertain` carries why (see ProjectScanSkipReason). */
type SettingsFileScan =
  | { readonly kind: 'absent' }
  | { readonly kind: 'keys'; readonly keys: readonly string[] }
  | { readonly kind: 'uncertain'; readonly reason: 'unreadable' | 'over-cap' | 'classifier-unavailable' }

/** The authority `keys` of `file` (a `.claude/settings*.json`), read under the
 *  size cap and the regular-file rule, to end of file.
 *
 *  THREE OUTCOMES, AND ONLY TWO OF THEM ARE CLEAN. The first version returned
 *  `null` for everything that was not a list of keys -- absent, unreadable,
 *  over the cap, not a regular file, no classifier -- and the caller read
 *  `null` as "nothing to report", so each of those produced a CLEAN verdict
 *  that was cached and launched with no warning (exact-head review, BLOCKER).
 *  Now:
 *   - `absent`: the file (or its `.claude` directory) does not exist -- the
 *     CLI reads nothing there either;
 *   - `keys`: the file was read IN FULL and classified; an empty list is a
 *     clean file. A file read in full that the CLI's strict parser rejects is
 *     classified as carrying nothing, which is what the CLI applies from it
 *     (measured, evidence Part 9) -- that is a certain answer, not a failure;
 *   - `uncertain`: anything else. The gate does not know what the file
 *     carries, and says so as `not-scanned` with the reason. */
async function authorityKeysOfSettingsFile(file: string): Promise<SettingsFileScan> {
  let handle: fs.promises.FileHandle | null = null
  try {
    // O_NONBLOCK on the OPEN, not only on the read. On POSIX, opening a FIFO
    // for reading blocks until a writer appears -- BEFORE the `isFile()` check
    // below can refuse it -- so the check that was written against "the read
    // blocks" never ran: the open itself held the threadpool thread, and the
    // FIFO test below was red on Linux the first time it was run there (this
    // branch had only ever been tested on Windows). With O_NONBLOCK the open
    // returns at once and the fstat does the refusing. A regular file is not
    // affected by the flag; Windows has no such flag and the constant is
    // absent there, hence the fallback to 0.
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // Nothing there: the one open failure that is an answer.
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
      return { kind: 'uncertain', reason: 'unreadable' }
    }
    const stat = await handle.stat()
    // A FIFO, a device or a directory is not a settings file, and its `size`
    // tells you nothing about what reading it would cost. It is also not
    // ABSENT, so it is not clean either.
    if (!stat.isFile()) return { kind: 'uncertain', reason: 'unreadable' }
    if (stat.size > MAX_PROJECT_SETTINGS_BYTES) return { kind: 'uncertain', reason: 'over-cap' }
    // Read into a FIXED buffer rather than calling `handle.readFile()`. That
    // helper re-stats the handle and allocates for whatever the file is at
    // that moment, so the check above was advisory rather than a bound: with a
    // concurrent local writer, a file that stat'd at 7 bytes was measured
    // coming back at 314 MB, decoded and parsed on the main thread
    // (adversarial round 4). The buffer is the bound, and `readFully` fills
    // it to end of file rather than trusting one read.
    // cap + 1, and a byte past the cap is over the cap. Reading exactly the cap
    // would hand JSON.parse a truncated prefix of a file that grew -- possibly
    // cut mid-character -- and report whatever survived as if it were the file.
    const buf = Buffer.allocUnsafe(MAX_PROJECT_SETTINGS_BYTES + 1)
    const bytesRead = await readFully(handle, buf)
    if (bytesRead > MAX_PROJECT_SETTINGS_BYTES) return { kind: 'uncertain', reason: 'over-cap' }
    // Fewer or more bytes than the file had when it was measured: it changed
    // while it was being read, and what arrived is not a file that ever
    // existed whole. Not clean.
    if (bytesRead !== stat.size) return { kind: 'uncertain', reason: 'unreadable' }
    // Decoded as the CLI decodes it: a byte-order mark selects the encoding and
    // is dropped, so a BOM-prefixed or UTF-16 file the CLI parses is one the
    // gate parses too (adversarial review, design lens; see ./settings-text.ts).
    const raw = decodeSettingsText(buf, bytesRead)
    let keys: readonly string[] | null
    try {
      keys = authoritySettingsKeysFor('claude', raw)
    } catch (err) {
      logWarn(`[managed-launch] project settings not classified: ${stripSpoofableText(err instanceof Error ? err.message : String(err), 300)}`)
      return { kind: 'uncertain', reason: 'classifier-unavailable' }
    }
    // `null` means there was nobody to ask (no registered provider), which is
    // not the same as "this file carries nothing".
    if (keys === null) {
      logWarn(`[managed-launch] project settings not classified: no registered Claude package to ask`)
      return { kind: 'uncertain', reason: 'classifier-unavailable' }
    }
    return { kind: 'keys', keys }
  } catch {
    // The handle opened and a stat or a read then failed.
    return { kind: 'uncertain', reason: 'unreadable' }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** The most a `.git` pointer file or a `commondir` / `gitdir` file inside a
 *  linked worktree's git directory is read: they hold one path each. */
const MAX_GIT_POINTER_BYTES = 4096

/**
 * Read `handle` from offset 0 into `buf` until end of file or until `buf` is
 * full, and return how many bytes arrived.
 *
 * ONE `FileHandle.read` IS A PREFIX, NOT THE FILE. A read may legally return
 * fewer bytes than asked for -- routinely on network and FUSE filesystems, and
 * on any file a signal or a concurrent writer interrupts -- and the gate used to
 * take the first answer as the whole file: a valid prefix was parsed (or failed
 * to parse, and so reported nothing) while the unread bytes carried the
 * authority setting (exact-head review, BLOCKER). The loop keeps the fixed
 * allocation: the buffer is still the bound, so a file that grows mid-read
 * stops at `buf.length`, and the caller sizes it at cap + 1 to see the growth.
 * Every iteration advances by at least one byte or ends the loop, so a
 * filesystem that returns one byte per read costs up to cap + 1 reads: bounded,
 * and the launch never waits on it past the gate's deadline, but the scan holds
 * its thread-ceiling slot until it settles (code-quality review, noted).
 */
async function readFully(handle: fs.promises.FileHandle, buf: Buffer): Promise<number> {
  let total = 0
  while (total < buf.length) {
    const { bytesRead } = await handle.read(buf, total, buf.length - total, total)
    if (bytesRead <= 0) break
    total += bytesRead
  }
  return total
}

/** A git pointer file that changed while it was being read. Not a miss: a miss
 *  leaves the root at the worktree, and the root the CLI reads may be the main
 *  checkout, so a scan that meets this reports `unreadable` instead of reading
 *  one root and calling the other clean. */
class GitPointerChangedError extends Error {}

/** The text of a small pointer file, or null when it is absent, a symlink,
 *  not a regular file, or larger than a pointer file can be. Bounded as the
 *  settings read is: a fixed buffer, read to end of file (a short read would
 *  hand the worktree rule a truncated path, and the root the CLI uses would go
 *  unread), and a byte count that differs from the measured size -- the file
 *  changed mid-read, grown past the cap or not -- throws
 *  `GitPointerChangedError` rather than returning a spliced path or a miss
 *  (independent review of the exact-head fix: this read had the loop but not
 *  the settings read's size check). */
async function readGitPointer(file: string, followSymlink = false): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null
  try {
    if (!followSymlink && (await fs.promises.lstat(file)).isSymbolicLink()) return null
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_GIT_POINTER_BYTES) return null
    const buf = Buffer.allocUnsafe(MAX_GIT_POINTER_BYTES + 1)
    const bytesRead = await readFully(handle, buf)
    if (bytesRead !== stat.size) throw new GitPointerChangedError(`${describePath(file)} changed while it was being read`)
    return buf.toString('utf8', 0, bytesRead)
  } catch (err) {
    if (err instanceof GitPointerChangedError) throw err
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * The CLI's root-entry predicate (`Ce` in the pinned 2.1.278; its walk `Kt`
 * asks it of `<dir>/.git` at every level): a directory or a regular file by
 * `lstat`; a SYMLINK only when its text is NUL-free valid UTF-8 (`lCt`), names
 * nothing on another host or a network mount (`Li`), every component of the
 * target -- and of every link met on the way, forty deep -- is a plain entry
 * (`Q` -> `re`), and the target is a directory or a regular file. A link the
 * CLI refuses is NOT a root, and the CLI walks past it to a higher one; the
 * first port of this followed every link with a bare `stat`, so it stopped at
 * a link the CLI skipped and never read the root the CLI used (adversarial
 * confirmation pass, MAJOR). Each helper below is named for the function it
 * transcribes; the two the win32/linux builds stub to false (`so`, `jt`, the
 * darwin volume rule) are left out and recorded as a macOS residual.
 */
async function isGitRootEntry(entry: string, dir: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(entry)
    if (st.isSymbolicLink()) {
      const target = await readLinkText(entry)
      if (target === null) return false
      if (linkTargetIsElsewhere(target, dir)) return false
      if (!(await linkPathIsPlain(target, dir))) return false
      const real = await fs.promises.stat(entry)
      return real.isDirectory() || real.isFile()
    }
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/** `lCt`: the link text, or null when it holds a NUL or is not valid UTF-8. */
async function readLinkText(link: string): Promise<string | null> {
  try {
    const raw = await fs.promises.readlink(link, { encoding: 'buffer' })
    const text = raw.toString('utf8')
    if (text.includes(String.fromCharCode(0)) || !Buffer.from(text, 'utf8').equals(raw)) return null
    return text
  } catch {
    return null
  }
}

const DEVICE_PREFIX_RE = /^[\\/]\?\?[\\/]/
const UNC_DEVICE_RE = /^[\\/]{2}[?.][\\/]/
const DOT_SEGMENT_RE = /(^|[\\/])\.{1,2}[. ]*([\\/]|$)/
const ABSOLUTE_RE = /^(?:[/\\]|[A-Za-z]:[/\\])/
const ROOT_PREFIX_RE = /^(?:[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]?|[A-Za-z]:[/\\]|[/\\])/
const SEPARATORS_RE = /[/\\]+/
const TRAILING_SEPARATOR_RE = /[\\/]$/

/** `$5`: an NT object path (`\??\`), before or after win32 normalisation. */
function isNtObjectPath(t: string): boolean {
  return DEVICE_PREFIX_RE.test(t) || (t.includes('??') && DEVICE_PREFIX_RE.test(path.win32.normalize(t)))
}
/** `Nn`: two leading separators, or an NT object path. */
function isUncLike(t: string): boolean {
  return /^[\\/]{2}/.test(t) || isNtObjectPath(t)
}
/** `e$`: the UNC host, lower-cased; null for a device path that is not `UNC\`. */
function uncHostOf(t: string): string | null {
  if (/^[\\/]{2}[?.][\\/](?!unc[\\/])/i.test(t)) return null
  const m = t.match(/^[\\/]{2}(?:[?.][\\/]unc[\\/])?([^\\/]+)/i)
  return m?.[1]?.replace(/[A-Z]/g, (c) => c.toLowerCase()) ?? null
}
/** `_Se`: a UNC-like path that is a device path, has a dot segment, or names a host other than `base`'s. */
function isForeignUnc(t: string, base: string): boolean {
  if (!isUncLike(t)) return false
  if (UNC_DEVICE_RE.test(t) || isNtObjectPath(t)) return true
  if (DOT_SEGMENT_RE.test(t)) return true
  const host = uncHostOf(t)
  return host === null || host !== uncHostOf(base)
}
/** The segments of an absolute POSIX path with `.` and `..` folded, or null when it is not absolute. */
function foldedPosixSegments(t: string): string[] | null {
  if (!t.startsWith('/')) return null
  const out: string[] = []
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out
}
/** `FV`: under `/network` (case-insensitive) by its first folded segment. */
function isNetworkMount(t: string): boolean {
  if (!t.startsWith('/')) return false
  const out: string[] = []
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
    if (out.length === 1 && out[0].toLowerCase() === 'network') return true
  }
  return false
}
/** `QS`: exactly `/net`, the automounter root. */
function isNetRoot(t: string): boolean {
  const segs = foldedPosixSegments(t)
  return segs !== null && segs.length === 1 && segs[0].toLowerCase() === 'net'
}
/** `Li`: the link text, as written and as resolved against `dir`, is on another host or a network mount. */
function linkTargetIsElsewhere(text: string, dir: string): boolean {
  const resolved = path.resolve(dir, text)
  if (isForeignUnc(text, dir) || isForeignUnc(resolved, dir)) return true
  for (const o of [text, resolved]) if (isNetworkMount(o) || isNetRoot(o)) return true
  return false
}
/** `en`: the kind of an entry by `lstat`; any error but a missing path is `other`. */
async function entryKind(p: string): Promise<'symlink' | 'file' | 'dir' | 'other' | 'absent'> {
  try {
    const st = await fs.promises.lstat(p)
    if (st.isSymbolicLink()) return 'symlink'
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'other'
  }
}
/** `Q`: the target -- as written under `dir`, and as resolved -- walks clean. */
async function linkPathIsPlain(text: string, dir: string): Promise<boolean> {
  if (!(await pathWalksPlain(ABSOLUTE_RE.test(text) ? text : dir + path.sep + text, 40))) return false
  return pathWalksPlain(path.resolve(dir, text), 40)
}
/** `re`: every component of `p` is a plain entry; a link met on the way is validated and followed, `depth` deep. */
async function pathWalksPlain(p: string, depth: number): Promise<boolean> {
  if (depth <= 0) return false
  const m = ROOT_PREFIX_RE.exec(p)
  let prefix = m ? m[0] : ''
  const segs = p.slice(prefix.length).split(SEPARATORS_RE)
  for (let u = 0; u < segs.length; u += 1) {
    const seg = segs[u]
    if (seg === '' || seg === '.') continue
    if (seg === '..') { prefix = path.dirname(prefix); continue }
    prefix = path.join(prefix, seg)
    if (isNetworkMount(prefix)) return false
    const kind = await entryKind(prefix)
    if (kind === 'other') return false
    if (kind === 'symlink') {
      const text = await readLinkText(prefix)
      if (text === null) return false
      if (linkTargetIsElsewhere(text, path.dirname(prefix))) return false
      const head = ABSOLUTE_RE.test(text) ? text : path.dirname(prefix) + path.sep + text
      const rest = segs.slice(u + 1).join(path.sep)
      const next = rest ? (TRAILING_SEPARATOR_RE.test(head) ? head + rest : head + path.sep + rest) : head
      return pathWalksPlain(next, depth - 1)
    }
  }
  return true
}

/** TEST SEAM for the root-entry predicate. */
export const _isGitRootEntryForTest = isGitRootEntry

/**
 * The directory the CLI treats as the CANONICAL root of a checkout whose
 * `.git` entry is at `root` -- which is `root` itself for an ordinary clone,
 * and the MAIN checkout for a LINKED WORKTREE.
 *
 * Mirrored from the pinned 2.1.278 (`Bt`, the `canonicalRootByRoot` resolver):
 * a `.git` FILE reading `gitdir: <dir>` names the worktree's private git
 * directory under `<main>/.git/worktrees/<name>`; `<dir>/commondir` names the
 * shared git directory (`<main>/.git`); `<dir>/gitdir` must point back at this
 * worktree's own `.git`; and the parent of `<dir>` must be `<common>/worktrees`.
 * When all of that holds the canonical root is `dirname(<common>)`, the main
 * checkout -- and on POSIX that is where the CLI reads `settings.local.json`
 * from for a launch inside the worktree. The first version of this walked up
 * to the worktree and stopped, so a helper declared in the MAIN checkout's
 * local settings applied to every managed session in every linked worktree of
 * the repository with a clean verdict -- and this repo's own session model
 * puts every session in a linked worktree (adversarial re-attack, BLOCKER).
 * Any pointer that does not validate leaves the root as it was, exactly as
 * the CLI does; neither pointer file may be a symlink. A pointer that changed
 * while it was read is neither valid nor invalid: `GitPointerChangedError`
 * propagates, and the scan reports it as uncertainty.
 */
async function canonicalGitRootOf(root: string): Promise<string> {
  const entry = path.join(root, '.git')
  try {
    // `stat`, following a symlink: the CLI reads a symlinked `.git` FILE
    // through it (`ve` -> readFileSync). The pointer files INSIDE the git
    // directory stay symlink-refused (`tA`).
    if (!(await fs.promises.stat(entry)).isFile()) return root
  } catch {
    return root
  }
  const text = (await readGitPointer(entry, true))?.trim()
  if (!text || !text.startsWith('gitdir:')) return root
  const gitdir = path.resolve(root, text.slice(7).trim())
  const commonText = (await readGitPointer(path.join(gitdir, 'commondir')))?.trim()
  if (!commonText) return root
  const common = path.resolve(gitdir, commonText)
  if (path.dirname(gitdir) !== path.join(common, 'worktrees')) return root
  const backText = (await readGitPointer(path.join(gitdir, 'gitdir')))?.trim()
  if (!backText) return root
  try {
    const back = await fs.promises.realpath(path.resolve(gitdir, backText))
    if (back !== path.join(await fs.promises.realpath(root), '.git')) return root
  } catch {
    return root
  }
  if (path.basename(common) !== '.git') {
    // A shared directory not named `.git` (a bare repository): the CLI treats
    // it as the root itself unless it holds a `.git` of its own, asked with
    // the SAME predicate as the walk (`Bt`: `Ce(R(a,".git"),a)`) -- a bare
    // `stat` here took a link the CLI refuses as that `.git`, stayed at the
    // worktree, and never read the bare directory's local settings the CLI
    // applied (adversarial confirmation pass, round 6, MAJOR).
    return (await isGitRootEntry(path.join(common, '.git'), common)) ? root : common
  }
  return path.dirname(common)
}

/** TEST SEAM for the worktree pointer rule. */
export const _canonicalGitRootOfForTest = canonicalGitRootOf

/**
 * Where the CLI reads `settings.local.json` from on POSIX, when that is NOT
 * the working directory -- or `null` when it is.
 *
 * Measured on the pinned 2.1.278: `localSettings` resolves to the CANONICAL
 * GIT ROOT of the working directory when (a) the platform has uid semantics
 * (`process.geteuid`), so never on win32; (b) the root differs from the
 * working directory and from the real home directory; and (c) the root, its
 * `.git` entry and its `.claude` entry (when present) are all owned by the
 * current user. The working directory's own `settings.local.json` is then
 * ALSO read, as the legacy location. `settings.json` stays at the working
 * directory in every case. A gate that read only the working directory
 * therefore missed the file the CLI reads from the repository root for every
 * launch in a subdirectory of an owned checkout (adversarial review, MAJOR,
 * POSIX only).
 *
 * The root is found the way the CLI finds it: walk up for a `.git` entry the
 * CLI's `Ce` accepts (`isGitRootEntry`: a directory or a regular file, or a
 * symlink that passes the CLI's own text, host and path checks and lands on
 * one -- the first version walked past every symlinked `.git`, the second
 * followed every one, and each missed a root the CLI used: adversarial final
 * pass MINOR, confirmation pass MAJOR) -- with no depth bound other than the filesystem root
 * -- the CLI's walk has none, and a bound the CLI does not share is a layout
 * in which the CLI finds a root this gate does not; then a linked worktree's
 * pointer is followed to the main checkout (`canonicalGitRootOf`).
 */
async function posixCanonicalLocalSettingsRoot(cwd: string): Promise<string | null> {
  if (typeof process.geteuid !== 'function') return null
  const resolved = path.resolve(cwd)
  let dir = resolved
  let root: string | null = null
  for (;;) {
    if (await isGitRootEntry(path.join(dir, '.git'), dir)) { root = dir; break }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (root === null) return null
  root = await canonicalGitRootOf(root)
  if (root === resolved) return null
  try {
    if (root === await fs.promises.realpath(os.homedir())) return null
  } catch {
    return null
  }
  try {
    const uid = process.geteuid()
    const rootUid = (await fs.promises.stat(root)).uid
    const gitUid = (await fs.promises.lstat(path.join(root, '.git'))).uid
    let claudeUid: number | null = null
    try { claudeUid = (await fs.promises.lstat(path.join(root, '.claude'))).uid } catch { /* absent: not a veto */ }
    if (rootUid !== uid || gitUid !== uid || (claudeUid !== null && claudeUid !== uid)) return null
  } catch {
    return null
  }
  return root
}

/** TEST SEAM for the POSIX git-root rule, so a test can drive it on a
 *  fixture checkout without a launch. */
export const _posixCanonicalLocalSettingsRootForTest = posixCanonicalLocalSettingsRoot

/**
 * Authority-bearing keys a PROJECT's own settings carry, for the report.
 *
 * ASYNC, AND NEVER SYNCHRONOUS -- read the next paragraph before making it so.
 * The first version of this ran `statSync` + `readFileSync` inside
 * `withProfileHome`, which is called synchronously by every launch. A working
 * directory on an unreachable share (a sleeping NAS, a VPN that dropped, a
 * stale mapped drive -- no attacker required) then blocked the ELECTRON MAIN
 * THREAD for the SMB timeout: measured at 42 seconds, twice, on two unrelated
 * dead hosts, per file, per launch. A `try/catch` cannot catch a blocking
 * syscall.
 *
 * It is now awaited by the launch GATE (`gateManagedLaunch`), which every
 * launch path runs before it composes the environment, under a deadline and a
 * thread ceiling. Three further bounds, each from a measured failure:
 *   - the handle is OPENED and `fstat`ed, and anything that is not a regular
 *     file is refused, because `size` is 0 for a FIFO and for a character
 *     device -- so the size cap passed and the read blocked forever (POSIX) or
 *     ran to 2 GiB on `/dev/zero`;
 *   - the cap is on the file, and the classification no longer produces a
 *     sanitised COPY it would throw away: a pretty-printing stringify is
 *     O(depth^2), so a nested file UNDER the old 1 MiB cap cost 3.4 s of CPU;
 *   - the whole amendment is raced against a short deadline, so a slow path
 *     that is merely slow rather than dead still costs nothing visible.
 *
 * The files read are the ones the CLI reads for this directory: its own
 * `settings.json` and `settings.local.json`, plus, on POSIX only, the
 * repository root's `settings.local.json` when the CLI would canonicalise to
 * it (see `posixCanonicalLocalSettingsRoot`).
 *
 * It never modifies anything it reads. These files belong to the repository;
 * what a managed session does about them is REFUSE to start, not an edit.
 */
async function projectAuthoritySettingsKeys(cwd: string | null): Promise<ProjectScan> {
  if (!cwd) return { keys: [], uncertain: null }
  // The directory the gate reads must be the directory the CLI will run in.
  // Node's fs does not apply Win32 path normalisation (it prefixes `\\?\`);
  // CreateProcess does. A working directory spelled `C:\proj.` was ENOENT here
  // -- both files "absent", a clean verdict -- while a CLI spawned with that
  // cwd ran in `C:\proj` and applied its settings (adversarial round 8, MAJOR,
  // through a cloud agent's raw project path). Asked of the RESOLVED path: a
  // `..` after a dotted component (`C:\ghost.\..\proj`) is removed lexically
  // by both Node and CreateProcess, the gate reads the same folder the CLI
  // runs in, and the raw spelling turned that REFUSAL into a warning (final
  // ADR-009 confirmation pass, MAJOR).
  if (process.platform === 'win32' && hasWin32RewrittenComponent(path.resolve(cwd))) return { keys: [], uncertain: 'path-spelling' }
  const found: string[] = []
  let uncertain: ProjectScanSkipReason | null = null
  const take = (label: string, scan: SettingsFileScan): void => {
    if (scan.kind === 'keys') for (const key of scan.keys) found.push(`${label}: ${key}`)
    else if (scan.kind === 'uncertain') uncertain ??= scan.reason
  }
  for (const name of PROJECT_SETTINGS_FILES) take(name, await authorityKeysOfSettingsFile(path.join(cwd, '.claude', name)))
  let root: string | null = null
  try {
    root = await posixCanonicalLocalSettingsRoot(cwd)
  } catch (err) {
    // Which root the CLI reads is unknown, so its local settings are too. The
    // working directory's own files still count: a key found there refuses.
    if (!(err instanceof GitPointerChangedError)) throw err
    uncertain ??= 'unreadable'
  }
  if (root !== null) take('settings.local.json (repository root)', await authorityKeysOfSettingsFile(path.join(root, '.claude', 'settings.local.json')))
  return { keys: boundNames(found), uncertain }
}

/** A path with a component CreateProcess rewrites before it starts a program:
 *  measured on Windows 11, it drops trailing dots from EVERY component and a
 *  trailing space from the last (a middle component ending in a space fails to
 *  spawn at all), so a component ending in either is a spelling whose folder is
 *  not the one Node's fs opens. */
function hasWin32RewrittenComponent(p: string): boolean {
  return p.split(/[\\/]/).some((c) => c !== '' && c !== '.' && c !== '..' && /[. ]$/.test(c))
}

/** What a directory's scan found: every authority key it could name, and the
 *  first reason it could not be certain of a file, if any. */
interface ProjectScan {
  readonly keys: readonly string[]
  readonly uncertain: ProjectScanSkipReason | null
}

/** One verdict from one scan. A refusal stands whatever else was uncertain --
 *  a named authority key is reason enough; with no key, any uncertainty is
 *  `not-scanned`, never `clean`. */
function verdictOfScan(scan: ProjectScan): ProjectGateResult {
  if (scan.keys.length > 0) return { status: 'refused', keys: scan.keys }
  if (scan.uncertain !== null) return { status: 'not-scanned', reason: scan.uncertain }
  return { status: 'clean' }
}

/** TEST SEAM. The scan on its own, so a test can assert that it RETURNS on a
 *  path that would block a read -- an assertion the amended report cannot
 *  carry, because "no finding" is what both a refused scan and a blocked one
 *  look like from outside. */
export const _projectAuthoritySettingsKeysForTest = projectAuthoritySettingsKeys

/** How long the launch gate waits for the project scan. It is ON the launch
 *  path now -- the session does not start until it answers -- so it is set for
 *  a slow local disk, not for a dead share, which is refused before any syscall.
 *  Past it the launch goes ahead UNCHECKED, with a warning on the report. */
const PROJECT_GATE_DEADLINE_MS = 3000

/**
 * At most TWO project scans hold a filesystem thread at any time.
 *
 * The deadline above bounds the PROMISE, not the syscall. `fs.promises.open`
 * takes no AbortSignal (checked against Node 24: the third argument is `mode`),
 * so a gate that gives up still leaves the open running on the libuv THREADPOOL
 * until the OS gives up -- 42 seconds on an unreachable share. The pool has four
 * threads by default and this app never raises it, so four such launches stall
 * every other threadpool consumer in the main process: all of `fs.promises`,
 * and `dns.lookup`, which is how `http`/`https` resolve a hostname. Measured at
 * 21 seconds of stalled local reads and DNS (adversarial re-attack, BLOCKER).
 *
 * The deadline cannot fix that; only not starting the call can. The count of
 * scans STARTED AND NOT SETTLED is the bound, at half the default pool, and it
 * is decremented only when a scan really settles -- a watchdog that "released"
 * anything earlier was one more stranded thread per window (adversarial round
 * 5, BLOCKER). Two launches into the same directory share ONE scan. At the
 * ceiling a launch waits for a slot until its deadline, then goes ahead
 * unchecked with a warning: two wedged mounts cost this check, not the app.
 */
let outstandingProjectScans = 0
/** Half of libuv's default four-thread pool. The other half stays available to
 *  everything else in the main process however badly a mount is wedged. */
const MAX_OUTSTANDING_PROJECT_SCANS = 2
/** One scan per directory at a time; concurrent launches into it share it. */
const inFlightScans = new Map<string, Promise<ProjectGateResult>>()
let projectScanCeilingLogged = false
/** The last verdict per directory, for `peekGateVerdict`. */
const recentVerdicts = new Map<string, { verdict: ProjectGateResult; at: number }>()
/** How long a verdict may be reused by a caller that cannot await. Well inside
 *  the "settings edited after launch" boundary this app already records. */
const GATE_VERDICT_REUSE_MS = 5000

/** Test seam: the counters are process-wide, so a suite that strands a scan on
 *  purpose has to be able to put them back. */
export function _resetProjectScanStateForTest(): void {
  outstandingProjectScans = 0
  inFlightScans.clear()
  recentVerdicts.clear()
  projectScanCeilingLogged = false
}
/** Test seam: the counters as they stand, so a test can assert on the ceiling
 *  episode without spying on the logger. */
export function _projectScanStateForTest(): { inFlight: number; outstanding: number; ceilingLogged: boolean } {
  return { inFlight: inFlightScans.size, outstanding: outstandingProjectScans, ceilingLogged: projectScanCeilingLogged }
}

/**
 * A path whose root is a network share, judged WITHOUT touching the disk.
 *
 * UNC only, which is the shape that produced the measured freeze and the one
 * that can be recognised from the string alone. A MAPPED DRIVE (`Z:` pointing
 * at the same dead host) is not detectable without a call that can itself
 * block, so it is not attempted -- the thread ceiling is what bounds that case,
 * and saying so is better than a check that pretends to cover it.
 *
 * Two leading separators are not enough on their own. The Win32 device and
 * extended-length prefixes (`\\?\` and `\\.\`) start the same way and are
 * followed by a LOCAL drive (`\\?\C:\proj`, which is how a long path arrives)
 * or a local volume (`\\?\Volume{...}\`) -- and a launch there was declined as
 * a network path, unchecked, with a warning that named the wrong reason
 * (adversarial review, MAJOR). Under such a prefix, `UNC\` names a share and
 * is network; a drive letter or a volume is local and is scanned; anything
 * else (`GLOBALROOT`, a device name) is opaque and treated as network, because
 * an unchecked launch with a warning beats a read that can block.
 */
function isUncPath(p: string): boolean {
  const s = p.replace(/\//g, '\\')
  const device = /^\\\\[?.]\\(.*)$/s.exec(s)
  if (device) {
    const rest = device[1]
    if (/^[A-Za-z]:(?:\\|$)/.test(rest)) return false
    if (/^Volume\{[^\\]*\}(?:\\|$)/i.test(rest)) return false
    const unc = /^UNC\\([^\\]+)(?:\\|$)/i.exec(rest)
    if (unc) return !isLoopbackHost(unc[1])
    return true
  }
  const share = /^\\\\([^\\]+)(?:\\|$)/.exec(s)
  if (!share) return false
  return !isLoopbackHost(share[1])
}

/** A UNC host that is THIS machine. `\\localhost\C$\proj` is a spelling of a
 *  local directory -- the CLI reads it and applies what it finds -- and the
 *  first version of the rule above declined it as a network path, which is
 *  the not-scanned, launch-anyway bucket: a directory the CLI reads with a
 *  verdict the gate never formed, chosen by spelling alone (adversarial
 *  re-attack, MAJOR). Loopback by name or address, or this host's own name,
 *  is local and is scanned; a local read that the share refuses fails closed
 *  as an absent file, which is what the CLI sees too. */
function isLoopbackHost(host: string): boolean {
  // A trailing dot is the DNS root: `localhost.` and `0--1.ipv6-literal.net.`
  // resolve exactly as the undotted names do, and a suffix rule that did not
  // see past the dot put the dotted spelling in the not-scanned bucket
  // (adversarial confirmation pass, MAJOR, measured). Strip it first.
  let h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  // The IPv6 forms Windows resolves as a UNC host: the *.ipv6-literal.net
  // spelling (`0--1.ipv6-literal.net`, `-` for `:`, `s` for a zone `%`),
  // the full eight-hextet form, and -- measured on this box, contrary to the
  // first note here -- `::1` and `[::1]` themselves. The first rule
  // enumerated `::1` and its zero-padded twin and missed the literal.net
  // form, leaving it in the not-scanned, launch-anyway bucket for a directory
  // the CLI reads (adversarial final pass, MAJOR). Normalise, then compare.
  if (h.endsWith('.ipv6-literal.net')) h = h.slice(0, -'.ipv6-literal.net'.length).replace(/-/g, ':').replace(/s/g, '%')
  h = h.replace(/%.*$/, '')
  if (h === 'localhost' || h === '127.0.0.1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  const v6 = normaliseIpv6(h)
  let mappedV4: string | null = null
  if (v6 !== null) {
    if (v6 === '0:0:0:0:0:0:0:1') return true
    // An IPv4-mapped address, ::ffff:a.b.c.d, in either spelling: loopback
    // when it maps 127/8, and otherwise compared below as the IPv4 it maps.
    const m = /^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
    if (m) {
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16)
      if (hi >> 8 === 127) return true
      mappedV4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
    }
  }
  // This machine's OWN addresses are UNC hosts for itself: `\\\\192.168.1.20\\C$`
  // and the ipv6-literal.net spelling of its own link-local or ULA address
  // (zone included) resolve to the local admin share exactly as `localhost`
  // does, and a rule that knew this host only by NAME left every one of them
  // in the not-scanned bucket (adversarial confirmation pass, MAJOR,
  // measured). Compare against every address the OS reports right now.
  for (const own of ownAddresses()) {
    if (own.includes(':')) { if (v6 !== null && normaliseIpv6(own) === v6) return true }
    else if (own === h || own === mappedV4) return true
  }
  let self = ''
  try { self = os.hostname().toLowerCase() } catch { /* no name to compare */ }
  if (self === '') return false
  // The name as given, its .local form, and its short form: a host whose name
  // is fully qualified is reached as `\\\\box\\share` far more often than as
  // `\\\\box.corp.example\\share` (spec review, INFO).
  const short = self.split('.')[0]
  return h === self || h === `${self}.local` || (short !== '' && h === short)
}

/** Every IPv4 and IPv6 address on this machine's interfaces, zone stripped,
 *  lower-cased; empty when the OS will not say. Read on each call: interfaces
 *  come and go, and the classification is asked only of a UNC-shaped path. */
function ownAddresses(): string[] {
  const out: string[] = []
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const entry of list ?? []) {
        if (typeof entry?.address !== 'string' || entry.address === '') continue
        out.push(entry.address.toLowerCase().replace(/%.*$/, ''))
      }
    }
  } catch { /* no interfaces to compare */ }
  return out
}

/** An IPv6 address as eight lower-case hextets with no leading zeros, or null
 *  when `text` is not one. `::` expands; a dotted IPv4 tail folds into the
 *  last two hextets. */
function normaliseIpv6(text: string): string | null {
  if (!text.includes(':') || !/^[0-9a-f:.]+$/.test(text)) return null
  let body = text
  const v4 = /(?:^|:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(body)
  if (v4) {
    const oct = v4.slice(1, 5).map((o) => parseInt(o, 10))
    if (oct.some((o) => o > 255)) return null
    body = body.slice(0, body.length - v4[0].length + (v4[0].startsWith(':') ? 1 : 0)) + ((oct[0] << 8) | oct[1]).toString(16) + ':' + ((oct[2] << 8) | oct[3]).toString(16)
  }
  const parts = body.split('::')
  if (parts.length > 2) return null
  const head = parts[0] === '' ? [] : parts[0].split(':')
  const tail = parts.length === 2 ? (parts[1] === '' ? [] : parts[1].split(':')) : []
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null
  const all = [...head, ...Array.from({ length: fill }, () => '0'), ...tail]
  if (all.length !== 8 || all.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null
  return all.map((x) => parseInt(x, 16).toString(16)).join(':')
}

/** TEST SEAM for the loopback rule: host in, verdict out. */
export const _isLoopbackHostForTest = isLoopbackHost

/** TEST SEAM for the network-path rule: string in, verdict out, no disk. */
export const _isUncPathForTest = isUncPath

/** The cache and in-flight key for a directory: ONE SPELLING, ONE VERDICT.
 *  The first version lower-cased the key everywhere, so on Linux and macOS
 *  `/Proj` and `/proj` -- two directories -- shared a verdict (adversarial
 *  review, MAJOR); the second folded only on Windows, and the re-attack showed
 *  an NTFS directory with per-directory case sensitivity enabled (no admin
 *  needed) where `proj` and `Proj` are two directories there too. So no
 *  folding at all: a directory reached under another spelling is scanned
 *  again, which costs a read, where a shared key could cost a verdict. */
function scanKeyFor(cwd: string): string {
  return path.resolve(cwd)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.())

/**
 * THE LAUNCH GATE. Decide, before a managed session starts in `cwd`, whether
 * the project's own settings files carry anything that would redirect it.
 *
 * Returns, never throws:
 *   - `clean`        -- both files were read (or are absent) and carry no
 *                        authority key; the launch may proceed;
 *   - `refused`      -- at least one authority key was found; the caller MUST
 *                        refuse the launch and name `keys` (file and key, never
 *                        a value -- `projectAuthoritySettingsKeys` produces
 *                        names only);
 *   - `not-scanned`  -- the files could not be read safely, in full, or in
 *                        time, or could not be classified; the caller proceeds
 *                        and the report carries a WARNING. A network path is
 *                        never read on the launch path; the thread ceiling and
 *                        the deadline are two more; an unreadable, over-cap or
 *                        unclassifiable file and a failed scan are the rest.
 *                        Never cached, and never reported as clean.
 *
 * Owner decision 2026-09-22: a detectable repository override fails visibly
 * BEFORE launch. What is not detectable is a recorded boundary, not a claim.
 * The files are never modified.
 */
export async function gateManagedLaunch(cwd: string): Promise<ProjectGateResult> {
  if (isUncPath(cwd)) {
    logInfo(`[managed-launch] project settings in ${describePath(cwd)} not checked -- the working directory is a network path`)
    return { status: 'not-scanned', reason: 'network-path' }
  }
  const key = scanKeyFor(cwd)
  const deadlineAt = Date.now() + PROJECT_GATE_DEADLINE_MS
  let scan = inFlightScans.get(key)
  if (!scan) {
    // Wait for a slot under the ceiling, but only until the deadline: a wedged
    // mount elsewhere must not hold this launch for ever.
    while (outstandingProjectScans >= MAX_OUTSTANDING_PROJECT_SCANS) {
      if (Date.now() >= deadlineAt) {
        // Logged once per ceiling EPISODE: the flag is cleared when a scan
        // settles and the count drops back under the ceiling (code-quality
        // review, MINOR). The ceiling is transient, not a switch.
        if (!projectScanCeilingLogged) {
          projectScanCeilingLogged = true
          logWarn(`[managed-launch] project settings not checked -- ${outstandingProjectScans} earlier checks have not returned and each still holds a filesystem thread; checks resume when one settles`)
        }
        return { status: 'not-scanned', reason: 'thread-ceiling' }
      }
      await sleep(25)
      scan = inFlightScans.get(key)
      if (scan) break
    }
    if (!scan) {
      outstandingProjectScans += 1
      scan = projectAuthoritySettingsKeys(cwd)
        // A scan that FAILED is not a scan that found nothing: it used to be
        // caught into an empty key list and cached as clean (exact-head
        // review, BLOCKER).
        .catch((err): ProjectScan => {
          logWarn(`[managed-launch] project settings check in ${describePath(cwd)} failed: ${stripSpoofableText(err instanceof Error ? err.message : String(err), 300)}`)
          return { keys: [], uncertain: 'scan-failed' }
        })
        .then((outcome) => {
          // The verdict is cached and a refusal logged HERE, once, when the
          // scan settles -- not by each waiter after the race, which wrote the
          // cache and the log line once per concurrent launch into the same
          // directory (code-quality review, MINOR). A scan that settles after
          // every waiter gave up still leaves its verdict for the next caller:
          // the verdict is true whoever waited for it. Only a clean or a
          // refused verdict is ever cached; an uncertain one is asked afresh,
          // and it also EVICTS the one before it: a clean verdict from the last
          // scan is not the answer once a newer scan could not be certain, and
          // `peekGateVerdict` would otherwise hand it out for the rest of its
          // reuse window (independent review of the exact-head fix).
          const verdict = verdictOfScan(outcome)
          if (verdict.status !== 'not-scanned') recentVerdicts.set(key, { verdict, at: Date.now() })
          else recentVerdicts.delete(key)
          if (verdict.status === 'refused') {
            // The directory is named HERE, in the log, where the launch's own
            // refusal text (file and key only) cannot say which of several
            // directories a multi-directory launch was refused for.
            logWarn(`[managed-launch] project settings in ${describePath(cwd)} refuse a managed launch: ${verdict.keys.join(', ')}`)
          } else if (verdict.status === 'not-scanned') {
            logInfo(`[managed-launch] project settings in ${describePath(cwd)} not checked -- ${verdict.reason}`)
          }
          return verdict
        })
        .finally(() => {
          // The THREAD is back only now.
          outstandingProjectScans = Math.max(0, outstandingProjectScans - 1)
          if (outstandingProjectScans < MAX_OUTSTANDING_PROJECT_SCANS) projectScanCeilingLogged = false
          if (inFlightScans.get(key) === scan) inFlightScans.delete(key)
        })
      inFlightScans.set(key, scan)
    }
  }
  const remaining = Math.max(0, deadlineAt - Date.now())
  const verdict = await Promise.race([
    scan,
    sleep(remaining).then(() => null),
  ])
  if (verdict === null) {
    logInfo(`[managed-launch] project settings in ${describePath(cwd)} not checked -- the check did not answer within ${PROJECT_GATE_DEADLINE_MS} ms`)
    return { status: 'not-scanned', reason: 'timed-out' }
  }
  // Only a clean or a refused verdict is ever cached (see peekGateVerdict),
  // and the scan cached it itself when it settled: no `not-scanned` verdict --
  // the three returns above, or an uncertain scan -- ever produces one.
  return verdict
}

/**
 * THE LAUNCH GATE over EVERY directory a launch might run in.
 *
 * The interactive PTY path does not always run where it was configured: an
 * exact resume relaunches the CLI in the conversation's own directory, taken
 * from the persisted resume target or from the transcript, and for a session
 * that ran in its designated worktree that is the COMMON case, not an edge.
 * A gate that checked only the configured directory therefore gated a
 * directory the session did not run in and left the one it did unchecked
 * (adversarial review, BLOCKER). The resume decision itself is made late, in
 * the Claude branch, with side effects (it consumes the self-captured target
 * and may relocate a transcript), so it is not hoisted; instead every
 * directory the spawn could land in is gated here, and one verdict covers them:
 *
 *   - any `refused` refuses, with each key prefixed by the directory it was
 *     found in when more than one was gated, so the refusal names the file the
 *     user must fix;
 *   - otherwise any `not-scanned` warns (the first reason wins);
 *   - otherwise clean.
 *
 * A directory the launch does not use in the end (the resume target that turns
 * out to be gone, so the spawn falls back to the configured one) is gated too:
 * an absent directory is clean, and a present one with an authority key is
 * one the user asked to resume in. Over-refusal is the fail-closed side.
 */
export async function gateManagedLaunchDirs(cwds: readonly string[]): Promise<ProjectGateResult> {
  const unique = [...new Set(cwds.filter((c) => typeof c === 'string' && c.length > 0))]
  if (unique.length === 0) return { status: 'clean' }
  if (unique.length === 1) return gateManagedLaunch(unique[0])
  // ONE AT A TIME: a launch holds at most one of the two scan slots however
  // many directories it gates, so a resume launch cannot push a concurrent
  // launch into the thread ceiling, which is the not-scanned, launch-anyway
  // bucket (adversarial re-attack, MINOR). The deadline is per directory.
  const results: Array<{ cwd: string; result: ProjectGateResult }> = []
  for (const cwd of unique) results.push({ cwd, result: await gateManagedLaunch(cwd) })
  return mergeProjectGateResults(results)
}

/** One verdict for several directories (see `gateManagedLaunchDirs`). Pure,
 *  and exported for its test. Keys are already bounded per directory; the
 *  directory set is the configured directory, the resume target's and every
 *  worktree the resume picker can offer (`pickerCandidateDirs`), so the merged
 *  list grows with the repository's worktrees -- each directory's keys are
 *  prefixed by its own path and bounded by its own scan, and no "and N more"
 *  is re-counted across them. */
export function mergeProjectGateResults(
  results: ReadonlyArray<{ cwd: string; result: ProjectGateResult }>,
): ProjectGateResult {
  const refusedKeys: string[] = []
  let skipped: ProjectScanSkipReason | undefined
  for (const { cwd, result } of results) {
    if (result.status === 'refused') {
      // The prefix names a directory the user chose, or one a transcript
      // named: stripped and bounded before it can reach the Accounts panel,
      // like everything else that crosses to the renderer (re-attack, MINOR).
      for (const k of result.keys) refusedKeys.push(results.length > 1 ? `${displayPath(cwd)}: ${k}` : k)
    } else if (result.status === 'not-scanned' && skipped === undefined) {
      skipped = result.reason
    }
  }
  if (refusedKeys.length > 0) return { status: 'refused', keys: refusedKeys }
  if (skipped !== undefined) return { status: 'not-scanned', reason: skipped }
  return { status: 'clean' }
}

/**
 * A recent verdict for `cwd`, SYNCHRONOUSLY, or undefined when there is none
 * fresh enough. For the two launch paths that must stay synchronous up to
 * their spawn -- the auth-status probe and the headless runner, where
 * overlapping calls for one profile deliberately share a single subprocess so
 * that two CLIs cannot race one single-use refresh token -- an `await` before
 * the spawn would reopen that race. They ask here first and await the gate
 * only on a miss, which is the first call for a directory and once per
 * `GATE_VERDICT_REUSE_MS` after. A `not-scanned` verdict is never reused: it
 * is worth a fresh attempt.
 */
export function peekGateVerdict(cwd: string): ProjectGateResult | undefined {
  const hit = recentVerdicts.get(scanKeyFor(cwd))
  if (!hit || Date.now() - hit.at > GATE_VERDICT_REUSE_MS) return undefined
  return hit.verdict
}

/**
 * Run the preflight for one composed managed launch and record it.
 *
 * Never throws and never blocks: it is called on the spawn path, and a
 * diagnostic that can break a launch is worse than no diagnostic. The project
 * gate has ALREADY answered by the time this runs -- its result is passed in
 * -- so nothing here touches the filesystem, and the refusal itself is the
 * caller's (`withProfileHome` throws after recording), not this function's.
 *
 * `gate` is `null` for a launch with no working directory to gate; the report
 * then says nothing about project settings, which is honest for a launch that
 * inherits the app's own directory.
 */
export function recordManagedLaunchPreflight(
  sessionId: string,
  profileId: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  gate: ProjectGateResult | null = null,
  kind: ManagedLaunchKind = 'launch',
  /** A refusal decided AFTER the gate, by the spawn itself: the directory it
   *  would use is not one the verdict covers (see pty-manager's
   *  assertGatedDirectory). Recorded here so the panel shows it. */
  extra: {
    launchDirectoryUnverified?: string
    /** The launch runs a pinned legacy CLI instead of the installed one
     *  (ManagedLaunchContext); the provider decides which version it checks. */
    pinnedCli?: { version: string; installed: boolean }
  } = {},
): ManagedLaunchPreflight | null {
  try {
    // If the boot probe never answered (the CLI was installed after launch, or
    // one probe failed), start another now. Fire-and-forget: this launch still
    // reports `unknown`, the next one will not.
    ensureClaudeCliVersion()
    const input: ManagedLaunchPreflightInput = {
      env,
      cliVersion: peekClaudeCliVersion(),
      ...(extra.pinnedCli?.version ? { pinnedCli: extra.pinnedCli } : {}),
      // `'not-evaluated'`, never `undefined`: a launch that did not build the
      // profile home has no sanitise result, and saying nothing read as clean.
      sanitizedSettings: lastSettingsSanitiseFor(home) ?? 'not-evaluated',
      strippedAmbient: lastAmbientStripFor(home) ?? undefined,
      ...(gate?.status === 'refused' ? { repositorySettingsKeys: gate.keys } : {}),
      ...(gate?.status === 'not-scanned' ? { projectScanSkipped: gate.reason } : {}),
      ...(extra.launchDirectoryUnverified ? { launchDirectoryUnverified: extra.launchDirectoryUnverified } : {}),
    }
    const preflight = managedLaunchPreflightFor('claude', input)
    if (!preflight) return null
    const report: StoredReport = { home, profileId, sessionId, kind, at: Date.now(), seq: nextSeq++, preflight, input }
    const ring = ringFor(kind)
    const max = kind === 'probe' ? MAX_PROBE_REPORTS : MAX_REPORTS
    ring.push(report)
    if (ring.length > max) ring.splice(0, ring.length - max)
    logPreflight(sessionId, preflight)
    return preflight
  } catch (e) {
    logWarn(`[managed-launch] preflight failed for session ${sessionId}: ${(e as Error)?.message ?? e}`)
    return null
  }
}

function logPreflight(sessionId: string, preflight: ManagedLaunchPreflight): void {
  for (const f of preflight.findings) {
    const line = `[managed-launch] session ${sessionId}: ${f.id} -- ${f.title}: ${f.detail}${f.action ? ` -> ${f.action}` : ''}`
    if (f.severity === 'info') logInfo(line)
    else logWarn(line)
  }
  if (preflight.findings.length === 0) {
    logInfo(`[managed-launch] session ${sessionId}: preflight clean (Claude Code ${preflight.compatibility.found ?? 'unknown'}) -- a record of what the launch did, not a claim of isolation`)
  }
}

/**
 * Newest first, for ONE profile. The `profileId` argument is required.
 *
 * It used to hand the whole process-wide ring buffer to any caller, which made
 * the diagnostic leak across the boundary it exists to defend (adversarial
 * review, MAJOR 5). Three things crossed per account with nothing saying which
 * account they belonged to: the absolute profile-home path, and therefore the OS
 * username; the settings keys stripped from THAT account's copy; and the ambient
 * variable names stripped from THAT account's environment -- which is enough to
 * tell one account's owner that another routes through Bedrock or a corporate
 * proxy. The panel then deduped by finding id, so a second account's occurrence
 * was not merely unattributed, it was invisible.
 *
 * `home` is deliberately not returned: it is an absolute path, the caller
 * already knows which profile it asked for, and the id is what the UI needs.
 */
export function listManagedLaunchReports(profileId: string): readonly ManagedLaunchReport[] {
  if (typeof profileId !== 'string' || profileId.length === 0) return []
  // Both rings, newest first overall. They are kept apart so a probe cannot
  // EVICT a launch, not so the caller sees a different set: the panel still
  // wants a probe when a profile has nothing else, and `kind` is what lets it
  // prefer one over the other.
  return [...reports, ...probeReports]
    .filter((r) => r.profileId === profileId)
    .sort((a, b) => b.seq - a.seq)
    .map((r) => ({ profileId: r.profileId, sessionId: r.sessionId, kind: r.kind, at: r.at, preflight: r.preflight }))
}

export function _resetManagedLaunchReportsForTest(): void {
  reports.length = 0
  probeReports.length = 0
  nextSeq = 0
}
