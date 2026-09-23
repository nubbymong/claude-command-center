// Codex provider package: public entry point (WP1, design 7.1). Everything
// outside this directory imports from here; the dependency-boundary test
// ratchets the remaining deep imports down to zero.
import type { SessionProvider, SpawnOptions, TelemetrySource, HistorySession } from '../types'
import type { LegacyVersion, StatuslineData } from '../../../shared/types'
import type { ProviderCapabilities } from '../../../shared/providers'
import type { ProviderPackage } from '../core'
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
import type { CodexAuthDeps } from './auth-operations'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// WP2 Codex adapter: the CLI contract, install recipes, the allowlisted
// subprocess environment, realm paths, the CLI runner and discovery.
export {
  codexCommandLine, codexShellEnv, runCodexCli, defaultCodexRunDeps, makeCodexKillTree, makeCodexProcessLister,
  codexChainPids, parseWindowsProcessTable, parsePosixProcessTable, parseLinuxStat, WINDOWS_PROCESS_QUERY,
  CODEX_KILL_SETTLE_MS, CODEX_PROCESS_TABLE_TIMEOUT_MS, CODEX_TASKKILL_TIMEOUT_MS,
} from './cli-runner'
export type { CodexCliOperation, CodexCommand, CodexRunResult, CodexRunOptions, CodexRunDeps, CodexProcessEntry } from './cli-runner'
export { discoverCodex, verifyCodexExecutable, codexCompatibilityAllowsUse } from './discovery'
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
  codexRealmHome, codexExternalDefaultHome, codexManagedRealmsRoot, codexHomesOverlap, isFullyQualifiedPath, CODEX_REALMS_DIRNAME,
} from './realm-paths'
export type { CodexRealmRoots, CodexRealmHome } from './realm-paths'

export class CodexProvider implements SessionProvider {
  readonly id = 'codex' as const
  readonly displayName = 'Codex'

  resolveBinary(_legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null {
    return resolveCodexBinary()
  }

  buildSpawnCommand(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> } {
    return buildCodexSpawn(opts)
  }

  detectUiRunning(data: string): boolean {
    return detectCodexUi(data)
  }

  ingestSessionTelemetry(
    sessionId: string,
    opts: { cwd: string; spawnTimestamp: number },
    onUpdate: (data: StatuslineData) => void,
  ): TelemetrySource {
    return watchAndClaimRollout(sessionId, opts.cwd, opts.spawnTimestamp, onUpdate)
  }

  async listHistorySessions(): Promise<HistorySession[]> {
    // P4 implements resume picker
    return []
  }

  resumeCommand(sessionId: string): { cmd: string; args: string[] } {
    const r = resolveCodexBinary()
    if (!r) throw new Error('Codex CLI not found on PATH')
    return { cmd: r.cmd, args: ['resume', sessionId] }
  }

  async configureMcpServer(_cfg: { name: string; url: string }): Promise<void> {
    // P3 + P7.7.5 wire the conductor MCP entry into ~/.codex/config.toml
  }

  async deployResumePickerScript(resourcesDir: string): Promise<void> {
    return deployCodexResumePickerScript(resourcesDir)
  }
}

/** What the pinned Codex CLI supports through this app, stated honestly
 *  (design 7.3). A key is `supported` only once this package exposes the
 *  operation behind it (registration enforces that), so the setup/auth/realm
 *  keys stay `unknown` until the Codex adapter slice wires them; the notes
 *  record what the provider itself offers. Version constants: pinned
 *  reference 0.155.1; 0.153.4 is the minimum only if the D7 conformance,
 *  realm-isolation and real-binary evidence passes. */
export const CODEX_PINNED_VERSION = CODEX_PINNED_CLI_VERSION
export const CODEX_MINIMUM_VERSION_CANDIDATE = CODEX_MIN_SUPPORTED_VERSION
export const codexCapabilities: ProviderCapabilities = {
  'cli.discovery': { state: 'unknown', note: 'discovery is wired on the package (setup.discover); declared supported once the setup surface calls it' },
  'install.recipes': { state: 'unknown', note: 'recipes are code-defined (npm everywhere, Homebrew on macOS; install scripts shown only); declared supported once the recipe runner lands' },
  'auth.browser': { state: 'unknown', note: 'codex login (ChatGPT); wired in the Codex adapter slice' },
  'auth.device': { state: 'unknown', note: 'codex login --device-auth, labelled beta by the provider; wired in the Codex adapter slice' },
  'auth.apiKey': { state: 'unknown', note: 'codex login --with-api-key over a one-shot non-TTY stdin pipe, never an argument; wired in the Codex adapter slice' },
  'auth.status': { state: 'unknown', note: 'codex login status; wired in the Codex adapter slice' },
  'auth.logout': { state: 'unknown', note: 'codex logout in the selected realm; wired in the Codex adapter slice' },
  'realm.isolated': { state: 'unknown', note: 'one CODEX_HOME per managed account; file and keyring credentials are scoped by it in the pinned source; wired in the Codex adapter slice' },
  'account.labelFields': { state: 'unsupported', note: 'login status exposes no stable subject; external homes are realm-only' },
  'account.usage': { state: 'unsupported', note: 'declared for later work' },
  'session.launch': { state: 'supported' },
  'session.history': { state: 'unknown', note: 'the resume picker works today; the provider-contract history listing returns nothing until the Codex adapter slice wires it' },
  'session.cloud': { state: 'unsupported', note: 'Codex has no cloud-agent surface' },
  'session.ssh': { state: 'unsupported', note: 'Codex over SSH is not supported' },
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

/** What the composition root hands the package: the ports it does not own. */
export interface CodexPackageDeps {
  /** The realm lookup (from the registry) and the single-use secret store.
   *  Until the composition root supplies them the package exposes no auth
   *  operations, and its auth capabilities stay `unknown`. */
  auth?: Pick<CodexAuthDeps, 'lookupRealm' | 'takeSecret'>
  /** The discovery ports; the real ones unless a test supplies its own. */
  discoveryDeps?: () => Promise<CodexDiscoveryDeps>
  /** Replaces real auth ports, for a test. `proven` is not replaceable: it is
   *  always this package's own last discovery. */
  authPorts?: Partial<Omit<CodexAuthDeps, 'proven' | 'lookupRealm' | 'takeSecret'>>
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
  return {
    id: session.id,
    displayName: session.displayName,
    session,
    capabilities: codexCapabilities,
    ambientAuthVariables: codexAmbientAuthVariables,
    ownedLaunchVariables: codexOwnedLaunchVariables,
    // No `managedLaunch`: the app writes no Codex settings file today, so it
    // has nothing to sanitise, and no CLI floor has been established. Both
    // land with the Codex adapter slice.
    setup: {
      discover,
      installRecipes: codexInstallRecipes,
    },
    ...(deps.auth ? { auth: createCodexAuthOperations({ ...realAuthDeps(deps.auth), ...testAuthPorts(deps.authPorts), proven: () => proven }) } : {}),
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
function realAuthDeps(injected: NonNullable<CodexPackageDeps['auth']>): Omit<CodexAuthDeps, 'proven'> {
  const platform = process.platform
  const runDeps = defaultCodexRunDeps(platform)
  const takeSecret = injected.takeSecret
  return {
    lookupRealm: (realm) => injected.lookupRealm(realm),
    realmIdentity: (home) => {
      const canonical = fs.realpathSync.native(home)
      // bigint: NTFS file ids exceed 2^53.
      const s = fs.statSync(canonical, { bigint: true })
      return { canonical, dev: String(s.dev), ino: String(s.ino), isDirectory: s.isDirectory() }
    },
    ...(takeSecret ? { takeSecret: (handle: string) => takeSecret(handle) } : {}),
    executablePorts: realExecutablePorts(platform),
    baseEnv: () => codexOperationBaseEnv(process.env, platform),
    run: (cmd, opts) => runCodexCli(cmd, opts, runDeps),
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
