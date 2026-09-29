// Sentinel service singleton (spec §5/§6): state, Trigger A observe, Trigger B
// startup check, and the user-action API consumed by IPC handlers.
//
// P3.9 (row 42): Codex as well, the same way. While Codex is on, the start-up
// check and a Re-run check the installed Codex CLI's version against the range
// the app supports (a finding when it is outside), compare the model registry
// with the model list that CLI offers (read from it: row 39), and, when the
// version changed since the last check, analyse Codex's release notes against
// the four surfaces the app relies on (its launch flags and its session files
// among them). Each analysis runs on the provider that is on; with both on, on
// the one Ask Conductor runs on (OD27 M4; Claude Code until that setting is
// built). A provider that is off is never checked, probed or analysed.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SentinelState } from './sentinel-state'
import { makeObserver, type Observation } from './sentinel-observe'
import { parseClaudeVersion, minVersionFindings, type ManifestEntry } from './sentinel-version'
import { fetchChangelog, sliceChangelog } from './sentinel-changelog'
import { fetchCodexReleaseNotes } from './sentinel-codex-changelog'
import { runAnalysis, type HeadlessRunner } from './sentinel-analysis'
import { validateProposal } from './sentinel-apply'
import { modelCoverageFindings, modelCheckFailedFinding, EXPECTED_MODEL_SET, codexModelCoverageFindings, CODEX_EXPECTED_MODEL_SET, type CodexLiveModelList } from './sentinel-models'
import { codexVersionFindings, type SupportedVersions } from './sentinel-codex'
import { fetchArticleModelIds } from './sentinel-model-article'
import { getRegistry, getBaseline, applyOverlayEntry, removeOverlayEntry, loadOverlay, setOverlay } from '../model-registry-service'
import { reconcileOverlay } from '../../shared/model-registry'
import { sentinelAnalysisProvider } from '../../shared/ask-conductor-provider'
import { stripSpoofableText } from '../../shared/safe-text'
import type { SentinelFinding, SentinelProvider } from '../../shared/sentinel-types'
import type { ProviderInstallationView } from '../../shared/providers'
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

/** Sentinel's runs in flight, per provider, counted from the launch check to
 *  the end: Claude Code's version check and the analysis that may follow it;
 *  (P3.9) Codex's version check and model list read, and an analysis that
 *  runs on Codex. */
const runsInFlight = new Map<SentinelProvider, number>()
const countRun = (provider: SentinelProvider, by: 1 | -1) => { runsInFlight.set(provider, (runsInFlight.get(provider) ?? 0) + by) }

/** WP2: Sentinel's Claude runs in flight, which are Claude Code in use for
 *  the switch-off rule (provider-in-use.ts). */
export function sentinelClaudeRunsInFlight(): number {
  return runsInFlight.get('claude') ?? 0
}

/** P3.9: Sentinel's Codex runs in flight, which are Codex in use for the
 *  switch-off rule (provider-in-use.ts), as its Claude runs are Claude Code's. */
export function sentinelCodexRunsInFlight(): number {
  return runsInFlight.get('codex') ?? 0
}

/** WP2: main's one launch rule (provider-launch-gate.ts) for a Sentinel
 *  run of a provider's CLI, and, when it may run, the run counted as that
 *  provider in use in the same step, so a switch-off cannot slip between the
 *  check and the count. `probe`: a check nobody asked for (the start-up
 *  check), which is not logged when skipped. Lazy for the same reason as
 *  headlessRunner (the accounts graph is heavy). */
async function beginRun(provider: SentinelProvider, opts: { probe: boolean }): Promise<{ refused: string } | { end: () => void }> {
  const gate = await import('../provider-launch-gate')
  const refusal = opts.probe ? gate.providerProbeRefusal(provider) : gate.providerLaunchRefusal(provider)
  if (refusal) return { refused: refusal.message }
  countRun(provider, 1)
  let ended = false
  return {
    end: () => {
      if (ended) return
      ended = true
      countRun(provider, -1)
    },
  }
}

/** The launch rule again, for a later step. A refusal is the reason, in
 *  plain words; null means the provider may run. `quiet`: the probe form. */
async function refusalOf(provider: SentinelProvider, quiet = false): Promise<string | null> {
  const gate = await import('../provider-launch-gate')
  return (quiet ? gate.providerProbeRefusal(provider) : gate.providerLaunchRefusal(provider))?.message ?? null
}

/** The accounts service, lazily (its graph is heavy); null before it is up. */
async function accountsService(): Promise<ReturnType<typeof import('../provider-accounts')['getAccountsService']>> {
  try {
    const { getAccountsService } = await import('../provider-accounts')
    return getAccountsService()
  } catch {
    return null
  }
}

/** The saved settings, or null when they cannot be read. */
async function savedSettings(): Promise<Record<string, unknown> | null> {
  try {
    const { readConfig } = await import('../config-manager')
    const s = readConfig<Record<string, unknown>>('settings')
    return s && typeof s === 'object' ? s : null
  } catch {
    return null
  }
}

/**
 * Home for Sentinel's headless spawns, resolved FRESH per run so a Settings
 * change applies to the next analysis. User-selected analysis account
 * (sentinelAccountProfileId) → captured primary → bare global (single-account
 * installs). Never bare-global when profiles exist: the frozen global login
 * hangs at auth / carries stale rate-limit state (live repro: both analysis
 * attempts timed out at 180s on 2026-06-12).
 */
async function analysisHome(): Promise<{ home: string | null; accountLabel: string | null }> {
  try {
    const { readConfig } = await import('../config-manager')
    const { resolveHeadlessProfileHome, listProfiles } = await import('../account-profiles')
    const settings = readConfig<{ sentinelAccountProfileId?: string | null }>('settings')
    const chosen = settings?.sentinelAccountProfileId ?? null
    const { home, profileId } = resolveHeadlessProfileHome(chosen)
    // Name the account the analysis actually ran under, so a failure message can
    // say WHICH account to change (#430). When the chosen account no longer
    // resolves and we fell back to another, say so — otherwise the user sees a
    // limit on an account they never picked and has no idea why.
    let accountLabel: string | null = null
    if (profileId) {
      // `|| null`, not `?? null`: a not-yet-signed-in profile has accountEmail
      // '' (account-profiles), and an empty string must fall back to the
      // profileId — otherwise the fallback label reads "; auto-picked …" with
      // no identifier, defeating the "which account to change" goal.
      const email = listProfiles().find((p) => p.id === profileId)?.accountEmail || null
      const fellBack = !!chosen && chosen !== profileId
      accountLabel = fellBack
        ? `${email ?? profileId}; auto-picked — your chosen analysis account is no longer available`
        : email ?? profileId
    }
    return { home, accountLabel }
  } catch {
    return { home: null, accountLabel: null } // fail-open: bare global is still better than no analysis
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

/**
 * The Codex half of the model coverage check (P3.8, row 39): the registry's
 * Codex models against the list the installed Codex CLI offers when it could
 * be read just now (P3.9), else the list shipped with this build. A throw is a
 * finding of its own, as the Claude half's is.
 */
function runCodexModelCoverageCheck(live: CodexLiveModelList | null): void {
  if (!state) return
  try {
    for (const f of codexModelCoverageFindings(getRegistry(), CODEX_EXPECTED_MODEL_SET, Date.now(), live)) {
      state.upsertFinding(f)
    }
  } catch (err) {
    const msg = (err as Error).message
    logInfo(`[sentinel] Codex model coverage check failed: ${msg}`)
    state.upsertFinding({
      id: 'models:codex-check-failed',
      kind: 'compat',
      severity: 'warn',
      title: 'The Codex model list could not be verified',
      evidence: `The Codex model-registry check did not complete: ${msg}`,
      badgeText: 'Codex model list unverified',
      provider: 'codex',
      status: 'open',
      createdAt: Date.now(),
    })
  }
}

/** The range the Codex package says its managed flows support, or null. */
async function codexSupportedVersions(): Promise<SupportedVersions | null> {
  try {
    const { tryGetProviderPackage } = await import('../providers/core')
    const r = tryGetProviderPackage('codex')?.setup?.supportedVersions
    return r && typeof r.minimum === 'string' && typeof r.maximumTested === 'string' ? { minimum: r.minimum, maximumTested: r.maximumTested } : null
  } catch {
    return null
  }
}

/** Said when the installed Codex could not be checked on a Re-run. */
export const CODEX_NOT_CHECKED = 'The installed Codex could not be checked, so its update was not analysed. Check it in Settings, Accounts, then use Re-run.'

/**
 * P3.9 (rows 39, 42): the Codex checks, while Codex is on. Its version, from
 * a fresh check of the installed CLI (the accounts service's discovery, a
 * `codex --version` in an empty folder, as Claude's check runs `claude
 * --version`), against the supported range; then the model registry against
 * the list that CLI offers, read from it (no sign-in, no network, in no
 * account's folder), else the shipped list. Counted as Codex in use from the
 * launch check to the end. Refused (and not logged when `probe`) while Codex
 * is off or not set up: then nothing about Codex runs or is said.
 */
async function runCodexChecks(opts: { probe: boolean }): Promise<{ refused: string } | { version: string | null }> {
  const begun = await beginRun('codex', opts)
  if ('refused' in begun) return begun
  try {
    const svc = await accountsService()
    let installation: ProviderInstallationView | null = null
    if (svc && typeof svc.discover === 'function') {
      try {
        const d = await svc.discover('codex')
        if (d && d.ok) installation = d.installation
      } catch { /* not checked: said below */ }
    }
    if (state) for (const f of codexVersionFindings(installation, await codexSupportedVersions(), Date.now())) state.upsertFinding(f)
    let live: CodexLiveModelList | null = null
    if (installation && installation.discoveryState === 'found' && svc && typeof svc.readModelCatalogue === 'function') {
      try {
        const r = await svc.readModelCatalogue('codex')
        if (r && r.ok && r.catalogue.ok) live = { version: r.catalogue.version, models: r.catalogue.models }
        else logInfo(`[sentinel] the installed Codex's model list was not read (${r && r.ok ? (r.catalogue.ok ? 'ok' : r.catalogue.code) : r?.code ?? 'no answer'}); the list shipped with this build is used`)
      } catch { /* the shipped list answers */ }
    }
    runCodexModelCoverageCheck(live)
    const version = installation && installation.discoveryState === 'found' && typeof installation.version === 'string' ? installation.version : null
    if (!version) logInfo('[sentinel] the installed Codex could not be checked; skipping its update analysis (fail-open)')
    return { version }
  } finally {
    begun.end()
  }
}

/** One provider's update: the version last analysed (or seen) and the one
 *  installed now. */
interface Update { provider: SentinelProvider; last: string; version: string }

/** What an analysis runs on: the runner, the account it runs as (for a
 *  failure message), and the end of its run. */
interface AnalysisRunner { run: HeadlessRunner; accountLabel: string | null; end: () => void }

/** Claude Code as the analysis runner: `claude -p` in the analysis account's
 *  home (unchanged), counted as Claude Code in use while it runs. */
async function claudeAnalysisRunner(signal: AbortSignal): Promise<AnalysisRunner | { refused: string }> {
  const begun = await beginRun('claude', { probe: false })
  if ('refused' in begun) return begun
  try {
    const { spawnClaudeHeadless } = await headlessRunner()
    const { home, accountLabel } = await analysisHome()
    return { run: (args, t, stdin) => spawnClaudeHeadless(args, t, stdin, home, signal), accountLabel, end: begun.end }
  } catch (err) {
    begun.end()
    throw err
  }
}

/** A Codex account's name for a message: its identity's name, else its
 *  provider label; made prose-safe. */
function codexAccountLabel(svc: NonNullable<Awaited<ReturnType<typeof accountsService>>>, accountId: string): string {
  try {
    const snap = svc.snapshot()
    const a = snap.accounts.find((x) => x.id === accountId)
    const name = snap.identities.find((i) => i.id === a?.identityId)?.friendlyName?.trim() || a?.providerLabel?.trim() || ''
    const safe = stripSpoofableText(name, 80).trim()
    return safe || 'your Codex account'
  } catch {
    return 'your Codex account'
  }
}

let sentinelLaunchSeq = 0

/** The folder a Codex analysis runs in: made fresh for the run under the temp
 *  folder, with this prefix, and removed after it. */
export const CODEX_ANALYSIS_DIR_PREFIX = 'ccc-sentinel-codex-'

/** A folder this module made for an analysis, and nothing else: its name
 *  carries the prefix and its parent is the temp folder. */
function isAnalysisFolder(dir: string): boolean {
  return path.basename(dir).startsWith(CODEX_ANALYSIS_DIR_PREFIX) && path.basename(dir).length > CODEX_ANALYSIS_DIR_PREFIX.length && path.dirname(dir) === path.resolve(os.tmpdir())
}

/**
 * Codex as the analysis runner (P3.9): one non-interactive `codex exec`,
 * exactly as a Codex review runs (the package's reviewer: `exec --json
 * --ephemeral --skip-git-repo-check --sandbox read-only`, the prompt on
 * stdin, never argv), from a launch the accounts service prepared (the
 * account leased, the executable setup proved, the account's own folder with
 * ambient credentials removed), in a fresh empty folder made for it (never a
 * project) and removed after. The account is the one chosen for Sentinel in
 * Settings, else the one Codex reviews run on, as Claude's analysis account
 * falls back to the primary; a fallback is said in the account's label.
 * Counted as Codex in use while it runs; the lease and the folder go once
 * the run, and any kill still under way, has ended.
 */
async function codexAnalysisRunner(signal: AbortSignal): Promise<AnalysisRunner | { refused: string }> {
  const begun = await beginRun('codex', { probe: false })
  if ('refused' in begun) return begun
  let handedOver = false
  try {
    const svc = await accountsService()
    const { tryGetProviderPackage } = await import('../providers/core')
    const review = tryGetProviderPackage('codex')?.review
    if (!svc || typeof svc.prepareLaunch !== 'function' || !review) {
      return { refused: 'Sentinel could not start its analysis on Codex: accounts are not ready yet. Use Re-run in a moment.' }
    }
    const saved = await savedSettings()
    const chosenRaw = saved?.sentinelCodexAccountId
    const chosen = typeof chosenRaw === 'string' && chosenRaw ? chosenRaw : null
    const prepare = (accountId: string | null) => svc.prepareLaunch({
      kind: 'review', providerId: 'codex', ownerId: `sentinel:${++sentinelLaunchSeq}`, remote: false,
      ...(accountId ? { providerAccountId: accountId } : {}),
    })
    let prepared = await prepare(chosen)
    let fellBack = false
    if (!prepared.ok && chosen) {
      fellBack = true
      prepared = await prepare(null)
    }
    if (!prepared.ok) return { refused: `Sentinel's analysis could not run on Codex: ${prepared.message}` }
    const launch = prepared
    let cwd: string
    try {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), CODEX_ANALYSIS_DIR_PREFIX))
    } catch {
      launch.lease.release()
      return { refused: "Sentinel's analysis could not run on Codex: no empty folder could be made for it." }
    }
    const name = codexAccountLabel(svc, launch.binding.providerAccountId)
    const accountLabel = fellBack ? `${name}; auto-picked, your chosen analysis account could not be used` : name
    const kills: Promise<void>[] = []
    handedOver = true
    return {
      accountLabel,
      run: async (_args, timeoutMs, stdin) => {
        const out = await review.run({ executable: launch.executable, env: launch.env, cwd, prompt: stdin ?? '', timeoutMs, signal })
        if (!out.ok && out.killSettled instanceof Promise) kills.push(out.killSettled)
        if (out.ok) return { code: 0, stdout: out.text, stderr: '' }
        if (out.code === 'timed-out') return { code: 1, stdout: '', stderr: `Timed out after ${Math.round(timeoutMs / 1000)}s` }
        // The reviewer's own message (already redacted), read as Claude's
        // error envelope is: a usage limit then stops the retry.
        return { code: 1, stdout: JSON.stringify({ is_error: true, result: out.message }), stderr: '' }
      },
      end: () => {
        const letGo = () => {
          try { launch.lease.release() } catch { /* a release never throws the analysis away */ }
          // Only the folder this run made: its own prefix, in the temp folder.
          try { if (isAnalysisFolder(cwd)) fs.rmSync(cwd, { recursive: true, force: true }) } catch { /* a leftover empty temp folder is harmless */ }
          begun.end()
        }
        if (kills.length) void Promise.all(kills).then(letGo, letGo)
        else letGo()
      },
    }
  } finally {
    if (!handedOver) begun.end()
  }
}

/** Each provider's analysis runner. */
const RUNNERS: Record<SentinelProvider, (signal: AbortSignal) => Promise<AnalysisRunner | { refused: string }>> = {
  claude: claudeAnalysisRunner, codex: codexAnalysisRunner,
}

/** The runner for an analysis: Claude Code or Codex, whichever is on; with
 *  both on, the one Ask Conductor runs on (OD27 M4). */
async function analysisRunner(signal: AbortSignal): Promise<AnalysisRunner | { refused: string }> {
  const claudeOff = await refusalOf('claude', true)
  const codexOff = await refusalOf('codex', true)
  const provider = sentinelAnalysisProvider(!claudeOff, !codexOff, await savedSettings())
  if (!provider) return { refused: claudeOff ?? codexOff ?? 'No assistant is on to run the analysis.' }
  return RUNNERS[provider](signal)
}

const CLAUDE_CHANGELOG_UNAVAILABLE = 'Changelog unavailable (offline?). Use Re-run in the Sentinel panel.'
const CODEX_NOTES_UNAVAILABLE = "Codex's release notes could not be read (offline?). Use Re-run in the Sentinel panel."

/** What an update's analysis reads and records, per provider: its changelog
 *  (Claude Code's) or release notes (Codex's), what is said when they cannot
 *  be read, and where the version analysed is kept. */
interface UpdateSubject {
  notes: () => Promise<string | null>
  unavailable: string
  recordSeen: (s: SentinelState, version: string) => void
}
const CLAUDE_UPDATE: UpdateSubject = { notes: () => fetchChangelog(), unavailable: CLAUDE_CHANGELOG_UNAVAILABLE, recordSeen: (s, v) => s.setLastSeenCcVersion(v) }
const CODEX_UPDATE: UpdateSubject = { notes: () => fetchCodexReleaseNotes(), unavailable: CODEX_NOTES_UNAVAILABLE, recordSeen: (s, v) => s.setLastSeenCodexVersion(v) }
const SUBJECTS: Record<SentinelProvider, UpdateSubject> = { claude: CLAUDE_UPDATE, codex: CODEX_UPDATE }

/** One update's analysis: its changelog (Claude Code's) or release notes
 *  (Codex's) between the last version and this one, checked against that
 *  provider's surfaces on the runner that is on. */
async function analyzeOne(u: Update, signal: AbortSignal): Promise<{ ok: true; findings: SentinelFinding[] } | { ok: false; error: string }> {
  const subject = SUBJECTS[u.provider]
  const md = await subject.notes()
  // Analysis-unavailable is the degraded state, shown as a calm note -- not a
  // finding. Findings are reserved for actual severe breaking changes now.
  if (!md) return { ok: false, error: subject.unavailable }
  if (signal.aborted) return { ok: false, error: '' }
  // The update's own provider, switched off while its notes were fetched, is
  // not analysed.
  const off = await refusalOf(u.provider)
  if (off) return { ok: false, error: off }
  const runner = await analysisRunner(signal)
  if ('refused' in runner) return { ok: false, error: runner.refused }
  try {
    return await runAnalysis({
      runner: runner.run,
      changelog: sliceChangelog(md, u.last, u.version),
      from: u.last, to: u.version, accountLabel: runner.accountLabel, subject: u.provider,
    })
  } finally {
    runner.end()
  }
}

/** Analyse each update in turn. A new run supersedes any in-flight one
 *  (kills its process tree) so a stale analysis can't finish late and
 *  clobber state or leave `analyzing` stuck. `carried`: problems met before
 *  the analysis (a provider that could not be checked), said with its own. */
async function analyzeUpdates(updates: Update[], carried: string[] = []): Promise<void> {
  if (!state || updates.length === 0) return
  currentAnalysis?.abort()
  const ac = new AbortController()
  currentAnalysis = ac
  const errors = [...carried]
  for (const u of updates) {
    if (ac.signal.aborted) break
    state.setAnalyzing(true, null, u.provider)
    const r = await analyzeOne(u, ac.signal)
    if (ac.signal.aborted) break                      // superseded / cancelled: drop the result
    if (r.ok) {
      for (const f of r.findings) state.upsertFinding(f)
      SUBJECTS[u.provider].recordSeen(state, u.version)
    } else if (r.error) {
      errors.push(r.error)
    }
  }
  if (currentAnalysis === ac) currentAnalysis = null
  if (ac.signal.aborted) return
  state.setAnalyzing(false, errors.length ? errors.join(' ') : null)
}

/** Trigger B startup check (spec §5). Non-blocking — call fire-and-forget from bootstrap. */
export async function sentinelStartupCheck(): Promise<void> {
  if (!state) return
  // Model-registry coverage (#385) runs FIRST and unconditionally: it does not
  // need a working `claude` binary, so it must not sit behind the --version
  // probe's fail-open return below. It reads the live article when the network
  // allows and falls back to the shipped snapshot when it does not (review S1).
  await runModelCoverageCheck()
  const updates: Update[] = []
  // P3.9: Codex's version and model list, while Codex is on (silently skipped
  // when it is not). Its first check is a baseline, as Claude Code's is.
  const codex = await runCodexChecks({ probe: true })
  if (!('refused' in codex) && codex.version && state) {
    const last = state.snapshot().lastSeenCodexVersion ?? null
    if (last === null) state.setLastSeenCodexVersion(codex.version)
    else if (last !== codex.version) updates.push({ provider: 'codex', last, version: codex.version })
  }
  let run: { end: () => void } | null = null
  try {
    // Claude Code switched off: nothing below runs for it, not even the
    // --version probe (no one asked for it, and a probe never runs for a
    // provider that is off). The coverage check above needs no CLI and has run.
    const begun = await beginRun('claude', { probe: true })
    if ('refused' in begun) {
      logInfo('[sentinel] Claude Code may not run now; skipping the version check')
    } else {
      run = begun
      const { spawnClaudeHeadless } = await headlessRunner()
      const res = await spawnClaudeHeadless(['--version'], 15000, undefined, (await analysisHome()).home)
      const version = res.code === 0 ? parseClaudeVersion(res.stdout) : null
      if (!version) {
        logInfo('[sentinel] claude --version unavailable; skipping (fail-open)')
      } else {
        for (const f of minVersionFindings(version, manifest)) state.upsertFinding(f)
        const last = state.snapshot().lastSeenCcVersion
        if (last === null) state.setLastSeenCcVersion(version)   // first run: baseline, no analysis
        else if (last !== version) updates.unshift({ provider: 'claude', last, version })
      }
    }
    await analyzeUpdates(updates)
  } catch (err) {
    state?.setAnalyzing(false, (err as Error).message)         // fail-open, always
  } finally {
    run?.end()
  }
}

/**
 * Manual Re-run from the panel: re-analyze to the CURRENT version even if already seen.
 * When last === version (typical re-run on an unchanged install), analyzeUpdates
 * calls sliceChangelog(md, version, version) which slices (v, v] = empty set → falls
 * back to the head-5 sections so the AI re-analyzes the most recent entries. Acceptable
 * UX: the user explicitly requested a fresh look.
 *
 * P3.9: each provider that is on is checked again and its update analysed;
 * one that is off is skipped without a word (a provider that is off shows
 * nothing). Only when neither may run does the panel say why, in Claude
 * Code's words as before.
 */
export async function sentinelRerun(): Promise<void> {
  if (!state) return
  let run: { end: () => void } | null = null
  try {
    const claudeOn = !(await refusalOf('claude', true))
    const codexOn = !(await refusalOf('codex', true))
    if (!claudeOn && !codexOn) {
      // Asked for by the user, and still refused while Claude Code is off: the
      // panel says why (WP2, provider-launch-gate.ts).
      state.setAnalyzing(false, await refusalOf('claude'))
      return
    }
    const updates: Update[] = []
    const problems: string[] = []
    if (claudeOn) {
      const begun = await beginRun('claude', { probe: false })
      if ('refused' in begun) {
        problems.push(begun.refused)
      } else {
        run = begun
        const { spawnClaudeHeadless } = await headlessRunner()
        const res = await spawnClaudeHeadless(['--version'], 15000, undefined, (await analysisHome()).home)
        const version = res.code === 0 ? parseClaudeVersion(res.stdout) : null
        if (!version) problems.push('claude --version unavailable')
        else updates.push({ provider: 'claude', last: state.snapshot().lastSeenCcVersion ?? version, version })
      }
    }
    if (codexOn) {
      const codex = await runCodexChecks({ probe: false })
      if ('refused' in codex) problems.push(codex.refused)
      else if (!codex.version) problems.push(CODEX_NOT_CHECKED)
      else updates.push({ provider: 'codex', last: state.snapshot().lastSeenCodexVersion ?? codex.version, version: codex.version })
    }
    if (updates.length === 0) { state.setAnalyzing(false, problems.join(' ') || null); return }
    await analyzeUpdates(updates, problems)
  } catch (err) {
    state?.setAnalyzing(false, (err as Error).message)
  } finally {
    run?.end()
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
