// WP1 main composition root (design 7.2): the ONLY main-process module that
// imports and registers the concrete provider packages. Adding a provider is
// one import and one entry in PACKAGE_FACTORIES below, never an edit to
// Claude or Codex code. Compile-time registration is deliberate for 2.1.1;
// no dynamic plugin loading.
import type { ProviderId } from '../../shared/providers'
import { PROVIDER_IDS } from '../../shared/providers'
import type { ProviderPackageFactory } from './core'
import { registerProviderPackage, listProviderPackages, tryGetProviderPackage } from './core'
import { createClaudePackage } from './claude'
import type { ClaudeLegacyAccountsIo, ClaudeReviewPorts, ClaudeAuthPorts } from './claude'
import { createCodexPackage, cliCommandLine, codexShellEnv, runCodexCli, defaultCodexRunDeps, flushPendingCodexKills } from './codex'
import type { CodexRealmSource, CodexCommand, CodexRunOptions, CodexRunResult } from './codex'
import { findRealm, realmOperable } from '../../shared/providers'
import { readProfilesStrict, updateProfilesStrict, mkdirSecure, profileRealmLaunch, profileReviewRefusal, recordProfileReviewPreflight } from '../account-profiles'
import { holdProfileForRun } from '../profile-consumers'
import { readClaudeCliAuth, logoutClaudeCli } from '../account-web/claude-cli-auth'
import type { ClaudeCliAuthRunner } from '../account-web/claude-cli-auth'
import { resolveClaudeExecutable } from '../claude-cli-version'
import { readConfigChecked } from '../config-manager'
import { getAccountRegistry, getAccountRegistryResourcesDir, REGISTRY_DIRNAME } from '../provider-account-registry'
import { takeProviderSecret } from '../provider-accounts'
import { atomicWriteFileSync } from '../atomic-write'
import { createCarryMarksFilePort } from '../carry-marks-port'
import { warmFirstStart, flushFirstStartWarmups } from '../first-start-warmup'
import path from 'node:path'

/** Where the conversations a Switch Account carried are marked between runs
 *  (ADR-023): a small file in the app's `providers/` folder next to the
 *  registry, never in an account's folder. Handed to the Codex package. */
const carryMarksPort = createCarryMarksFilePort({
  directory: () => {
    const resources = getAccountRegistryResourcesDir()
    return resources ? path.join(resources, REGISTRY_DIRNAME) : null
  },
  mkdirSecure: (dir) => mkdirSecure(dir),
  atomicWrite: (file, data, options) => atomicWriteFileSync(file, data, options),
  posix: process.platform !== 'win32',
})

/** Claude's profiles.json and settings, handed to the Claude package so the
 *  registry can mirror its accounts (WP2). Injected here, at the root, so the
 *  package imports no shared main module. Settings are read without
 *  quarantine: the package only observes a renderer-owned file. */
const claudeLegacyAccountsIo: ClaudeLegacyAccountsIo = {
  readProfiles: readProfilesStrict,
  updateProfiles: updateProfilesStrict,
  readSettings: () => readConfigChecked('settings', { quarantineUnparseable: false }),
}

/** The registry's side of a Codex realm (WP2 commit 3). A SNAPSHOT read,
 *  never the registry lock: folder removal awaits this while it holds the
 *  realm lock, and the registry lock is not re-entrant. The resources
 *  directory is the one the registry was loaded from, where the managed
 *  folders live. */
export const codexRealmSource: CodexRealmSource = {
  lookup: async (ref, use) => {
    const doc = getAccountRegistry()?.current()
    const realm = doc ? findRealm(doc, ref.authRealmId) : undefined
    const resourcesDir = getAccountRegistryResourcesDir()
    // Only a realm being set up or in use; an app-managed one an account
    // moved off whose sign-in is still to be removed (a sign in again) ONLY
    // for its status check and sign-out. Never a retired one: an archived
    // account's may name the same external home a newer account now uses,
    // and nothing may run there on the old record's behalf.
    const live = realmOperable(realm, use)
    return realm && live && resourcesDir ? { ok: true, realm, resourcesDir } : { ok: false }
  },
  mkdirSecure: (dir) => mkdirSecure(dir),
}

/** The Claude reviewer's ports (WP2 commit 5b): the registry's realms, the
 *  profile-home composition (account-profiles is the one module allowed to
 *  compose it), the credential-consumer hold, and the CLI runner. Handed in
 *  here, at the root, so the Claude package imports neither a shared main
 *  module that reaches the Codex package nor the Codex package itself. */
export const claudeReviewPorts: ClaudeReviewPorts = {
  // A SNAPSHOT read, as codexRealmSource's: only a realm in use.
  lookupRealm: async (ref) => {
    const doc = getAccountRegistry()?.current()
    const realm = doc ? findRealm(doc, ref.authRealmId) : undefined
    return realm && realm.lifecycle === 'active' ? { ok: true, realm } : { ok: false }
  },
  profileRealmLaunch: (profileId) => profileRealmLaunch(profileId),
  profileReviewRefusal,
  // The hold first, then the wait for a refresh in flight (claude-headless's
  // order), then a fresh hold for the run; a cancel during the wait lets go.
  holdProfile: holdProfileForRun,
  recordPreflight: (profileId, env) => recordProfileReviewPreflight(profileId, env),
  resolveExecutable: () => resolveClaudeExecutable(),
  commandLine: (executable, args, platform, env) => cliCommandLine(executable, args, platform, env, 'Claude Code'),
  shellEnv: (env, platform) => codexShellEnv(env, platform),
  // Built per run, never at compose time (and it reads SystemRoot fresh).
  run: (cmd, opts) => runCodexCli(cmd, opts, defaultCodexRunDeps()),
  // ADR-025: a Claude Code program's first start this run, off the main
  // thread, with exactly the environment its `--version` run was built with.
  warmFirstStart: (executable, env) => warmFirstStart(executable, () => ({ env })),
}

/** How the Claude sign-in status and sign-out run the CLI (WP2 PR 4): the
 *  executable the Claude package's discovery proved, through the reviewer's
 *  runner -- no shell (an npm shim through an absolute cmd.exe with a
 *  constant argument line), in the executable's own folder, and the whole
 *  process tree stopped at the time limit. `run` is replaceable for a test. */
export function claudeCliAuthRunner(
  executable: string,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: CodexCommand, opts: CodexRunOptions) => Promise<CodexRunResult> = (cmd, opts) => runCodexCli(cmd, opts, defaultCodexRunDeps()),
): ClaudeCliAuthRunner {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const cwd = typeof executable === 'string' && executable ? pathApi.dirname(executable) : ''
  return {
    cwd,
    run: async (args, env, timeoutMs) => {
      const cmd = cliCommandLine(executable, args, platform, codexShellEnv(env, platform), 'Claude Code')
      if ('refused' in cmd) return { refused: cmd.refused, exitCode: null, stdout: '', timedOut: false }
      // The whole tree: an auth run starts no program of the user's.
      const r = await run({ ...cmd, cwd }, { env, timeoutMs, killScope: 'tree' })
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        timedOut: r.timedOut === true || r.stopped === 'deadline',
        ...(r.spawnError !== undefined ? { spawnError: r.spawnError } : {}),
        ...(r.killSettled instanceof Promise ? { killSettled: r.killSettled } : {}),
      }
    },
  }
}

/** The Claude sign-in ports (WP2 PR 4, owner answers 2026-10-04): the app's
 *  own `claude auth status` probe (the one the Accounts panel uses) and the
 *  sign-out beside it, both keyed by profile and run from the executable the
 *  package hands over; the package resolves a realm to its profile through
 *  the same snapshot read the reviewer uses. */
export const claudeAuthPorts: ClaudeAuthPorts = {
  lookupRealm: (ref) => claudeReviewPorts.lookupRealm(ref),
  readStatus: (profileId, executable) => readClaudeCliAuth(profileId, claudeCliAuthRunner(executable)),
  logout: (profileId, input) => logoutClaudeCli(profileId, { runner: claudeCliAuthRunner(input.executable), acknowledgeComputerSignIn: input.acknowledged === true }),
}

/** Keyed by `ProviderId`, so a provider added to the union but not composed
 *  here is a compile error rather than one that silently never registers.
 *  Exactly one package per provider: the Codex realm locks live in it. */
const PACKAGE_FACTORIES: Readonly<Record<ProviderId, ProviderPackageFactory>> = {
  claude: () => createClaudePackage({ legacyAccountsIo: claudeLegacyAccountsIo, review: claudeReviewPorts, auth: claudeAuthPorts }),
  codex: () => createCodexPackage({ realms: codexRealmSource, auth: { takeSecret: (handle) => takeProviderSecret(handle) }, carryMarksPort }),
}

/** Idempotent against the registry itself (no separate flag that could desync
 *  from a test reset): boot calls it once; a second call is a no-op. Driven
 *  by PROVIDER_IDS rather than a hand-written pair, so it cannot skip a
 *  provider because two others happen to be registered already. */
export function composeProviders(): void {
  for (const id of PROVIDER_IDS) if (!tryGetProviderPackage(id)) registerProviderPackage(PACKAGE_FACTORIES[id]())
}

export function composedProviderIds(): readonly string[] {
  return listProviderPackages().map((p) => p.id)
}

/** At app quit: the headless CLI runs of both providers go through one
 *  runner, and its kills still reading a process table kill what they know
 *  at once rather than leave a CLI running once the app is gone. A
 *  first-start warm-up still running (ADR-025) is ended too. */
export function flushPendingProviderCliKills(): void {
  try { flushFirstStartWarmups() } catch { /* best effort at quit */ }
  flushPendingCodexKills()
}
