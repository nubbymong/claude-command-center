// Persistent Sentinel state: lastSeenCcVersion + findings (spec §5). Atomic
// writes; corrupt file -> empty state (fail-open invariant, spec §7).
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import { analysisFindingKey } from './sentinel-quote'
import type { SentinelFinding, SentinelStateSnapshot, FindingStatus, SentinelProvider } from '../../shared/sentinel-types'

export class SentinelState {
  private file: string
  private state: SentinelStateSnapshot = {
    lastSeenCcVersion: null, lastSeenCodexVersion: null, analyzing: false, analyzingProvider: null, lastAnalysisAt: null, lastAnalysisError: null, findings: [],
  }
  private subs = new Set<(s: SentinelStateSnapshot) => void>()

  constructor(resourcesDir: string) {
    this.file = path.join(resourcesDir, 'sentinel', 'sentinel-state.json')
    try {
      if (fs.existsSync(this.file)) {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        if (loaded && Array.isArray(loaded.findings)) this.state = { ...this.state, ...loaded, analyzing: false, analyzingProvider: null }
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
  setLastSeenCcVersion(v: string): void { this.state = { ...this.state, lastSeenCcVersion: v }; this.persist() }
  /** P3.9: the Codex version the last completed check saw. */
  setLastSeenCodexVersion(v: string): void { this.state = { ...this.state, lastSeenCodexVersion: v }; this.persist() }
  /** Round 4: one more analysis of `key` (`<provider>:<version>`) whose
   *  findings could not all be matched to its notes; the count so far.
   *  Round 5: the counts of that provider's other versions (superseded
   *  before their last try) are dropped. */
  countUnverified(key: string): number {
    const tries: Record<string, number> = {}
    const provider = key.slice(0, key.indexOf(':') + 1)
    for (const [k, v] of Object.entries(this.state.unverifiedTries ?? {})) if (k === key || !provider || !k.startsWith(provider)) tries[k] = v
    const now = (typeof tries[key] === 'number' && Number.isFinite(tries[key]) ? tries[key] : 0) + 1
    tries[key] = now
    this.state = { ...this.state, unverifiedTries: tries }
    this.persist()
    return now
  }
  /** Round 4: forget `key`'s count (its version is recorded); round 5:
   *  and every other count of the same provider. */
  clearUnverified(key: string): void {
    const tries = this.state.unverifiedTries
    const provider = key.slice(0, key.indexOf(':') + 1)
    if (!tries || !Object.keys(tries).some((k) => k === key || (provider && k.startsWith(provider)))) return
    const rest: Record<string, number> = {}
    for (const [k, v] of Object.entries(tries)) if (k !== key && !(provider && k.startsWith(provider))) rest[k] = v
    this.state = { ...this.state, unverifiedTries: rest }
    this.persist()
  }
  /** `provider` (P3.9): whose update the analysis starting now is about.
   *  `note` (round 1): what to say beside a completed analysis that did not
   *  read everything in full; cleared when a new one starts. */
  setAnalyzing(analyzing: boolean, error: string | null = null, provider: SentinelProvider | null = null, note: string | null = null): void {
    this.state = { ...this.state, analyzing, analyzingProvider: analyzing ? provider : null, lastAnalysisError: error, lastAnalysisNote: analyzing ? null : note, lastAnalysisAt: analyzing ? this.state.lastAnalysisAt : Date.now() }
    this.persist()
  }
}
