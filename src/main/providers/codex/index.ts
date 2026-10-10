// Codex provider package: public entry point (WP1, design 7.1). Everything
// outside this directory imports from here; the dependency-boundary test
// holds the deep imports at zero.
import type { SessionProvider, SessionRunScreen, SpawnOptions, TelemetrySource, HistorySession, ProviderSpawnCommand, TelemetryOptions } from '../types'
import type { LegacyVersion, StatuslineData } from '../../../shared/types'
import type { AllowanceReading } from '../../../shared/usage-types'
import type { ProviderCapabilities, AuthRealm, RealmUse } from '../../../shared/providers'
import type { ProviderPackage, ProviderPricingOperations, RealmRef } from '../core'
import { CODEX_ENABLEMENT } from './enablement'
import { resolveCodexBinary, buildCodexSpawn, codexHookDataDir } from './spawn'
import { openCodexScreen, feedCodexScreen, resizeCodexScreen, closeCodexScreen, hasCodexScreen, submitCodexText } from './session-screen'
import { detectCodexUi } from './ui-detection'
import { watchAndClaimRollout } from './telemetry'
import { deployCodexResumePickerScript } from './resume-picker'
import { deployCodexHookScripts, writeCodexHookFile, removeCodexHookFile, prepareCodexHookFolders, preparedCodexHookRoot, codexPlainWrapperDir, codexLocalAppData, codexHookCommand } from './hooks'
import type { SecureHookFolders } from './hooks'
import { CODEX_PINNED_CLI_VERSION, CODEX_MIN_SUPPORTED_VERSION, CODEX_MAX_TESTED_VERSION } from './cli-contract'
import { codexInstallRecipes } from './install-recipes'
import { codexOperationBaseEnv } from './process-env'
import { runCodexCli, defaultCodexRunDeps } from './cli-runner'
import { codexCliEnv } from './cli-env'
import { warmFirstStart } from '../../first-start-warmup'
import { discoverCodex } from './discovery'
import type { CodexDiscovery, CodexDiscoveryDeps } from './discovery'
import { readCodexModelCatalogue } from './model-catalogue'
import type { CodexCatalogueDeps } from './model-catalogue'
import { createCodexAuthOperations } from './auth-operations'
import { createCodexReviewOperations } from './review'
import { createCodexBackgroundOperations } from './agent-run'
import { createCodexInsightsOperations } from './insights-exec'
import type { CodexAuthDeps, CodexAuthOperations } from './auth-operations'
import { createCodexRealmFolders, createCodexRealmLocks, resolveCodexRealmRoots } from './realm-folders'
import { carryCodexRollout } from './conversation-carry'
import type { CodexConversationCarry } from './conversation-carry'
import { codexExternalDefaultHome, codexHomeDisplay, codexManagedRealmSkillsDir } from './realm-paths'
import { createCodexLiveUsage, createCodexUsageOperations, createCodexCarryMarks, codexRolloutIdFromName, newestCarriedStamp, realCodexUsageFsPort } from './usage'
import type { CodexLiveUsage, CodexUsageFsPort, CodexCarryMarks, CodexCarryMarksPort } from './usage'
import type { CodexFolderLookup, CodexFsEntry, CodexRealmFsPort, CodexRealmFolderDeps, CodexRealmFolderLimits } from './realm-folders'
import { removeConductorVisionFromCodexConfig } from './mcp-config'
import {
  codexPricingKeys, priceForModel, codexCachedInputPer1M,
  parseLiteLlmOpenAiPricing, parseCachedCodexPricing, serializeCodexPricing, setLiveCodexPricing,
} from './pricing'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepStaleFolders } from '../../stale-folder-sweep'
import { secureOwnerOnlyFolders } from '../../owner-only-folders'
import { logWarn } from '../../debug-logger'

// WP2 Codex adapter: the CLI contract, install recipes, the allowlisted
// subprocess environment, realm paths, the CLI runner and discovery.
export {
  codexCommandLine, cliCommandLine, codexShellEnv, runCodexCli, defaultCodexRunDeps, makeCodexKillTree, makeCodexProcessLister,
  codexChainPids, codexLeftoverPids, codexRecordRunMembers, codexRunMemberAlive, codexChainAlone, CODEX_OBSERVE_MAX_READS, CODEX_OBSERVE_MAX_IN_FLIGHT, CODEX_OBSERVE_QUIET_READS, CODEX_OBSERVE_AT_MS, parseWindowsProcessTable, parsePosixProcessTable, parseLinuxStat, WINDOWS_PROCESS_QUERY,
  CODEX_KILL_SETTLE_MS, CODEX_PROCESS_TABLE_TIMEOUT_MS, CODEX_TASKKILL_TIMEOUT_MS, CODEX_TREE_PRIME_MS, CODEX_PRIME_TABLE_TIMEOUT_MS, codexWrapperLinePids, CODEX_KILL_WORST_MS, flushPendingCodexKills,
} from './cli-runner'
export type { CodexCliOperation, CodexCommand, CodexRunResult, CodexRunOptions, CodexRunDeps, CodexProcessEntry, CodexKillTree, CodexKillScope, CodexObserveReason, CodexRunWindow, CodexRunMember, CodexStdinWriter } from './cli-runner'
export { discoverCodex, verifyCodexExecutable, codexCompatibilityAllowsUse } from './discovery'
// P3.9 (row 39): the installed CLI's own model list, for Sentinel.
export {
  readCodexModelCatalogue, parseCodexModelCatalogue, CODEX_CATALOGUE_TIMEOUT_MS, CODEX_CATALOGUE_MAX_CHARS, CODEX_CATALOGUE_MAX_MODELS, CODEX_CATALOGUE_LABEL_MAX,
} from './model-catalogue'
export type { CodexCatalogueDeps } from './model-catalogue'
export { createCodexReviewOperations, createCodexExecEventReader, parseCodexExecEvents, REVIEW_MAX_TEXT, CODEX_EXEC_EXIT_SETTLE_MS } from './review'
export type { CodexExecEventHooks } from './review'
// WP2 PR 4, P4.5 (row 57): a Cloud Agent's headless run.
export {
  createCodexBackgroundOperations, codexAgentArgs, codexAgentCommandLine, codexAgentSandbox, CODEX_AGENT_EFFORTS, CODEX_AGENT_TIMEOUT_MS,
} from './agent-run'
export type { CodexAgentSandbox } from './agent-run'
// WP2 PR 4, P4.7 (row 68): an Insights report's model run.
export { createCodexInsightsOperations, CODEX_INSIGHTS_TIMEOUT_MS } from './insights-exec'
export type { CodexDiscovery, CodexDiscoveryDeps, CodexExecutableIdentity, CodexExecutableCheck, CodexFileStat } from './discovery'
export { codexLoginShellPath, codexOperationBaseEnv, extractMarkedPath, absolutePathEntries } from './process-env'
export {
  CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION, CODEX_MAX_TESTED_VERSION,
  parseCodexVersion, classifyCodexVersion, parseCodexLoginStatus,
} from './cli-contract'
export type { CodexLoginStatus, CodexLoginVia } from './cli-contract'
export { codexInstallRecipes, codexInstallKind, CODEX_INSTALL_SOURCE_URL, CODEX_README_COMMIT } from './install-recipes'
export type { CodexInstallKind } from './install-recipes'
export { createCodexAuthOperations, createCodexOutputRedactor } from './auth-operations'
export type { CodexAuthDeps, CodexRealmLookup, CodexRealmIdentity, CodexOutputRedactor, CodexUsageRead, CodexUsageReadOptions } from './auth-operations'
// Usage track MP7 (ADR-022): the app-server usage read's client.
export {
  createAppServerUsageClient, appServerMessages, APP_SERVER_MAX_LINE, APP_SERVER_READ_DEADLINE_MS, APP_SERVER_INITIALIZE_TIMEOUT_MS, APP_SERVER_EXIT_GRACE_MS, APP_SERVER_CLIENT_NAME,
} from './app-server-client'
export type { AppServerVerdict, AppServerFailure, AppServerClientDeps, AppServerUsageClient } from './app-server-client'
export { codexCliEnv, codexCliEnvAllowlist } from './cli-env'
export {
  codexRealmHome, codexExternalDefaultHome, codexExternalHomeCandidate, codexManagedRealmsRoot, codexHomesOverlap, isFullyQualifiedPath, codexHomeDisplay, CODEX_REALMS_DIRNAME,
  codexManagedRealmSkillsDir,
} from './realm-paths'
export type { CodexRealmRoots, CodexRealmHome, CodexExternalCandidate } from './realm-paths'
export {
  createCodexRealmFolders, createCodexRealmLocks, codexRealmLockKey, resolveCodexRealmRoots, CODEX_REMOVE_MAX_DEPTH, CODEX_REMOVE_MAX_ENTRIES, CODEX_UNDER_LOCK_LOOKUP_MS, CODEX_CARRY_LOCK_WAIT_MS,
  CODEX_HISTORY_MAX_ENTRIES, CODEX_FOLDER_BATCH,
} from './realm-folders'
export type { CodexRealmFsPort, CodexRealmFsAsync, CodexFsEntry, CodexRealmLocks, CodexFolderLookup, CodexRealmFolderDeps, CodexRealmFolderLimits, CodexRootsResult } from './realm-folders'
// P3.10: Codex's hooks, delivered to the Hooks gateway.
export {
  writeCodexHookFile, removeCodexHookFile, sweepStaleCodexHookFolders, codexHookCommand, codexHookConfigArgs, deployCodexHookScripts,
  prepareCodexHookFolders, preparedCodexHookRoot, codexPlainWrapperDir, verifyPlainCodexHookWrapper,
  CODEX_HOOK_EVENTS, CODEX_HOOK_CLIENT_HEADER, CODEX_HOOK_CLIENT, CODEX_HOOK_FILE_ENV, CODEX_HOOK_DIR_PREFIX, CODEX_HOOK_STALE_MS, CODEX_HOOK_ROOT_NAME, CODEX_HOOK_PLAIN_BASE,
} from './hooks'
export type { CodexHookFile, CodexHookEvent, SecureHookFolders, CodexHookFolderPlan, CodexHookFolderOutcome } from './hooks'
// P3.6: a switched session's conversation carried into the new account's folder.
export { carryCodexRollout, CODEX_CARRY_MAX_BYTES, CODEX_CARRY_STALE_TEMP_MS } from './conversation-carry'
export type { CodexConversationCarry, CodexCarryInput, CodexCarryResult, CodexCarryCode } from './conversation-carry'
// Usage track MP2/MP3: the allowance reading and the usage port.
export { normaliseCodexRateLimits, mergeAllowanceReadings, readingToBuckets, CODEX_DEFAULT_LIMIT_ID } from './rate-limits'
export {
  readLastSeenAllowance, lookupLastSeenAllowance, createCodexLiveUsage, createCodexUsageOperations, realCodexUsageFsPort,
  createCodexCarryMarks, codexRolloutIdFromName, newestCarriedStamp, newestStampInTail, CODEX_CARRY_MARKS_MAX, CODEX_CARRY_MARKS_FILE_MAX_CHARS,
  CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES, CODEX_USAGE_MAX_FILES, CODEX_USAGE_MAX_DAYS, CODEX_USAGE_WALK_BUDGET, CODEX_USAGE_DAY_ENTRIES, CODEX_USAGE_READ_TIMEOUT_MS,
} from './usage'
export type { CodexUsageFsPort, CodexUsageEntry, CodexUsageFsApi, CodexLiveUsage, CodexUsageDeps, LastSeenCache, LastSeenLookup, CodexCarryMarks, CodexCarryMarksPort } from './usage'

/** Why the two session-contract methods a Codex launch never uses refuse: a
 *  Codex session runs only the executable its managed launch proved (the
 *  accounts service's prepared launch), never one looked up on PATH here. */
const CODEX_MANAGED_LAUNCH_ONLY = 'not used for Codex: launches go through the managed launch'

/** WP2 PR 4, P4.1: main's pane of each Codex run and the submit primitive
 *  (session-screen.ts drives composer-submit.ts), offered through the
 *  registered provider: the PTY manager reaches this package only that way. */
const CODEX_RUN_SCREEN: SessionRunScreen = {
  open: (sessionId, opts) => openCodexScreen(sessionId, opts),
  feed: (sessionId, data) => feedCodexScreen(sessionId, data),
  resize: (sessionId, cols, rows) => resizeCodexScreen(sessionId, cols, rows),
  close: (sessionId) => closeCodexScreen(sessionId),
  has: (sessionId) => hasCodexScreen(sessionId),
  submit: (sessionId, text, opts) => submitCodexText(sessionId, text, opts),
}

/** WP2 PR 4: Codex's model prices (pricing.ts), offered to Tokenomics through
 *  the registered package rather than by deep import. */
const CODEX_PRICING: ProviderPricingOperations = {
  keys: () => codexPricingKeys(),
  price: (model) => priceForModel(model),
  cachedInputPer1M: (p) => codexCachedInputPer1M(p),
  parseList: (all) => parseLiteLlmOpenAiPricing(all),
  parseSaved: (saved) => parseCachedCodexPricing(saved),
  serialize: (map) => serializeCodexPricing(map),
  setLive: (map) => setLiveCodexPricing(map),
}

export class CodexProvider implements SessionProvider {
  readonly id = 'codex' as const
  readonly displayName = 'Codex'

  /** `liveUsage` (usage track MP3): where each session's allowance is
   *  recorded, by its realm's sessions folder, for the Account usage page. */
  constructor(private readonly liveUsage?: CodexLiveUsage, private readonly carryMarks?: CodexCarryMarks) {}

  /** Required by the session contract; refuses (CODEX_MANAGED_LAUNCH_ONLY). */
  resolveBinary(_legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null {
    throw new Error(`resolveBinary is ${CODEX_MANAGED_LAUNCH_ONLY}`)
  }

  buildSpawnCommand(opts: SpawnOptions): ProviderSpawnCommand {
    return buildCodexSpawn(opts)
  }

  /** WP2 PR 4, P4.1: a managed account's own skills folder, by the managed
   *  home's path rule (realm-paths.ts); null for this computer's own sign-in. */
  stagedSkillsDir(home: string, resourcesDir: string): string | null {
    return codexManagedRealmSkillsDir(home, resourcesDir)
  }

  readonly runScreen: SessionRunScreen = CODEX_RUN_SCREEN

  detectUiRunning(data: string): boolean {
    return detectCodexUi(data)
  }

  ingestSessionTelemetry(
    sessionId: string,
    opts: TelemetryOptions,
    onUpdate: (data: StatuslineData) => void,
  ): TelemetrySource {
    // Only the session's own realm (WP2): with none there is nothing to watch,
    // and the ambient home would claim another account's transcript.
    if (!opts.sessionsDir) return { stop() {} }
    const sessionsDir = opts.sessionsDir
    const live = this.liveUsage
    // P3.5: how the watcher finds a resumed conversation, and who hears which
    // conversation it claimed.
    const onAllowance = live ? (reading: AllowanceReading) => live.record(sessionsDir, reading) : undefined
    // ADR-023: a conversation carried into this realm counts only from the carry on.
    const marks = this.carryMarks
    const allowanceAfter = marks ? (rolloutPath: string): number | null => marks.cutoff(sessionsDir, codexRolloutIdFromName(rolloutPath)) : undefined
    const watch = opts.resumeId || opts.pickFile || opts.onClaim || opts.onRelease || opts.onShared || opts.onRollout || allowanceAfter
      ? watchAndClaimRollout(sessionId, opts.cwd, opts.spawnTimestamp, onUpdate, sessionsDir, onAllowance, { resumeId: opts.resumeId, resumePath: opts.resumePath, pickFile: opts.pickFile, pickFolder: opts.pickFolder, onClaim: opts.onClaim, onRelease: opts.onRelease, onShared: opts.onShared, onRollout: opts.onRollout, ...(allowanceAfter ? { allowanceAfter } : {}) })
      : watchAndClaimRollout(sessionId, opts.cwd, opts.spawnTimestamp, onUpdate, sessionsDir, onAllowance)
    if (!live) return watch
    // The realm's live figure lasts while one of its sessions still reports.
    const release = live.open(sessionsDir)
    return {
      stop() { try { watch.stop() } finally { release() } },
      // P3.10: the exact claim from the session's own hook, and another
      // session's proof that an inferred claim here is not this one's.
      noteExactRollout: (rolloutPath: string) => watch.noteExactRollout?.(rolloutPath) ?? null,
      refuteInferredClaim: (rolloutPath: string) => watch.refuteInferredClaim?.(rolloutPath) ?? false,
      recheckShared: () => watch.recheckShared?.() ?? false,
    }
  }

  async listHistorySessions(): Promise<HistorySession[]> {
    // P4 implements resume picker
    return []
  }

  /** Required by the session contract; refuses. A Codex resume is the resume
   *  picker, which runs the executable the launch proved. */
  resumeCommand(_sessionId: string): { cmd: string; args: string[] } {
    throw new Error(`resumeCommand is ${CODEX_MANAGED_LAUNCH_ONLY}`)
  }

  async configureMcpServer(_cfg: { name: string; url: string }): Promise<void> {
    // No-op: a Codex session is handed the conductor MCP server per spawn
    // (buildCodexSpawn), never through a config file.
  }

  /** The conductor block an older build wrote into the user's own
   *  config.toml, removed (mcp-config.ts); the MCP server asks at start and
   *  stop. */
  removeLegacyMcpServerConfig(): void {
    removeConductorVisionFromCodexConfig()
  }

  async deployResumePickerScript(resourcesDir: string): Promise<void> {
    await deployCodexResumePickerScript(resourcesDir)
    // P3.10: the hook forwarder (and its Windows wrapper) beside the picker.
    // Round 4 (P1): copies only; the hook folders are prepared apart
    // (prepareHookFolders), asynchronously and only while Codex is on.
    await deployCodexHookScripts(resourcesDir)
  }

  /** P3.10 round 4 (P1, P2): prepare this run's hook folders, asynchronously
   *  (hooks.ts prepareCodexHookFolders): the hook root in the app's own data
   *  folder (round 1, A5) and, on Windows when the wrapper's path in the
   *  resources folder is not a plain word, its plain-path copy for the npm
   *  shim route (round 1, V3), made this user's and owner-only by
   *  `secureFolders` (on Windows one PowerShell call). A no-op while they are
   *  still ready. Resolves whether the hook root is ready; says in the log
   *  when a preparation leaves Codex sessions, or the shim route, without
   *  hooks. Never throws. */
  async prepareHookFolders(resourcesDir: string, secureFolders: SecureHookFolders): Promise<boolean> {
    try {
      const dataDir = codexHookDataDir()
      if (!dataDir) {
        logWarn('[codex] hooks: the app\'s data folder is not known yet, so Codex sessions get no hooks for now')
        return false
      }
      const scriptsDir = path.join(resourcesDir, 'scripts')
      let plainDir: string | null = null
      let plainWordMissing = false
      if (process.platform === 'win32' && !codexHookCommand(scriptsDir, 'win32', true)) {
        plainDir = codexPlainWrapperDir(codexLocalAppData(), resourcesDir)
        plainWordMissing = plainDir === null
      }
      const out = await prepareCodexHookFolders({ dataDir, scriptsDir, plainDir }, secureFolders)
      if (out.ran) {
        const why = out.detail.length ? ` (${out.detail.join('; ')})` : ''
        // Round 3 (F3): said, never silent, when Codex sessions will have no hooks.
        if (!out.root) logWarn(`[codex] hooks: the hook folder in the data folder is not a real folder that this user alone owns, and could not be made one${why}, so Codex sessions get no hooks`)
        // Round 2 (R7): and when the shim route will have none.
        if (plainWordMissing) logWarn('[codex] hooks: the path of the local app data folder is not a plain word, so a Codex installed with npm gets no hooks here')
        else if (out.plain === false) logWarn(`[codex] hooks: the plain-path copy of the hook wrapper could not be made (or its folders made this user's alone)${why}, so a Codex installed with npm gets no hooks until the app starts again`)
      }
      return out.root
    } catch (err) {
      logWarn(`[codex] hooks: preparing the hook folders failed (${(err as Error)?.message ?? err}); Codex sessions get no hooks for now`)
      return false
    }
  }

  /** P3.10: the session's hook file, for its launch's hooks; round 1 (A5):
   *  in this install's own hook root, in its data folder. Round 4 (P1): only
   *  in a root this run prepared (prepareHookFolders), checked here without
   *  starting anything; otherwise the launch has no hooks, and says so. */
  prepareSessionHooks(sessionId: string, port: number, secret: string): { hookFile: string; dispose(): void } | null {
    let root: string | null = null
    try {
      const dataDir = codexHookDataDir()
      root = dataDir ? preparedCodexHookRoot(dataDir) : null
    } catch { root = null }
    if (!root) {
      // Round 3 (F3): said, never silent.
      logWarn(`[codex] hooks: no hook folder for ${sessionId} (the data folder's codex-hooks is not prepared yet, or is not a real folder that this user alone owns); the session gets no hooks`)
      return null
    }
    const written = writeCodexHookFile(sessionId, port, secret, root)
    if (!written) return null
    let disposed = false
    return {
      hookFile: written.file,
      dispose: () => {
        if (disposed) return
        disposed = true
        removeCodexHookFile(written)
      },
    }
  }
}

/** What the pinned Codex CLI supports through this app, stated honestly
 *  (design 7.3). A key is `supported` only once this package exposes the
 *  operation behind it (registration enforces that). The setup keys are
 *  backed on every package (setup.discover, setup.installRecipes); the auth
 *  keys need the registry's realms, so they stay `unknown` here and
 *  codexWiredCapabilities declares them once the composition root wires
 *  those. Version constants: pinned reference 0.155.1; 0.153.4 is the
 *  minimum only if the D7 conformance, realm-isolation and real-binary
 *  evidence passes. */
export const CODEX_PINNED_VERSION = CODEX_PINNED_CLI_VERSION
export const CODEX_MINIMUM_VERSION_CANDIDATE = CODEX_MIN_SUPPORTED_VERSION
export const codexCapabilities: ProviderCapabilities = {
  'cli.discovery': { state: 'supported', note: 'codex --version in a throwaway home under the allowlisted environment (setup.discover); run at start, by Check again in Settings, Accounts and by the Codex setup page' },
  'install.recipes': { state: 'supported', note: 'code-defined recipes from the README (OpenAI\'s installer first, then npm everywhere and Homebrew on macOS); each runs only in a visible terminal tab after the user confirms its line (for the installer, a confirmation that names chatgpt.com, the host its script comes from; ADR-024), never on its own and never elevated' },
  'auth.browser': { state: 'unknown', note: 'codex login (ChatGPT); wired in the Codex adapter slice' },
  'auth.device': { state: 'unknown', note: 'codex login --device-auth, labelled beta by the provider; wired in the Codex adapter slice' },
  'auth.apiKey': { state: 'unknown', note: 'codex login --with-api-key over a one-shot non-TTY stdin pipe, never an argument; wired in the Codex adapter slice' },
  'auth.status': { state: 'unknown', note: 'codex login status; wired in the Codex adapter slice' },
  'auth.logout': { state: 'unknown', note: 'codex logout in the selected realm; wired in the Codex adapter slice' },
  'auth.retireReplaced': { state: 'unknown', note: 'signing out the folder an account left after Sign in again: off until evidence shows that sign-out never signs the new folder out, on 0.153.4 and 0.155.1 with a second real sign-in on the test VM, for file and keyring stores (to be recorded under docs/wp2/evidence/); until then the old sign-in is kept, visible, and removed when the account is archived' },
  'realm.isolated': { state: 'unknown', note: 'isolation is implemented without this key: once the registry\'s realms are wired, each managed account has its own CODEX_HOME folder (realmFolders), set by the prepared launch (launch.prepare) and every CLI run in that realm; file and keyring credentials are scoped by it in the pinned source. The contract backs this key with realms.realmEnvPatch, which this package does not expose, so it stays unknown' },
  'account.labelFields': { state: 'unsupported', note: 'login status exposes no stable subject; external homes are realm-only' },
  'account.usage': { state: 'unknown', note: 'the usage port needs the registry\'s realms: it locates each account\'s sessions folder as a launch does; wired with them' },
  'session.launch': { state: 'supported' },
  'session.history': { state: 'unknown', note: 'the resume picker works today; the provider-contract history listing returns nothing until the Codex adapter slice wires it' },
  'session.cloud': { state: 'unsupported', note: 'Codex has no cloud-agent surface' },
  'session.ssh': { state: 'unsupported', note: 'Codex over SSH is not supported' },
}

/** The declaration once the composition root wires the registry's realms:
 *  the auth operations then exist and the accounts service drives them.
 *  Device sign-in stays experimental (the provider labels it beta), so it is
 *  off until the owner enables it. Real-CLI qualification per OS is the
 *  release gate (WP1.64), not this declaration. */
export const codexWiredCapabilities: ProviderCapabilities = {
  ...codexCapabilities,
  'auth.browser': { state: 'supported', note: 'codex login (ChatGPT) in the account\'s own CODEX_HOME' },
  'auth.device': { state: 'experimental', note: 'codex login --device-auth, labelled beta by the provider' },
  'auth.apiKey': { state: 'supported', note: 'codex login --with-api-key over a one-shot non-TTY stdin pipe, never an argument' },
  'auth.status': { state: 'supported', note: 'codex login status in the account\'s own CODEX_HOME' },
  'auth.logout': { state: 'supported', note: 'codex logout in the selected realm; an external home needs the user\'s acknowledgement' },
  'account.usage': { state: 'supported', note: 'an open session\'s latest figure from memory, else the last one in the account\'s own session history (usage track MP3); no process' },
}

/** Ambient variables that could override a bound Codex realm (D3).
 *
 *  Slice 1 carried two names. Two things widen it here, both on the owner's
 *  2026-09-21 ruling:
 *
 *  1. The CLI's OWN diagnostic enumerates three credential variables, not one:
 *     `auth env vars present: OPENAI_API_KEY, CODEX_API_KEY, CODEX_ACCESS_TOKEN`
 *     (codex-cli 0.153.4). A list derived from the docs alone had the first.
 *  2. The endpoint variables settle the slice-1 open question the same way the
 *     Claude list does: redirecting where a credential goes is an authority
 *     override, whether or not the realm it was read from was correct.
 *
 *  `OPENAI_WORKLOAD_IDENTITY_CONTEXT` is deliberately ABSENT -- owner ruling:
 *  it is attribution-only and removing it would break attribution for no
 *  security gain. Unrelated AWS/Azure/GCP developer-tool variables are equally
 *  deliberately absent; this app is a terminal wrapper, and stripping a
 *  developer's cloud tooling out of their shell is not its business.
 *
 *  DERIVED AGAINST 0.153.4, WHICH IS NOT THE PINNED VERSION. D7 pins 0.155.1,
 *  and this list must be re-derived against that binary before the candidate.
 *  It is widened rather than narrowed relative to slice 1, so an entry that
 *  turns out not to exist in 0.155.1 costs a removed variable nobody set, not
 *  a hole. */
export const codexAmbientAuthVariables: readonly string[] = [
  // state roots
  'CODEX_HOME', 'CODEX_SQLITE_HOME',
  // credentials, exactly as the CLI's own `auth env vars present:` line names them
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
  // endpoint routing
  'OPENAI_BASE_URL', 'CODEX_URL', 'CODEX_CLOUD_TASKS_BASE_URL',
  // federation
  'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE',
]

/** The Codex realm patch sets the home and nothing else. CODEX_HOME appears
 *  in BOTH lists on purpose: it is stripped from the inherited environment as
 *  an ambient override, then re-set to the bound realm. That double listing is
 *  now required -- the ambient list is no longer implicitly settable. */
export const codexOwnedLaunchVariables: readonly string[] = ['CODEX_HOME']

/** The external default home as an account: its private identity's name
 *  says nobody has verified who is signed in there (design 5.5). */
export const CODEX_EXTERNAL_DEFAULT_REALM = Object.freeze({ kind: 'codex-home' as const, identityLabel: 'External Codex sign-in (account unverified)' })

/** The registry's side of a realm, supplied by the composition root: the
 *  record behind an opaque reference, and the resources directory as the app
 *  has it configured. The package canonicalises that directory and the
 *  external home itself before it derives any CODEX_HOME. */
export interface CodexRealmSource {
  /** `use`: what the lookup is for; a realm an account moved off resolves
   *  only for its status check and sign-out (realmOperable). */
  lookup(realm: RealmRef, use: RealmUse): Promise<{ ok: true; realm: Pick<AuthRealm, 'id' | 'providerId' | 'kind' | 'ownership' | 'pathRef' | 'lifecycle'>; resourcesDir: string } | { ok: false }>
  /** `mkdir -p` refusing a pre-planted link: the app's mkdirSecure. */
  mkdirSecure(dir: string): void
}

/** What the composition root hands the package: the ports it does not own. */
export interface CodexPackageDeps {
  /** The registry's realms. Until the composition root supplies them the
   *  package exposes no auth or folder operations, and the capabilities that
   *  need them stay `unknown`. */
  realms?: CodexRealmSource
  /** The single-use secret store behind API-key sign-in. */
  auth?: Pick<CodexAuthDeps, 'takeSecret'>
  /** The discovery ports; the real ones unless a test supplies its own. */
  discoveryDeps?: () => Promise<CodexDiscoveryDeps>
  /** The model catalogue read's ports (P3.9), for a test. `proven` is not
   *  replaceable: it is always this package's own last discovery. */
  catalogueDeps?: () => Omit<CodexCatalogueDeps, 'proven'>
  /** Replaces real auth ports, for a test. `proven` is not replaceable: it is
   *  always this package's own last discovery. */
  authPorts?: Partial<Omit<CodexAuthDeps, 'proven' | 'lookupRealm' | 'takeSecret' | 'locks'>>
  /** Replaces the real folder filesystem, for a test. */
  realmFs?: CodexRealmFsPort
  /** The owner-only folder rule for a test's folder filesystem (realmFs).
   *  Read only with realmFs: the real filesystem always gets the app's own
   *  rule, and a test filesystem is not this disk, so without one its
   *  folders are taken as already made owner-only. */
  secureFolders?: CodexRealmFolderDeps['secureFolders']
  /** Smaller bounds on the folder walks, for a test. */
  realmLimits?: Partial<CodexRealmFolderLimits>
  /** Replaces the inherited CODEX_HOME and the home directory, for a test. */
  hostHome?: { env: Readonly<Record<string, string | undefined>>; homeDir: string }
  /** Replaces the filesystem the usage port's last-seen reader uses, for a test. */
  usageFs?: CodexUsageFsPort
  /** Replaces the live usage figures the sessions record, for a test. */
  liveUsage?: CodexLiveUsage
  /** Replaces the file work of a conversation copy (P3.6), for a test. */
  conversationCarry?: CodexConversationCarry
  /** Where the conversations Switch Account carried are marked (ADR-023);
   *  replaces the in-memory-plus-port store, for a test. */
  carryMarks?: CodexCarryMarks
  /** Where those marks are kept between runs (the composition root's file
   *  next to the account registry). Absent: kept in memory only. */
  carryMarksPort?: CodexCarryMarksPort
  /** The clock a carry is stamped with, for a test. */
  now?: () => number
  /** The newest time in the copy a carry made, for its mark; replaces the real
   *  read of the copy, for a test. */
  newestCopiedStamp?: (sessionsDir: string, id: string) => number | null
}

/** The CODEX_HOME the app inherited, in every spelling, captured once when
 *  the package is created: the external default home is the one the user's
 *  own Codex would use, whatever the process environment later becomes. */
function inheritedCodexHome(env: NodeJS.ProcessEnv): Readonly<Record<string, string | undefined>> {
  return Object.freeze(Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() === 'CODEX_HOME')))
}

/** Created by the composition root; importing this entry point has no side effects. */
export function createCodexPackage(deps: CodexPackageDeps = {}): ProviderPackage {
  // Each session's allowance, by its realm's sessions folder (usage track MP3).
  const liveUsage = deps.liveUsage ?? createCodexLiveUsage(deps.realmFs?.platform ?? process.platform)
  // Conversations carried by Switch Account (ADR-023): read by the session
  // watchers and the last-seen reader, written by the conversation copy.
  const carryMarks = deps.carryMarks ?? createCodexCarryMarks({ ...(deps.carryMarksPort ? { port: deps.carryMarksPort } : {}), platform: deps.realmFs?.platform ?? process.platform, ...(deps.now ? { now: deps.now } : {}), log: (message) => logWarn(message) })
  const session = new CodexProvider(liveUsage, carryMarks)
  // The CLI setup last proved. Sign-in re-verifies it and runs exactly it. A
  // re-check clears it while it runs, and a failed check leaves it clear, so
  // nothing ever runs on stale proof; overlapping checks keep the newest.
  let proven: CodexDiscovery | null = null
  let generation = 0
  const discover = async (): Promise<CodexDiscovery> => {
    const mine = ++generation
    proven = null
    const r = await discoverCodex(await (deps.discoveryDeps ?? realDiscoveryDeps)())
    if (mine === generation) proven = r.state === 'found' ? r : null
    return r
  }
  // One lock set for sign-in, sign-out and folder removal.
  const locks = createCodexRealmLocks()
  const source = deps.realms
  const inherited = deps.hostHome ? inheritedCodexHome(deps.hostHome.env as NodeJS.ProcessEnv) : inheritedCodexHome(process.env)
  let homeDir = ''
  // No home at all (POSIX without HOME or a passwd entry): no ~/.codex.
  try { homeDir = deps.hostHome ? deps.hostHome.homeDir : os.homedir() } catch { homeDir = '' }
  const realmFs = source ? (deps.realmFs ?? realRealmFsPort(process.platform, (dir) => source.mkdirSecure(dir))) : null
  const displayPaths = (realmFs?.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  /** The registry's record with canonical roots, resolved afresh each time. */
  const lookupRealm = async (ref: RealmRef, use: RealmUse): Promise<CodexFolderLookup> => {
    if (!source || !realmFs) return { ok: false }
    const found = await source.lookup({ authRealmId: ref.authRealmId }, use)
    if (!found || found.ok !== true || !found.realm || typeof found.resourcesDir !== 'string') return { ok: false }
    const r = resolveCodexRealmRoots({ resourcesDir: found.resourcesDir, env: inherited, homeDir }, realmFs)
    return r.ok ? { ok: true, realm: found.realm, roots: r.roots } : { ok: false }
  }
  return {
    id: session.id,
    displayName: session.displayName,
    session,
    capabilities: source && realmFs ? codexWiredCapabilities : codexCapabilities,
    ambientAuthVariables: codexAmbientAuthVariables,
    ownedLaunchVariables: codexOwnedLaunchVariables,
    enablement: CODEX_ENABLEMENT,
    // No `managedLaunch`: the app writes no Codex settings file today, so it
    // has nothing to sanitise, and no CLI floor has been established. Both
    // land with the Codex adapter slice.
    setup: {
      discover,
      installRecipes: codexInstallRecipes,
      supportedVersions: Object.freeze({ minimum: CODEX_MIN_SUPPORTED_VERSION, maximumTested: CODEX_MAX_TESTED_VERSION }),
      // P3.9 (row 39): the proven CLI's own model list, in a fresh empty
      // home (model-catalogue.ts). Only the CLI this package last proved.
      modelCatalogue: (opts) => {
        const ports = (deps.catalogueDeps ?? realCatalogueDeps)()
        return readCodexModelCatalogue({ executablePorts: ports.executablePorts, baseEnv: ports.baseEnv, run: ports.run, scratchHome: ports.scratchHome, proven: () => proven }, opts ?? {})
      },
    },
    // A reviewer for another provider's sessions (plan: provider review
    // through MCP), run from a launch the accounts service prepared.
    review: createCodexReviewOperations(),
    // WP2 PR 4, P4.5 (row 57): a Cloud Agent's headless `codex exec`, run
    // from a launch the accounts service prepared (kind `background`).
    background: createCodexBackgroundOperations(),
    // WP2 PR 4, P4.7 (row 68): an Insights report's text-only `codex exec`,
    // run from a launch the accounts service prepared (kind `background`);
    // the Insights runner reaches it through the registry.
    insights: createCodexInsightsOperations(),
    // WP2 PR 4: the model prices Tokenomics reads, through the registry.
    pricing: CODEX_PRICING,
    ...(source && realmFs ? {
      ...withRealms(
        createCodexAuthOperations({ ...realAuthDeps({ lookupRealm, takeSecret: deps.auth?.takeSecret }, realmFs), ...testAuthPorts(deps.authPorts), locks, proven: () => proven }),
        deps.usageFs ?? realCodexUsageFsPort(realmFs.platform),
        liveUsage,
        () => proven,
        carryMarks,
      ),
      // P3.6: a switched session's conversation is carried with the real
      // file system (conversation-carry.ts), under these same realm locks.
      // The managed folders on this disk get the app's owner-only folder
      // rule; a test's folder filesystem brings its own.
      realmFolders: createCodexRealmFolders({ lookupRealm, fs: realmFs, locks, secureFolders: deps.realmFs ? (deps.secureFolders ?? testFolderRule) : secureOwnerOnlyFolders, carry: deps.conversationCarry ?? carryCodexRollout, marks: carryMarks, newestStamp: deps.newestCopiedStamp ?? ((dir, id) => newestCarriedStamp(dir, id, deps.now ? deps.now() : Date.now())), ...(deps.now ? { now: deps.now } : {}), ...(deps.realmLimits ? { limits: deps.realmLimits } : {}) }),
      // The user's own ~/.codex (or inherited CODEX_HOME), adopted only when
      // the user chooses to use it and it is signed in (owner decision
      // 2026-09-26): realm-only, never vouched for (design 6.3).
      // Named for display as the CLI finds it: the CODEX_HOME inherited, else
      // ~/.codex (the page and Accounts say which folder was checked), by the
      // same path rules as the folder code that checks it (its platform);
      // none for a CODEX_HOME that cannot be used.
      externalDefaultRealm: { ...CODEX_EXTERNAL_DEFAULT_REALM, displayHome: () => codexHomeDisplay(codexExternalDefaultHome(inherited, homeDir, displayPaths), homeDir, displayPaths) },
    } : {}),
  }
}

/** The auth operations, the launch preparation that shares their realm and
 *  executable checks, and the usage port that locates a realm's sessions
 *  folder exactly as a launch does: one package, one proof. */
function withRealms(ops: CodexAuthOperations, usageFs: CodexUsageFsPort, liveUsage: CodexLiveUsage, proven: () => CodexDiscovery | null, marks: CodexCarryMarks): Pick<ProviderPackage, 'auth' | 'launch' | 'usage'> {
  return {
    auth: ops,
    // MP9 round 1 (B-F1): the usage index reads a realm's folder held to the
    // launch's canonical-home check (no junction or link), as the Account
    // usage page does: a home linked into another realm's is never read as
    // its own. P4.4: the account's log folder, memories folder and settings
    // file, held to the same check. P4.5 (row 57): a Cloud Agent's headless
    // run is a launch of its own kind, `background`, bound and leased as
    // sessions and reviews are.
    launch: {
      kinds: ['session', 'review', 'background'], prepare: (realm) => ops.prepareLaunch(realm), sessionsDir: (realm) => ops.usageSessionsDir(realm),
      accountFolders: (realm) => ops.accountFolders(realm),
      // ADR-025: awaited by the accounts service before a local launch.
      warmFirstStart: (executable) => warmCodexFirstStart(executable),
    },
    usage: createCodexUsageOperations({
      sessionsDir: (realm) => ops.usageSessionsDir(realm), fs: usageFs, live: liveUsage, marks,
      // MP8: the one helper read, and the executable it would run.
      readUsage: (realm, opts) => ops.readUsage(realm, opts),
      executable: () => codexExecutableKey(proven()),
    }),
  }
}

/** The executable discovery proved, as the usage read's verdict key: its
 *  canonical path, size, times, file id and version (MP8). Null when none
 *  is proved. */
export function codexExecutableKey(p: CodexDiscovery | null): { key: string; version: string | null } | null {
  if (!p || p.state !== 'found' || !p.identity) return null
  const id = p.identity
  const version = typeof p.version === 'string' ? p.version : null
  return { key: JSON.stringify([id.path, id.size, id.mtimeMs, id.ctimeMs, id.dev, id.ino, version]), version }
}

/** A test folder filesystem's folders, which are not on this disk: each
 *  answered as made owner-only (no process runs, nothing on disk changes). */
const testFolderRule: NonNullable<CodexRealmFolderDeps['secureFolders']> = async (dirs) => dirs.map((dir) => ({ dir, ok: true, detail: 'owner-only' }))

/** The real filesystem behind the managed folders. */
function realRealmFsPort(platform: NodeJS.Platform, mkdirSecure: (dir: string) => void): CodexRealmFsPort {
  const entry = (s: fs.BigIntStats): CodexFsEntry => ({
    kind: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
    // bigint: NTFS file ids exceed 2^53.
    dev: String(s.dev),
    ino: String(s.ino),
    mode: Number(s.mode & 0o7777n),
    nlink: Number(s.nlink),
  })
  return {
    platform,
    realpath: (p) => fs.realpathSync.native(p),
    lstat: (p) => entry(fs.lstatSync(p, { bigint: true })),
    mkdirSecure,
    mkdir: (dir, mode) => { fs.mkdirSync(dir, { mode }) },
    chmod: (p, mode) => fs.chmodSync(p, mode),
    readdir: (dir) => fs.readdirSync(dir),
    unlink: (p) => fs.unlinkSync(p),
    rmdir: (p) => fs.rmdirSync(p),
    // The long walks (a removal, a history copy): never holding the main process.
    promises: {
      // realpath.native semantics, as the sync port's.
      realpath: (p) => fs.promises.realpath(p),
      lstat: async (p) => entry(await fs.promises.lstat(p, { bigint: true })),
      readdir: (dir) => fs.promises.readdir(dir),
      mkdir: async (dir, mode) => { await fs.promises.mkdir(dir, { mode }) },
      chmod: (p, mode) => fs.promises.chmod(p, mode),
      unlink: (p) => fs.promises.unlink(p),
      rmdir: (p) => fs.promises.rmdir(p),
      // Both refuse anything already there (EEXIST).
      link: (src, dest) => fs.promises.link(src, dest),
      copyFile: (src, dest) => fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL),
    },
  }
}

/** Only the ports a test may replace -- never `proven`, the realm lookup or
 *  the secret store, whatever else the object carries. */
function testAuthPorts(ports: CodexPackageDeps['authPorts']): Partial<CodexAuthDeps> {
  if (!ports) return {}
  const out: Partial<CodexAuthDeps> = {}
  if (ports.realmIdentity) out.realmIdentity = ports.realmIdentity
  if (ports.executablePorts) out.executablePorts = ports.executablePorts
  if (ports.baseEnv) out.baseEnv = ports.baseEnv
  if (ports.run) out.run = ports.run
  if (ports.envFilePresent) out.envFilePresent = ports.envFilePresent
  return out
}

/** Re-resolving and re-reading the executable: the session resolver and the
 *  filesystem, shared by discovery and the pre-use re-verification. */
function realExecutablePorts(platform: NodeJS.Platform): Pick<CodexDiscoveryDeps, 'resolve' | 'realpath' | 'stat' | 'platform'> {
  return {
    resolve: () => resolveCodexBinary()?.cmd ?? null,
    realpath: (p) => fs.realpathSync.native(p),
    stat: (p) => {
      // bigint: NTFS file ids exceed 2^53; times come back in whole ms.
      const s = fs.statSync(p, { bigint: true })
      return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs), dev: String(s.dev), ino: String(s.ino), isFile: s.isFile() }
    },
    platform,
  }
}

/** The real ports behind the auth operations. */
function realAuthDeps(injected: Pick<CodexAuthDeps, 'lookupRealm' | 'takeSecret'>, realmFs: CodexRealmFsPort): Omit<CodexAuthDeps, 'proven'> {
  const platform = process.platform
  const takeSecret = injected.takeSecret
  return {
    lookupRealm: (realm, use) => injected.lookupRealm(realm, use),
    // Through the folder port, so sign-in and folder removal key the realm
    // lock on the same reading of the same folder.
    realmIdentity: (home) => {
      const canonical = realmFs.realpath(home)
      const e = realmFs.lstat(canonical)
      return { canonical, dev: e.dev, ino: e.ino, isDirectory: e.kind === 'dir' }
    },
    ...(takeSecret ? { takeSecret: (handle: string) => takeSecret(handle) } : {}),
    executablePorts: realExecutablePorts(platform),
    baseEnv: () => codexOperationBaseEnv(process.env, platform),
    // Built per run, never at compose time: composing the providers must not
    // touch child_process (and the run reads SystemRoot fresh).
    run: (cmd, opts) => runCodexCli(cmd, opts, defaultCodexRunDeps(platform)),
    // Anything there -- a file, a link, a folder -- or an answer other than
    // "does not exist" counts as present.
    envFilePresent: (home) => {
      try {
        fs.lstatSync(path.join(home, '.env'))
        return true
      } catch (e) {
        return (e as NodeJS.ErrnoException)?.code !== 'ENOENT'
      }
    },
  }
}

/** The real ports behind the model catalogue read (P3.9): the session
 *  resolver and the filesystem to re-verify the executable, the operation
 *  environment, the runner, and a fresh empty home under the temp folder,
 *  removed after the read -- never the user's own ~/.codex or an account's
 *  folder. Built per call, so the environment is read fresh. */
function realCatalogueDeps(): Omit<CodexCatalogueDeps, 'proven'> {
  const platform = process.platform
  return {
    executablePorts: realExecutablePorts(platform),
    baseEnv: () => codexOperationBaseEnv(process.env, platform),
    run: (cmd, opts) => runCodexCli(cmd, opts, defaultCodexRunDeps(platform)),
    scratchHome: () => codexModelsScratchHome(codexModelsScratchParent()),
  }
}

/** The model list read's empty homes, under the temp folder (P3.9). */
export const CODEX_MODELS_HOME_PREFIX = 'ccc-codex-models-'
/** A run's own folder older than this is a leftover (P3.9 round 1). */
export const STALE_RUN_FOLDER_MS = 60 * 60 * 1000

/** The folder the model list read's homes are made in: the temp folder by
 *  its real path, so the leftover sweep (which lists nothing through a
 *  link) still runs where the temp folder is named through one (macOS
 *  /tmp; a TEMP folder behind a junction); the temp folder as named when
 *  its real path cannot be read. */
export function codexModelsScratchParent(tmp: string = os.tmpdir(), realpath: (p: string) => string = fs.realpathSync.native): string {
  try { return realpath(tmp) } catch { return tmp }
}

/** A fresh empty home for one model list read, under `parent`, removed by
 *  its dispose. P3.9 round 1: a home an earlier read left behind (a crash or
 *  a quit mid-read) goes first: own prefix, real folders only, an hour old. */
export function codexModelsScratchHome(parent: string): { home: string; dispose(): void } {
  sweepStaleFolders(parent, CODEX_MODELS_HOME_PREFIX, { maxAgeMs: STALE_RUN_FOLDER_MS })
  const home = fs.mkdtempSync(path.join(parent, CODEX_MODELS_HOME_PREFIX))
  return { home, dispose: () => fs.rmSync(home, { recursive: true, force: true }) }
}

/** The CLI prepares its home before it parses `--version`: a fresh, empty
 *  one under the temp folder, removed by `dispose`, never the user's own
 *  ~/.codex or an account's folder. */
function codexVersionHome(): { home: string; dispose(): void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-codex-version-'))
  return { home, dispose: () => fs.rmSync(home, { recursive: true, force: true }) }
}

/** ADR-025: a launch's first start of the proven executable this app run,
 *  off the main thread, with the environment discovery's `--version` run is
 *  built with: the operation environment, allowlisted, over a fresh
 *  throwaway home that is removed once that start has finished. Built only
 *  when the file has not been started this run. */
function warmCodexFirstStart(executable: string): Promise<unknown> {
  const platform = process.platform
  return warmFirstStart(executable, async () => {
    const base = await codexOperationBaseEnv(process.env, platform)
    const scratch = codexVersionHome()
    try {
      return { env: codexCliEnv(base, scratch.home, platform), dispose: scratch.dispose }
    } catch (e) {
      scratch.dispose()
      throw e
    }
  })
}

/** The real ports behind discovery: the session resolver, the filesystem,
 *  and the runner. Built per call, so the environment is read fresh. */
async function realDiscoveryDeps(): Promise<CodexDiscoveryDeps> {
  const platform = process.platform
  const runDeps = defaultCodexRunDeps(platform)
  return {
    ...realExecutablePorts(platform),
    run: (cmd, env) => runCodexCli(cmd, { env, timeoutMs: 10_000 }, runDeps),
    // ADR-025: the `--version` run's own environment, as it is about to get it.
    warm: (executable, env) => warmFirstStart(executable, () => ({ env })),
    env: await codexOperationBaseEnv(process.env, platform),
    versionHome: () => codexVersionHome(),
    now: () => Date.now(),
  }
}
