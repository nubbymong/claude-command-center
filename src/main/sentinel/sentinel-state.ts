// Persistent Sentinel state: lastSeenCcVersion + findings (spec §5). Atomic
// writes; corrupt file -> empty state (fail-open invariant, spec §7).
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import type { SentinelFinding, SentinelStateSnapshot, FindingStatus } from '../../shared/sentinel-types'

export class SentinelState {
  private file: string
  private state: SentinelStateSnapshot = {
    lastSeenCcVersion: null, analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [],
  }
  private subs = new Set<(s: SentinelStateSnapshot) => void>()

  constructor(resourcesDir: string) {
    this.file = path.join(resourcesDir, 'sentinel', 'sentinel-state.json')
    try {
      if (fs.existsSync(this.file)) {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        if (loaded && Array.isArray(loaded.findings)) this.state = { ...this.state, ...loaded, analyzing: false }
      }
    } catch { /* corrupt -> empty (fail-open) */ }
  }

  snapshot(): SentinelStateSnapshot { return this.state }
  subscribe(fn: (s: SentinelStateSnapshot) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn) }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      atomicWriteFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch { /* persistence failure must not break the app */ }
    for (const fn of this.subs) { try { fn(this.state) } catch { /* subscriber */ } }
  }

  upsertFinding(f: SentinelFinding): void {
    const existing = this.state.findings.find((x) => x.id === f.id)
    if (existing) return                       // dedup; never resurrect dismissed/applied
    this.state = { ...this.state, findings: [...this.state.findings, f] }
    this.persist()
  }
  setStatus(id: string, status: FindingStatus): void {
    this.state = { ...this.state, findings: this.state.findings.map((f) => f.id === id ? { ...f, status } : f) }
    this.persist()
  }
  setLastSeenCcVersion(v: string): void { this.state = { ...this.state, lastSeenCcVersion: v }; this.persist() }
  setAnalyzing(analyzing: boolean, error: string | null = null): void {
    this.state = { ...this.state, analyzing, lastAnalysisError: error, lastAnalysisAt: analyzing ? this.state.lastAnalysisAt : Date.now() }
    this.persist()
  }
}
