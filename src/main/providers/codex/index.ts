// Codex provider package: public entry point (WP1, design 7.1). Everything
// outside this directory imports from here; the dependency-boundary test
// ratchets the remaining deep imports down to zero.
import type { SessionProvider, SpawnOptions, TelemetrySource, HistorySession } from '../types'
import type { LegacyVersion, StatuslineData } from '../../../shared/types'
import type { ProviderCapabilities, AuthRealm } from '../../../shared/providers'
import type { ProviderPackage, RealmRef } from '../core'
import { CODEX_ENABLEMENT } from './enablement'
import { resolveCodexBinary, buildCodexSpawn } from './spawn'
import { detectCodexUi } from './ui-detection'
import { watchAndClaimRollout } from './telemetry'
import { deployCodexResumePickerScript } from './resume-picker'
import { CODEX_PINNED_CLI_VERSION, CODEX_MIN_SUPPORTED_VERSION } from './cli-contract'
import { codexInstallRecipes } from './install-recipes'
import { codexOperationBaseEnv } from './process-env'
import { runCodexCli, defaultCodexRunDeps } from './cli-runner'
import { discoverCodex } from './discovery'
import type { CodexDiscovery, CodexDiscoveryDeps } from './discovery'
import { createCodexAuthOperations } from './auth-operations'
import { createCodexReviewOperations } from './review'
import type { CodexAuthDeps, CodexAuthOperations } from './auth-operations'
import { createCodexRealmFolders, createCodexRealmLocks, resolveCodexRealmRoots } from './realm-folders'
import type { CodexFolderLookup, CodexFsEntry, CodexRealmFsPort } from './realm-folders'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// WP2 Codex adapter: the CLI contract, install recipes, the allowlisted
// subprocess environment, realm paths, the CLI runner and discovery.
export {
  codexCommandLine, cliCommandLine, codexShellEnv, runCodexCli, defaultCodexRunDeps, makeCodexKillTree, makeCodexProcessLister,
  codexChainPids, parseWindowsProcessTable, parsePosixProcessTable, parseLinuxStat, WINDOWS_PROCESS_QUERY,
  CODEX_KILL_SETTLE_MS, CODEX_PROCESS_TABLE_TIMEOUT_MS, CODEX_TASKKILL_TIMEOUT_MS, CODEX_TREE_PRIME_MS, CODEX_PRIME_TABLE_TIMEOUT_MS, codexWrapperLinePids,
} from './cli-runner'
export type { CodexCliOperation, CodexCommand, CodexRunResult, CodexRunOptions, CodexRunDeps, CodexProcessEntry, CodexKillTree } from './cli-runner'
export { discoverCodex, verifyCodexExecutable, codexCompatibilityAllowsUse } from './discovery'
export { createCodexReviewOperations, createCodexExecEventReader, parseCodexExecEvents, REVIEW_MAX_TEXT } from './review'
export type { CodexDiscovery, CodexDiscoveryDeps, CodexExecutableIdentity, CodexExecutableCheck, CodexFileStat } from './discovery'
export { codexLoginShellPath, codexOperationBaseEnv, extractMarkedPath, absolutePathEntries } from './process-env'
export {
  CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION, CODEX_MAX_TESTED_VERSION,
  parseCodexVersion, classifyCodexVersion, parseCodexLoginStatus,
} from './cli-contract'
export type { CodexLoginStatus, CodexLoginVia } from './cli-contract'
export { codexInstallRecipes, CODEX_INSTALL_SOURCE_URL, CODEX_README_COMMIT } from './install-recipes'
export { createCodexAuthOperations, createCodexOutputRedactor } from './auth-operations'
export type { CodexAuthDeps, CodexRealmLookup, CodexRealmIdentity, CodexOutputRedactor } from './auth-operations'
export { codexCliEnv, codexCliEnvAllowlist } from './cli-env'
export {
  codexRealmHome, codexExternalDefaultHome, codexExternalHomeCandidate, codexManagedRealmsRoot, codexHomesOverlap, isFullyQualifiedPath, CODEX_REALMS_DIRNAME,
} from './realm-paths'
export type { CodexRealmRoots, CodexRealmHome, CodexExternalCandidate } from './realm-paths'
export {
  createCodexRealmFolders, createCodexRealmLocks, codexRealmLockKey, resolveCodexRealmRoots, CODEX_REMOVE_MAX_DEPTH, CODEX_REMOVE_MAX_ENTRIES, CODEX_UNDER_LOCK_LOOKUP_MS,
} from './realm-folders'
export type { CodexRealmFsPort, CodexFsEntry, CodexRealmLocks, CodexFolderLookup, CodexRealmFolderDeps, CodexRootsResult } from './realm-folders'

/** Why the two session-contract methods a Codex launch never uses refuse: a
 *  Codex session runs only the executable its managed launch proved (the
 *  accounts service's prepared launch), never one looked up on PATH here. */
const CODEX_MANAGED_LAUNCH_ONLY = 'not used for Codex: launches go through the managed launch'

export class CodexProvider implements SessionProvider {
  readonly id = 'codex' as const
  readonly displayName = 'Codex'

  /** Required by the session contract; refuses (CODEX_MANAGED_LAUNCH_ONLY). */
  resolveBinary(_legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null {
    throw new Error(`resolveBinary is ${CODEX_MANAGED_LAUNCH_ONLY}`)
  }

  buildSpawnCommand(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string>; commandLine?: string } {
    return buildCodexSpawn(opts)
  }

  detectUiRunning(data: string): boolean {
    return detectCodexUi(data)
  }

  ingestSessionTelemetry(
    sessionId: string,
    opts: { cwd: string; spawnTimestamp: number; sessionsDir?: string },
    onUpdate: (data: StatuslineData) => void,
  ): TelemetrySource {
    // Only the session's own realm (WP2): with none there is nothing to watch,
    // and the ambient home would claim another account's transcript.
    if (!opts.sessionsDir) return { stop() {} }
    return watchAndClaimRollout(sessionId, opts.cwd, opts.spawnTimestamp, onUpdate, opts.sessionsDir)
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

  async deployResumePickerScript(resourcesDir: string): Promise<void> {
    return deployCodexResumePickerScript(resourcesDir)
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
  'install.recipes': { state: 'supported', note: 'code-defined recipes (npm everywhere, Homebrew on macOS); a package-manager recipe runs only in a visible terminal tab after the user confirms its line; the install scripts are shown and copied, never run' },
  'auth.browser': { state: 'unknown', note: 'codex login (ChatGPT); wired in the Codex adapter slice' },
  'auth.device': { state: 'unknown', note: 'codex login --device-auth, labelled beta by the provider; wired in the Codex adapter slice' },
  'auth.apiKey': { state: 'unknown', note: 'codex login --with-api-key over a one-shot non-TTY stdin pipe, never an argument; wired in the Codex adapter slice' },
  'auth.status': { state: 'unknown', note: 'codex login status; wired in the Codex adapter slice' },
  'auth.logout': { state: 'unknown', note: 'codex logout in the selected realm; wired in the Codex adapter slice' },
  'realm.isolated': { state: 'unknown', note: 'isolation is implemented without this key: once the registry\'s realms are wired, each managed account has its own CODEX_HOME folder (realmFolders), set by the prepared launch (launch.prepare) and every CLI run in that realm; file and keyring credentials are scoped by it in the pinned source. The contract backs this key with realms.realmEnvPatch, which this package does not expose, so it stays unknown' },
  'account.labelFields': { state: 'unsupported', note: 'login status exposes no stable subject; external homes are realm-only' },
  'account.usage': { state: 'unsupported', note: 'declared for later work' },
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
  lookup(realm: RealmRef): Promise<{ ok: true; realm: Pick<AuthRealm, 'id' | 'providerId' | 'kind' | 'ownership' | 'pathRef' | 'lifecycle'>; resourcesDir: string } | { ok: false }>
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
  /** Replaces real auth ports, for a test. `proven` is not replaceable: it is
   *  always this package's own last discovery. */
  authPorts?: Partial<Omit<CodexAuthDeps, 'proven' | 'lookupRealm' | 'takeSecret' | 'locks'>>
  /** Replaces the real folder filesystem, for a test. */
  realmFs?: CodexRealmFsPort
  /** Replaces the inherited CODEX_HOME and the home directory, for a test. */
  hostHome?: { env: Readonly<Record<string, string | undefined>>; homeDir: string }
}

/** The CODEX_HOME the app inherited, in every spelling, captured once when
 *  the package is created: the external default home is the one the user's
 *  own Codex would use, whatever the process environment later becomes. */
function inheritedCodexHome(env: NodeJS.ProcessEnv): Readonly<Record<string, string | undefined>> {
  return Object.freeze(Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() === 'CODEX_HOME')))
}

/** Created by the composition root; importing this entry point has no side effects. */
export function createCodexPackage(deps: CodexPackageDeps = {}): ProviderPackage {
  const session = new CodexProvider()
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
  /** The registry's record with canonical roots, resolved afresh each time. */
  const lookupRealm = async (ref: RealmRef): Promise<CodexFolderLookup> => {
    if (!source || !realmFs) return { ok: false }
    const found = await source.lookup({ authRealmId: ref.authRealmId })
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
    },
    // A reviewer for another provider's sessions (plan: provider review
    // through MCP), run from a launch the accounts service prepared.
    review: createCodexReviewOperations(),
    ...(source && realmFs ? {
      ...withLaunch(createCodexAuthOperations({ ...realAuthDeps({ lookupRealm, takeSecret: deps.auth?.takeSecret }, realmFs), ...testAuthPorts(deps.authPorts), locks, proven: () => proven })),
      realmFolders: createCodexRealmFolders({ lookupRealm, fs: realmFs, locks }),
      // The user's own ~/.codex (or inherited CODEX_HOME), adopted once on
      // upgrade when signed in: realm-only, never vouched for (design 6.3).
      externalDefaultRealm: CODEX_EXTERNAL_DEFAULT_REALM,
    } : {}),
  }
}

/** The auth operations, and the launch preparation that shares their realm
 *  and executable checks: one package, one proof. */
function withLaunch(ops: CodexAuthOperations): Pick<ProviderPackage, 'auth' | 'launch'> {
  return { auth: ops, launch: { kinds: ['session', 'review'], prepare: (realm) => ops.prepareLaunch(realm), sessionsDir: (realm) => ops.sessionsDir(realm) } }
}

/** The real filesystem behind the managed folders. */
function realRealmFsPort(platform: NodeJS.Platform, mkdirSecure: (dir: string) => void): CodexRealmFsPort {
  const entry = (s: fs.BigIntStats): CodexFsEntry => ({
    kind: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
    // bigint: NTFS file ids exceed 2^53.
    dev: String(s.dev),
    ino: String(s.ino),
    mode: Number(s.mode & 0o7777n),
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
    lookupRealm: (realm) => injected.lookupRealm(realm),
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

/** The real ports behind discovery: the session resolver, the filesystem,
 *  and the runner. Built per call, so the environment is read fresh. */
async function realDiscoveryDeps(): Promise<CodexDiscoveryDeps> {
  const platform = process.platform
  const runDeps = defaultCodexRunDeps(platform)
  return {
    ...realExecutablePorts(platform),
    run: (cmd, env) => runCodexCli(cmd, { env, timeoutMs: 10_000 }, runDeps),
    env: await codexOperationBaseEnv(process.env, platform),
    // The CLI prepares its home before it parses `--version`: give it a
    // fresh, empty one and remove it, never the user's own ~/.codex.
    versionHome: () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-codex-version-'))
      return { home, dispose: () => fs.rmSync(home, { recursive: true, force: true }) }
    },
    now: () => Date.now(),
  }
}
