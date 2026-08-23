// Sentinel service singleton (spec §5/§6): state, Trigger A observe, Trigger B
// startup check, and the user-action API consumed by IPC handlers.
import { SentinelState } from './sentinel-state'
import { makeObserver, type Observation } from './sentinel-observe'
import { parseClaudeVersion, minVersionFindings, type ManifestEntry } from './sentinel-version'
import { fetchChangelog, sliceChangelog } from './sentinel-changelog'
import { runAnalysis } from './sentinel-analysis'
import { validateProposal } from './sentinel-apply'
import { modelCoverageFindings, modelCheckFailedFinding, EXPECTED_MODEL_SET } from './sentinel-models'
import { fetchArticleModelIds } from './sentinel-model-article'
import { getRegistry, getBaseline, applyOverlayEntry, removeOverlayEntry, loadOverlay, setOverlay } from '../model-registry-service'
import { reconcileOverlay } from '../../shared/model-registry'
import manifestJson from '../../../resources/sentinel-assumption-manifest.json'
import { logInfo } from '../debug-logger'

const manifest = manifestJson as unknown as ManifestEntry[]
let state: SentinelState | null = null
let observer: ((obs: Observation) => void) | null = null
// The in-flight AI analysis, so a new run or a disable can abort it (kill tree).
let currentAnalysis: AbortController | null = null

export function initSentinel(resourcesDir: string): SentinelState {
  state = new SentinelState(resourcesDir)
  observer = makeObserver(state, getRegistry)
  return state
}
export function getSentinelState(): SentinelState | null { return state }
export function sentinelObserve(obs: Observation): void { observer?.(obs) }

/** First launch after a CCC update: retire overlay entries the new baseline
 *  covers. Housekeeping only — severe-breaking-only Sentinel no longer raises
 *  user-facing findings for registry reconciliation. */
export function reconcileOnUpdate(): void {
  if (!state) return
  const overlay = loadOverlay()
  if (!overlay?.models?.length) return
  const r = reconcileOverlay(getBaseline(), overlay)
  if (r.autoRetired.length) setOverlay(r.overlay)
}

// Lazy: claude-headless imports the pty-manager graph (which reaches electron.app
// via update-watcher). Trigger A consumers (effort-tracker, statusline-watcher)
// import THIS module at load — keep their import chains free of that weight.
async function headlessRunner(): Promise<typeof import('../claude-headless')> {
  return import('../claude-headless')
}

/**
 * Home for Sentinel's headless spawns, resolved FRESH per run so a Settings
 * change applies to the next analysis. User-selected analysis account
 * (sentinelAccountProfileId) → captured primary → bare global (single-account
 * installs). Never bare-global when profiles exist: the frozen global login
 * hangs at auth / carries stale rate-limit state (live repro: both analysis
 * attempts timed out at 180s on 2026-06-12).
 */
async function analysisHome(): Promise<string | null> {
  try {
    const { readConfig } = await import('../config-manager')
    const { resolveHeadlessProfileHome } = await import('../account-profiles')
    const settings = readConfig<{ sentinelAccountProfileId?: string | null }>('settings')
    return resolveHeadlessProfileHome(settings?.sentinelAccountProfileId).home
  } catch {
    return null // fail-open: bare global is still better than no analysis
  }
}

/**
 * Model-registry coverage against the Claude Code model configuration (#385).
 *
 * The fetch fails soft to null (offline), which selects snapshot mode inside
 * modelCoverageFindings — an unread article is a degraded check, not an error.
 * A THROW is different: it means the guard did not run, so it raises a finding
 * of its own rather than disappearing into a log line (review Q5).
 */
async function runModelCoverageCheck(): Promise<void> {
  if (!state) return
  try {
    const liveIds = await fetchArticleModelIds()
    for (const f of modelCoverageFindings(getRegistry(), EXPECTED_MODEL_SET, Date.now(), liveIds)) {
      state.upsertFinding(f)
    }
  } catch (err) {
    const msg = (err as Error).message
    logInfo(`[sentinel] model coverage check failed: ${msg}`)
    state.upsertFinding(modelCheckFailedFinding(msg))
  }
}

/** Trigger B startup check (spec §5). Non-blocking — call fire-and-forget from bootstrap. */
export async function sentinelStartupCheck(): Promise<void> {
  if (!state) return
  // Model-registry coverage (#385) runs FIRST and unconditionally: it does not
  // need a working `claude` binary, so it must not sit behind the --version
  // probe's fail-open return below. It reads the live article when the network
  // allows and falls back to the shipped snapshot when it does not (review S1).
  await runModelCoverageCheck()
  try {
    const { spawnClaudeHeadless } = await headlessRunner()
    const res = await spawnClaudeHeadless(['--version'], 15000, undefined, await analysisHome())
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
  // A new run supersedes any in-flight one (kills its process tree) so a stale
  // analysis can't finish late and clobber state or leave `analyzing` stuck.
  currentAnalysis?.abort()
  const ac = new AbortController()
  currentAnalysis = ac
  state.setAnalyzing(true)
  const md = await fetchChangelog()
  if (!md) {
    // Analysis-unavailable is the degraded state, shown as a calm note -- not a
    // finding. Findings are reserved for actual severe breaking changes now.
    if (currentAnalysis === ac) currentAnalysis = null
    state.setAnalyzing(false, 'Changelog unavailable (offline?). Use Re-run in the Sentinel panel.')
    return
  }
  const { spawnClaudeHeadless } = await headlessRunner()
  const home = await analysisHome()
  const result = await runAnalysis({
    runner: (args, t, stdin) => spawnClaudeHeadless(args, t, stdin, home, ac.signal),
    changelog: sliceChangelog(md, last, version),
    from: last, to: version,
  })
  if (currentAnalysis === ac) currentAnalysis = null
  if (ac.signal.aborted) return                        // superseded / cancelled: drop the result
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
    const { spawnClaudeHeadless } = await headlessRunner()
    const res = await spawnClaudeHeadless(['--version'], 15000, undefined, await analysisHome())
    const version = res.code === 0 ? parseClaudeVersion(res.stdout) : null
    if (!version) { state.setAnalyzing(false, 'claude --version unavailable'); return }
    const last = state.snapshot().lastSeenCcVersion ?? version
    await analyzeVersionChange(last, version)
  } catch (err) {
    state?.setAnalyzing(false, (err as Error).message)
  }
}

/** Abort any in-flight analysis (kills its process tree) and clear `analyzing`.
 *  Wire to Sentinel-disable / analysis-account-change so a slow run can't linger.
 *  Safe to call when nothing is running. */
export function sentinelCancel(): void {
  currentAnalysis?.abort()
  currentAnalysis = null
  state?.setAnalyzing(false)
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
