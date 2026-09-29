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
import * as path from 'path'
import { sweepStaleFolders } from '../stale-folder-sweep'
import { SentinelState } from './sentinel-state'
import { makeObserver, type Observation } from './sentinel-observe'
import { parseClaudeVersion, minVersionFindings, type ManifestEntry } from './sentinel-version'
import { fetchChangelog, sliceChangelog } from './sentinel-changelog'
import { fetchCodexReleaseNotes } from './sentinel-codex-changelog'
import { runAnalysis, CLAUDE_ANALYSIS_ENV, type HeadlessRunner } from './sentinel-analysis'
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

/** Sentinel's own folder in the resources folder (its state file's). */
let sentinelDir: string | null = null

export function initSentinel(resourcesDir: string): SentinelState {
  state = new SentinelState(resourcesDir)
  observer = makeObserver(state, getRegistry)
  sentinelDir = path.join(resourcesDir, 'sentinel')
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

/** Codex's id, as the accounts service names its provider. */
const CODEX_ID: SentinelProvider = 'codex'

/** What the accounts service last found of the installed Codex, or null. */
function codexInstallationNow(svc: Awaited<ReturnType<typeof accountsService>>): ProviderInstallationView | null {
  try {
    if (!svc || typeof svc.snapshot !== 'function') return null
    return svc.snapshot().providers.find((p) => p.providerId === CODEX_ID) ?? null
  } catch {
    return null
  }
}

/**
 * P3.9 (rows 39, 42): the Codex checks, while Codex is on. Its version
 * against the supported range, then the model registry against the list the
 * installed CLI offers, read from it (no sign-in, no network, in no account's
 * folder), else the shipped list. The version is the accounts service's
 * discovery (a `codex --version` in an empty folder): `fresh`, a new check,
 * as Claude's Re-run runs `claude --version` again; else (the start-up check,
 * round 1) the look the app already took at start, joined while it runs and
 * made only if none was (the model list read ensures it). Counted as Codex
 * in use from the launch check to the end of the read. Refused (and not
 * logged when `probe`) while Codex is off or not set up: then nothing about
 * Codex runs or is said.
 */
async function runCodexChecks(opts: { probe: boolean; fresh: boolean }): Promise<{ refused: string } | { version: string | null }> {
  const begun = await beginRun('codex', opts)
  if ('refused' in begun) return begun
  try {
    const svc = await accountsService()
    let installation: ProviderInstallationView | null = null
    if (opts.fresh && svc && typeof svc.discover === 'function') {
      try {
        const d = await svc.discover('codex')
        if (d && d.ok) installation = d.installation
      } catch { /* not checked: said below */ }
    }
    let live: CodexLiveModelList | null = null
    if (svc && typeof svc.readModelCatalogue === 'function') {
      try {
        // Runs nothing for a CLI not found or of a version the app cannot use.
        const r = await svc.readModelCatalogue('codex')
        if (r && r.ok && r.catalogue.ok) live = { version: r.catalogue.version, models: r.catalogue.models }
        else logInfo(`[sentinel] the installed Codex's model list was not read (${r && r.ok ? (r.catalogue.ok ? 'ok' : r.catalogue.code) : r?.code ?? 'no answer'}); the list shipped with this build is used`)
      } catch { /* the shipped list answers */ }
    }
    if (!installation) installation = codexInstallationNow(svc)
    if (state) for (const f of codexVersionFindings(installation, await codexSupportedVersions(), Date.now())) state.upsertFinding(f)
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
 *  home, counted as Claude Code in use while it runs. Round 2: in a fresh
 *  empty folder of its own in Sentinel's runs folder (never the app's own
 *  folder), with Claude Code's switches for the analysis
 *  (CLAUDE_ANALYSIS_ENV), the folder removed after. */
async function claudeAnalysisRunner(signal: AbortSignal): Promise<AnalysisRunner | { refused: string }> {
  const begun = await beginRun('claude', { probe: false })
  if ('refused' in begun) return begun
  let handedOver = false
  try {
    const { spawnClaudeHeadless } = await headlessRunner()
    const { home, accountLabel } = await analysisHome()
    const transportEnv = await analysisTransportEnv(home)
    const parent = analysisParent()
    let cwd: string
    try {
      if (!parent) throw new Error('no runs folder')
      cwd = makeAnalysisFolder(parent, CLAUDE_ANALYSIS_DIR_PREFIX, false)
    } catch {
      return { refused: "Sentinel's analysis could not run on Claude Code: no empty folder could be made for it." }
    }
    handedOver = true
    return {
      run: (args, t, stdin) => spawnClaudeHeadless(args, t, stdin, home, signal, { cwd, env: CLAUDE_ANALYSIS_ENV, transportEnv }),
      accountLabel,
      end: () => {
        // Only the folder this run made: its own prefix, in the runs folder.
        try { if (isAnalysisFolder(cwd, parent!, CLAUDE_ANALYSIS_DIR_PREFIX)) fs.rmSync(cwd, { recursive: true, force: true }) } catch { /* a leftover is swept by a later run */ }
        begun.end()
      },
    }
  } finally {
    if (!handedOver) begun.end()
  }
}

/** The largest settings file read for its transport variables (the CLI's own cap). */
const SETTINGS_READ_MAX_BYTES = 2 * 1024 * 1024

/** P3.9 round 3: the analysis loads no settings file, so the network
 *  settings its account's settings file sets (proxies, certificates: only
 *  what the Claude package classifies as transport and keeps) are handed to
 *  it as variables. The account's own settings file: its profile home's, or
 *  the shared Claude folder for the default account. None when there is no
 *  such file, it is too large, or the package cannot say. Never throws. */
async function analysisTransportEnv(home: string | null): Promise<Readonly<Record<string, string>>> {
  try {
    const { tryGetProviderPackage } = await import('../providers/core')
    const pick = tryGetProviderPackage('claude')?.managedLaunch?.transportSettingsEnv
    if (typeof pick !== 'function') return {}
    const { sharedRoot } = await import('../account-profiles')
    const dir = home ? path.join(home, '.claude') : sharedRoot()
    const file = path.join(dir, 'settings.json')
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > SETTINGS_READ_MAX_BYTES) return {}
    return pick(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
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

/** The folder a Codex analysis runs in: made fresh for the run, with this
 *  prefix, in Sentinel's own runs folder, and removed after it. */
export const CODEX_ANALYSIS_DIR_PREFIX = 'ccc-sentinel-codex-'
/** The folder a Claude Code analysis runs in (round 2), likewise. */
export const CLAUDE_ANALYSIS_DIR_PREFIX = 'ccc-sentinel-claude-'
/** Sentinel's runs folder, inside its own folder in the resources folder. */
export const SENTINEL_RUNS_DIRNAME = 'runs'
/** An analysis folder older than this is a leftover (a crash or a quit
 *  mid-run; the longest run ends well inside it). */
export const STALE_ANALYSIS_FOLDER_MS = 60 * 60 * 1000

/** P3.9 round 1: the parent of every analysis folder, the app's own and this
 *  user's: Sentinel's folder in the resources folder, its `runs` folder made
 *  there, each a real folder (never a link) and, on POSIX, this user's, not a
 *  shared temp folder another user can write into. Null when it cannot be. */
function analysisParent(): string | null {
  if (!sentinelDir) return null
  const parent = path.join(sentinelDir, SENTINEL_RUNS_DIRNAME)
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    for (const dir of [sentinelDir, parent]) {
      const st = fs.lstatSync(dir)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null
    }
    return parent
  } catch {
    return null
  }
}

/** A folder this module made for an analysis, and nothing else: its name
 *  carries the prefix and its parent is Sentinel's runs folder. */
function isAnalysisFolder(dir: string, parent: string, prefix: string = CODEX_ANALYSIS_DIR_PREFIX): boolean {
  return path.basename(dir).startsWith(prefix) && path.basename(dir).length > prefix.length && path.dirname(dir) === path.resolve(parent)
}

/** Real paths compared as the platform does (Windows: case-insensitive). */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** A fresh, empty analysis folder. Leftovers of earlier runs go first.
 *  Round 2: once made, its real path must be `<resources>/sentinel/runs/<it>`
 *  under the resources folder's own real path, so neither `sentinel` nor
 *  `runs` became a link between the check and the make; one that did is
 *  removed (it is empty) and refused. `marker` (Codex): an empty `.git`
 *  file makes the folder a project root of its own (a Codex project root;
 *  git's own search, which an empty `.git` file ends at once with an
 *  error). */
function makeAnalysisFolder(parent: string, prefix: string = CODEX_ANALYSIS_DIR_PREFIX, marker = true): string {
  sweepStaleFolders(parent, prefix, { maxAgeMs: STALE_ANALYSIS_FOLDER_MS })
  const dir = fs.mkdtempSync(path.join(parent, prefix))
  let where: string | null = null
  try {
    const expected = path.join(fs.realpathSync.native(path.dirname(sentinelDir!)), path.basename(sentinelDir!), SENTINEL_RUNS_DIRNAME, path.basename(dir))
    where = samePath(fs.realpathSync.native(dir), expected) ? dir : null
  } catch { where = null }
  if (!where) {
    try { fs.rmdirSync(dir) } catch { /* not empty, or gone: leave it */ }
    throw new Error('the runs folder is not where it was')
  }
  if (marker) fs.writeFileSync(path.join(dir, '.git'), '', { flag: 'wx' })
  return dir
}

/**
 * Codex as the analysis runner (P3.9): one non-interactive `codex exec`
 * through the package's reviewer, as its text-only analysis (round 1: no
 * tools, no user config, web search off, no project instructions, the
 * working folder its own project root; cli-runner.ts, `analysis`), the
 * prompt on stdin, never argv, from a launch the accounts service prepared
 * (the account leased, the executable setup proved, the account's own folder
 * with ambient credentials removed), in a fresh empty folder made for it in
 * Sentinel's own runs folder (never a project) and removed after. The
 * account is the one chosen for Sentinel in Settings, else the one Codex
 * reviews run on, as Claude's analysis account falls back to the primary;
 * a fallback is said in the account's label.
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
    const parent = analysisParent()
    let cwd: string
    try {
      if (!parent) throw new Error('no runs folder')
      cwd = makeAnalysisFolder(parent)
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
        // A text-only run (round 1): no tools, no instructions from any folder.
        // Round 2: any git the CLI runs there stops at the runs folder, never
        // prompts, and takes no optional lock.
        const env = { ...launch.env, GIT_CEILING_DIRECTORIES: parent!, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
        const out = await review.run({ executable: launch.executable, env, cwd, prompt: stdin ?? '', timeoutMs, signal, purpose: 'analysis' })
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
          // Only the folder this run made: its own prefix, in the runs folder.
          try { if (isAnalysisFolder(cwd, parent!)) fs.rmSync(cwd, { recursive: true, force: true }) } catch { /* a leftover is swept by a later run */ }
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
const CODEX_NOTES_UNAVAILABLE = "Codex's release notes could not be read from GitHub. Use Re-run in the Sentinel panel."

/** The notes an update's analysis reads, and what is said when not all of
 *  them could be read in full. */
interface UpdateNotes { text: string; cut: string | null }

/** What an update's analysis reads and records, per provider: its changelog
 *  (Claude Code's, the versions after the last one seen) or release notes
 *  (Codex's, read version by version; round 1), what is said when they
 *  cannot be read, and where the version analysed is kept. */
interface UpdateSubject {
  notes: (u: Update) => Promise<UpdateNotes | null>
  unavailable: string
  recordSeen: (s: SentinelState, version: string) => void
  /** Round 3: the assistant's name and its notes' name, for what is said. */
  name: string
  notesName: string
}
const CLAUDE_UPDATE: UpdateSubject = {
  notes: async (u) => {
    const md = await fetchChangelog()
    return md ? { text: sliceChangelog(md, u.last, u.version), cut: null } : null
  },
  unavailable: CLAUDE_CHANGELOG_UNAVAILABLE,
  recordSeen: (s, v) => s.setLastSeenCcVersion(v),
  name: 'Claude Code',
  notesName: 'changelog',
}
const CODEX_UPDATE: UpdateSubject = {
  notes: async (u) => {
    const n = await fetchCodexReleaseNotes(u.last, u.version)
    return n ? { text: n.text, cut: n.cut } : null
  },
  unavailable: CODEX_NOTES_UNAVAILABLE,
  recordSeen: (s, v) => s.setLastSeenCodexVersion(v),
  name: 'Codex',
  notesName: 'release notes',
}
const SUBJECTS: Record<SentinelProvider, UpdateSubject> = { claude: CLAUDE_UPDATE, codex: CODEX_UPDATE }

/** One update's analysis: its changelog (Claude Code's) or release notes
 *  (Codex's) between the last version and this one, checked against that
 *  provider's surfaces on the runner that is on. */
async function analyzeOne(u: Update, signal: AbortSignal): Promise<{ ok: true; findings: SentinelFinding[]; unverified: number; note: string | null } | { ok: false; error: string; note?: string | null }> {
  const subject = SUBJECTS[u.provider]
  const notes = await subject.notes(u)
  // Analysis-unavailable is the degraded state, shown as a calm note -- not a
  // finding. Findings are reserved for actual severe breaking changes now.
  if (!notes) return { ok: false, error: subject.unavailable }
  if (signal.aborted) return { ok: false, error: '' }
  // The update's own provider, switched off while its notes were fetched, is
  // not analysed.
  const off = await refusalOf(u.provider)
  if (off) return { ok: false, error: off }
  const runner = await analysisRunner(signal)
  if ('refused' in runner) return { ok: false, error: runner.refused }
  try {
    const r = await runAnalysis({
      runner: runner.run,
      changelog: notes.text,
      from: u.last, to: u.version, accountLabel: runner.accountLabel, subject: u.provider,
    })
    // Round 2: what was cut is said whether or not the analysis completed.
    return { ...r, note: notes.cut }
  } finally {
    runner.end()
  }
}

/** Said when some of an analysis's findings could not be matched to the
 *  notes it was sent (round 3). */
export function unverifiedMessage(u: Update, count: number): string {
  const subject = SUBJECTS[u.provider]
  const what = count === 1 ? 'One finding' : `${count} findings`
  return `${what} from the analysis of ${subject.name} ${u.version} could not be matched to its ${subject.notesName}, so ${count === 1 ? 'it is' : 'they are'} not shown and the update will be analysed again at the next check.`
}

/** How many analyses of one update may find nothing they can match before
 *  the update is recorded as checked anyway (round 4). */
export const UNVERIFIED_MAX_TRIES = 3

/** Said when an update is recorded as checked after UNVERIFIED_MAX_TRIES
 *  analyses whose findings could not all be matched (round 4). */
export function unverifiedRecordedMessage(u: Update, count: number, tries: number): string {
  const subject = SUBJECTS[u.provider]
  const what = count === 1 ? 'One finding' : `${count} findings`
  return `${what} from the analysis of ${subject.name} ${u.version} could not be matched to its ${subject.notesName} after ${tries} analyses, so ${count === 1 ? 'it is' : 'they are'} not shown and the update is recorded as checked.`
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
  const notes: string[] = []
  for (const u of updates) {
    if (ac.signal.aborted) break
    state.setAnalyzing(true, null, u.provider)
    const r = await analyzeOne(u, ac.signal)
    if (ac.signal.aborted) break                      // superseded / cancelled: drop the result
    if (r.note) notes.push(r.note)
    if (r.ok) {
      for (const f of r.findings) state.upsertFinding(f)
      // Round 3: findings that could not be matched to the notes are not
      // shown, so the update is not checked yet: it is analysed again at the
      // next check, and the panel says why (never "no breaking changes").
      // Round 4: at most UNVERIFIED_MAX_TRIES times, so a start never runs an
      // analysis on the account for the same update forever: then the
      // version is recorded as checked, with a note that says so.
      const key = `${u.provider}:${u.version}`
      if (r.unverified > 0) {
        const tries = state.countUnverified(key)
        if (tries >= UNVERIFIED_MAX_TRIES) {
          SUBJECTS[u.provider].recordSeen(state, u.version)
          state.clearUnverified(key)
          notes.push(unverifiedRecordedMessage(u, r.unverified, tries))
        } else {
          errors.push(unverifiedMessage(u, r.unverified))
        }
      } else {
        SUBJECTS[u.provider].recordSeen(state, u.version)
        state.clearUnverified(key)
      }
    } else if (r.error) {
      errors.push(r.error)
    }
  }
  if (currentAnalysis === ac) currentAnalysis = null
  if (ac.signal.aborted) return
  state.setAnalyzing(false, errors.length ? errors.join(' ') : null, null, notes.length ? notes.join(' ') : null)
}

/** Trigger B startup check (spec §5). Non-blocking — call fire-and-forget from bootstrap. */
export async function sentinelStartupCheck(): Promise<void> {
  if (!state) return
  // Model-registry coverage (#385) runs FIRST and unconditionally: it does not
  // need a working `claude` binary, so it must not sit behind the --version
  // probe's fail-open return below. It reads the live article when the network
  // allows and falls back to the shipped snapshot when it does not (review S1).
  await runModelCoverageCheck()
  let run: { end: () => void } | null = null
  try {
    // P3.9: the two providers' checks run side by side. Nothing the Codex
    // half meets stops Claude Code's (its own failures end in the log,
    // fail-open), and (round 2) a Claude Code check that fails is said
    // while a Codex update is still analysed.
    const [codexSettled, claudeSettled] = await Promise.allSettled([codexUpdateAtStart(), claudeUpdateAtStart()])
    const codexUpdate = codexSettled.status === 'fulfilled' ? codexSettled.value : null
    const carried: string[] = []
    let claudeUpdate: Update | null = null
    if (claudeSettled.status === 'fulfilled') {
      run = claudeSettled.value.run
      claudeUpdate = claudeSettled.value.update
    } else {
      carried.push(String((claudeSettled.reason as Error)?.message ?? claudeSettled.reason))
    }
    const updates = [claudeUpdate, codexUpdate].filter((u): u is Update => u !== null)
    if (updates.length) await analyzeUpdates(updates, carried)
    else if (carried.length) state.setAnalyzing(false, carried.join(' '))
  } catch (err) {
    state?.setAnalyzing(false, (err as Error).message)         // fail-open, always
  } finally {
    run?.end()
  }
}

/** P3.9: Codex's version and model list at start, while Codex is on
 *  (silently skipped when it is not), and its update when its version
 *  changed. The first check is a baseline, as Claude Code's is. Never throws. */
async function codexUpdateAtStart(): Promise<Update | null> {
  try {
    const codex = await runCodexChecks({ probe: true, fresh: false })
    if ('refused' in codex || !codex.version || !state) return null
    const last = state.snapshot().lastSeenCodexVersion ?? null
    if (last === null) { state.setLastSeenCodexVersion(codex.version); return null }
    return last !== codex.version ? { provider: 'codex', last, version: codex.version } : null
  } catch (err) {
    logInfo(`[sentinel] the Codex check at start failed: ${(err as Error)?.message ?? err}`)
    return null
  }
}

/** Claude Code's version check at start and its update when its version
 *  changed. The run it starts stays counted as Claude Code in use until the
 *  caller ends it (after the analysis). Claude Code switched off: nothing
 *  runs for it, not even the --version probe (no one asked for it, and a
 *  probe never runs for a provider that is off). */
async function claudeUpdateAtStart(): Promise<{ update: Update | null; run: { end: () => void } | null }> {
  const begun = await beginRun('claude', { probe: true })
  if ('refused' in begun) {
    logInfo('[sentinel] Claude Code may not run now; skipping the version check')
    return { update: null, run: null }
  }
  try {
    const { spawnClaudeHeadless } = await headlessRunner()
    const res = await spawnClaudeHeadless(['--version'], 15000, undefined, (await analysisHome()).home)
    const version = res.code === 0 ? parseClaudeVersion(res.stdout) : null
    if (!version || !state) {
      logInfo('[sentinel] claude --version unavailable; skipping (fail-open)')
      return { update: null, run: begun }
    }
    for (const f of minVersionFindings(version, manifest)) state.upsertFinding(f)
    const last = state.snapshot().lastSeenCcVersion
    if (last === null) { state.setLastSeenCcVersion(version); return { update: null, run: begun } }   // first run: baseline, no analysis
    return { update: last !== version ? { provider: 'claude', last, version } : null, run: begun }
  } catch (err) {
    begun.end()
    throw err
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
      const codex = await runCodexChecks({ probe: false, fresh: true })
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
