// Sentinel service singleton (spec §5/§6): state, Trigger A observe, Trigger B
// startup check, and the user-action API consumed by IPC handlers.
import { SentinelState } from './sentinel-state'
import { makeObserver, type Observation } from './sentinel-observe'
import { parseClaudeVersion, minVersionFindings, type ManifestEntry } from './sentinel-version'
import { fetchChangelog, sliceChangelog } from './sentinel-changelog'
import { runAnalysis } from './sentinel-analysis'
import { validateProposal } from './sentinel-apply'
import { getRegistry, getBaseline, applyOverlayEntry, removeOverlayEntry, loadOverlay, setOverlay } from '../model-registry-service'
import { reconcileOverlay } from '../../shared/model-registry'
import { spawnClaudeHeadless } from '../claude-headless'
import manifestJson from '../../../resources/sentinel-assumption-manifest.json'
import { logInfo } from '../debug-logger'

const manifest = manifestJson as unknown as ManifestEntry[]
let state: SentinelState | null = null
let observer: ((obs: Observation) => void) | null = null

export function initSentinel(resourcesDir: string): SentinelState {
  state = new SentinelState(resourcesDir)
  observer = makeObserver(state, getRegistry)
  return state
}
export function getSentinelState(): SentinelState | null { return state }
export function sentinelObserve(obs: Observation): void { observer?.(obs) }

/** First launch after a CCC update: retire overlay entries the new baseline covers (spec §4). */
export function reconcileOnUpdate(): void {
  if (!state) return
  const overlay = loadOverlay()
  if (!overlay?.models?.length) return
  const r = reconcileOverlay(getBaseline(), overlay)
  if (r.autoRetired.length) {
    setOverlay(r.overlay)
    for (const m of r.autoRetired) state.upsertFinding({
      id: `retired:${m.id}`, kind: 'info', severity: 'info',
      title: `Registry amendment retired: ${m.id}`,
      evidence: 'This CCC release ships its own entry for this model; your Sentinel amendment was removed.',
      status: 'open', createdAt: Date.now(),
    })
  }
  for (const m of r.retireProposals) state.upsertFinding({
    id: `retire-proposal:${m.id}`, kind: 'info', severity: 'info',
    title: `Your custom entry for ${m.id} may be superseded`,
    evidence: 'This CCC release ships an entry for this model id; your user-authored amendment still wins. Revert it from Applied if you prefer the shipped one.',
    status: 'open', createdAt: Date.now(),
  })
}

/** Trigger B startup check (spec §5). Non-blocking — call fire-and-forget from bootstrap. */
export async function sentinelStartupCheck(): Promise<void> {
  if (!state) return
  try {
    const res = await spawnClaudeHeadless(['--version'], 15000)
    const version = res.code === 0 ? parseClaudeVersion(res.stdout) : null
    if (!version) { logInfo('[sentinel] claude --version unavailable; skipping (fail-open)'); return }
    for (const f of minVersionFindings(version, manifest)) state.upsertFinding(f)
    const last = state.snapshot().lastSeenCcVersion
    if (last === version) return
    if (last === null) { state.setLastSeenCcVersion(version); return }   // first run: baseline, no analysis
    await analyzeVersionChange(last, version)
  } catch (err) {
    state?.setAnalyzing(false, (err as Error).message)         // fail-open, always
  }
}

async function analyzeVersionChange(last: string, version: string): Promise<void> {
  if (!state) return
  state.setAnalyzing(true)
  const md = await fetchChangelog()
  if (!md) {
    state.setAnalyzing(false, 'changelog unavailable — retry from the Sentinel panel')
    state.upsertFinding({
      id: `cc:${version}:unavailable`, kind: 'info', severity: 'info',
      title: `Claude Code updated ${last} → ${version} — analysis unavailable (offline?)`,
      evidence: 'Changelog fetch failed. Use Re-run in the Sentinel panel.',
      status: 'open', createdAt: Date.now(),
    })
    return
  }
  const result = await runAnalysis({
    runner: (args, t, stdin) => spawnClaudeHeadless(args, t, stdin),
    changelog: sliceChangelog(md, last, version),
    manifestJson: JSON.stringify(manifest), registryJson: JSON.stringify(getRegistry()),
    from: last, to: version,
  })
  if (result.ok) {
    for (const f of result.findings) state.upsertFinding(f)
    state.setLastSeenCcVersion(version)
    state.setAnalyzing(false)
  } else {
    state.setAnalyzing(false, result.error)
  }
}

/**
 * Manual Re-run from the panel: re-analyze to the CURRENT version even if already seen.
 * When last === version (typical re-run on an unchanged install), analyzeVersionChange
 * calls sliceChangelog(md, version, version) which slices (v, v] = empty set → falls
 * back to the head-5 sections so the AI re-analyzes the most recent entries. Acceptable
 * UX: the user explicitly requested a fresh look.
 */
export async function sentinelRerun(): Promise<void> {
  if (!state) return
  try {
    const res = await spawnClaudeHeadless(['--version'], 15000)
    const version = res.code === 0 ? parseClaudeVersion(res.stdout) : null
    if (!version) { state.setAnalyzing(false, 'claude --version unavailable'); return }
    const last = state.snapshot().lastSeenCcVersion ?? version
    await analyzeVersionChange(last, version)
  } catch (err) {
    state?.setAnalyzing(false, (err as Error).message)
  }
}

export function sentinelApply(findingId: string): { ok: boolean; error?: string } {
  if (!state) return { ok: false, error: 'sentinel not initialized' }
  const f = state.snapshot().findings.find((x) => x.id === findingId)
  if (!f?.proposedPatch) return { ok: false, error: 'no proposed patch on this finding' }
  const v = validateProposal(getRegistry(), f.proposedPatch)
  if (!v.ok) return v
  applyOverlayEntry(f.proposedPatch)
  state.setStatus(findingId, 'applied')
  return { ok: true }
}

export function sentinelRevert(findingId: string): void {
  if (!state) return
  const f = state.snapshot().findings.find((x) => x.id === findingId)
  if (f?.proposedPatch) { removeOverlayEntry(f.proposedPatch.id); state.setStatus(findingId, 'open') }
}

export function sentinelSetStatus(findingId: string, status: 'dismissed' | 'muted'): void {
  state?.setStatus(findingId, status)
}
