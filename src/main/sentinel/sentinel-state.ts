// Persistent Sentinel state: lastSeenCcVersion + findings (spec §5). Atomic
// writes; corrupt file -> empty state (fail-open invariant, spec §7).
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import { analysisFindingKey } from './sentinel-quote'
import { compareVersions } from '../../shared/version-order'
import type { SentinelFinding, SentinelStateSnapshot, FindingStatus, SentinelProvider } from '../../shared/sentinel-types'

/** Fixer 10: the most versions of one provider whose counts of unmatched
 *  analyses the file keeps (countUnverified). */
export const UNVERIFIED_VERSIONS_KEPT = 8

/** Fixer 11 (ADR-009 R2-1): a stored version, only when it is a string;
 *  anything else (a damaged or hand-edited file) is none, so the next start
 *  takes the installed version as its baseline again. */
const storedVersion = (v: unknown): string | null => (typeof v === 'string' ? v : null)
/** The higher of two versions, either of which may be none. */
const higher = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : compareVersions(b, a) > 0 ? b : a)
/** Fixer 11: each provider's version the panel names, and its highest
 *  version checked, by field. */
const SHOWN_FIELD = { claude: 'lastSeenCcVersion', codex: 'lastSeenCodexVersion' } as const satisfies Record<SentinelProvider, keyof SentinelStateSnapshot>
const CHECKED_FIELD = { claude: 'highestCheckedCcVersion', codex: 'highestCheckedCodexVersion' } as const satisfies Record<SentinelProvider, keyof SentinelStateSnapshot>

export class SentinelState {
  private file: string
  private state: SentinelStateSnapshot = {
    lastSeenCcVersion: null, lastSeenCodexVersion: null, highestCheckedCcVersion: null, highestCheckedCodexVersion: null, analyzing: false, analyzingProvider: null, lastAnalysisAt: null, lastAnalysisError: null, findings: [],
  }
  private subs = new Set<(s: SentinelStateSnapshot) => void>()

  constructor(resourcesDir: string) {
    this.file = path.join(resourcesDir, 'sentinel', 'sentinel-state.json')
    try {
      if (fs.existsSync(this.file)) {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        if (loaded && Array.isArray(loaded.findings)) {
          // Fixer 11: the versions are kept only when they are strings, and a
          // file from before fixer 11 has no highest version checked: its
          // recorded version is that (before, every check recorded the
          // version it saw). Neither is ever below the version shown.
          const cc = storedVersion(loaded.lastSeenCcVersion)
          const codex = storedVersion(loaded.lastSeenCodexVersion)
          this.state = {
            ...this.state, ...loaded, analyzing: false, analyzingProvider: null,
            lastSeenCcVersion: cc,
            lastSeenCodexVersion: codex,
            highestCheckedCcVersion: higher(storedVersion(loaded.highestCheckedCcVersion), cc),
            highestCheckedCodexVersion: higher(storedVersion(loaded.highestCheckedCodexVersion), codex),
          }
        }
      }
    } catch { /* corrupt -> empty (fail-open) */ }
  }

  snapshot(): SentinelStateSnapshot { return this.state }
  subscribe(fn: (s: SentinelStateSnapshot) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn) }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Retry left ON, deliberately. An earlier revision passed retry:false to
      // keep the boot loop (one persist per finding) off a blocking wait -- but
      // persist() is ALSO the user-click path: setStatus(id, 'dismissed') calls
      // it once per dismissal, and upsertFinding's "never resurrect dismissed"
      // dedup reads the file. Dropping that write silently resurrects a finding
      // the user dismissed, at the next boot. The retry only engages when a
      // rename has already failed, so the normal path costs nothing.
      atomicWriteFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch { /* persistence failure must not break the app */ }
    for (const fn of this.subs) { try { fn(this.state) } catch { /* subscriber */ } }
  }

  upsertFinding(f: SentinelFinding): void {
    const existing = this.state.findings.find((x) => x.id === f.id)
    if (existing) return                       // dedup; never resurrect dismissed/applied
    // P3.9 round 2: an analysis finding of the same version with the same
    // quote is the same finding, whatever its id (one kept under an older id,
    // or one worded differently): it keeps that one's status.
    const key = analysisFindingKey(f)
    if (key !== null && this.state.findings.some((x) => analysisFindingKey(x) === key)) return
    this.state = { ...this.state, findings: [...this.state.findings, f] }
    this.persist()
  }
  setStatus(id: string, status: FindingStatus): void {
    this.state = { ...this.state, findings: this.state.findings.map((f) => f.id === id ? { ...f, status } : f) }
    this.persist()
  }
  /** A completed check of Claude Code `v`: the panel names it, and (fixer
   *  11) the highest version checked rises to it when it is higher, never
   *  going down for a start (a downgrade seen there) or a start-up analysis
   *  (fixer 13, gate 3 F17: a Re-run is an analysis too). Fixer 12
   *  (ADR-009 R3-1): a Re-run's record (`rerun`), the user's own act, sets it
   *  to `v`, down as well as up, so a highest stuck far ahead (a hand-edited
   *  file, a prerelease once installed) can be undone. */
  setLastSeenCcVersion(v: string, opts: { rerun?: boolean } = {}): void {
    this.state = { ...this.state, lastSeenCcVersion: v, highestCheckedCcVersion: opts.rerun === true ? v : higher(this.state.highestCheckedCcVersion ?? null, v) }
    this.persist()
  }
  /** P3.9: the same for Codex `v`. */
  setLastSeenCodexVersion(v: string, opts: { rerun?: boolean } = {}): void {
    this.state = { ...this.state, lastSeenCodexVersion: v, highestCheckedCodexVersion: opts.rerun === true ? v : higher(this.state.highestCheckedCodexVersion ?? null, v) }
    this.persist()
  }
  /** Fixer 11: the highest version of `provider` recorded as checked (none
   *  before its first check), which the start-up rule and the cap go by. */
  highestChecked(provider: SentinelProvider): string | null {
    return this.state[CHECKED_FIELD[provider]] ?? null
  }
  /** Fixer 11: the version of `provider` the panel names (none before its
   *  first check). */
  shownVersion(provider: SentinelProvider): string | null {
    return this.state[SHOWN_FIELD[provider]] ?? null
  }
  /** Round 4: one more analysis of `key` (`<provider>:<version>`) whose
   *  findings could not all be matched to its notes; the count so far.
   *  Fixer 10 (the cap for versions installed in turn): no other version's
   *  count is dropped here. A start analyses only a version higher than the
   *  highest one checked (sentinel/index.ts, isUpdateAtStart; fixer 11: no
   *  start-up analysis lowers it; fixer 12: a Re-run's record sets it to
   *  the version the Re-run checked, so after a Re-run of a lower version a
   *  higher one taken in turn is an update again, at most
   *  UNVERIFIED_MAX_TRIES analyses, a cost of that Re-run), so a count
   *  kept is of a version that may still be analysed, another install's taken
   *  in turn with this one; dropping it (as round 5 and fixer 9 did, for a
   *  lower version) let that version be analysed again from one, past the
   *  cap. Recording a version drops the counts it makes moot
   *  (clearUnverified). So the file stays small, a provider keeps the count
   *  made now and the counts of its UNVERIFIED_VERSIONS_KEPT - 1 highest
   *  other versions (versions installed one after another, each superseded
   *  before its third analysis, go from the lowest); only more versions than
   *  UNVERIFIED_VERSIONS_KEPT, all above the highest one checked, taken in
   *  turn with every analysis unmatched, could each be analysed more than
   *  UNVERIFIED_MAX_TRIES times at start between two Re-runs. */
  countUnverified(key: string): number {
    const tries: Record<string, number> = { ...(this.state.unverifiedTries ?? {}) }
    const now = (typeof tries[key] === 'number' && Number.isFinite(tries[key]) ? tries[key] : 0) + 1
    tries[key] = now
    const provider = key.slice(0, key.indexOf(':') + 1)
    if (provider) {
      const versionOf = (k: string) => k.slice(provider.length)
      const others = Object.keys(tries).filter((k) => k !== key && k.startsWith(provider))
      others.sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
      for (const k of others.slice(UNVERIFIED_VERSIONS_KEPT - 1)) delete tries[k]
    }
    this.state = { ...this.state, unverifiedTries: tries }
    this.persist()
    return now
  }
  /** Round 4: forget `key`'s count (its version is recorded). Fixer 10: and
   *  the same provider's counts of versions at or below it, which a start no
   *  longer analyses; a higher version's count is kept, so a version taken
   *  in turn with the one recorded still stops at the cap. */
  clearUnverified(key: string): void {
    const tries = this.state.unverifiedTries
    const provider = key.slice(0, key.indexOf(':') + 1)
    const version = key.slice(provider.length)
    const moot = (k: string): boolean => k === key || (!!provider && k.startsWith(provider) && compareVersions(k.slice(provider.length), version) <= 0)
    if (!tries || !Object.keys(tries).some(moot)) return
    const rest: Record<string, number> = {}
    for (const [k, v] of Object.entries(tries)) if (!moot(k)) rest[k] = v
    this.state = { ...this.state, unverifiedTries: rest }
    this.persist()
  }
  /** `provider` (P3.9): whose update the analysis starting now is about.
   *  `note` (round 1): what to say beside a completed analysis that did not
   *  read everything in full; cleared when a new one starts. `failed` (PR 4,
   *  owner answers review): the error is a failed analysis (the title-bar
   *  chip says the analysis did not complete); cleared when a new one starts. */
  setAnalyzing(analyzing: boolean, error: string | null = null, provider: SentinelProvider | null = null, note: string | null = null, failed = false): void {
    this.state = { ...this.state, analyzing, analyzingProvider: analyzing ? provider : null, lastAnalysisError: error, lastAnalysisFailed: analyzing ? false : failed, lastAnalysisNote: analyzing ? null : note, lastAnalysisAt: analyzing ? this.state.lastAnalysisAt : Date.now() }
    this.persist()
  }
}
