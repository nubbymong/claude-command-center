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
import type { ClaudeLegacyAccountsIo, ClaudeReviewPorts } from './claude'
import { createCodexPackage, cliCommandLine, codexShellEnv, runCodexCli, defaultCodexRunDeps } from './codex'
import type { CodexRealmSource } from './codex'
import { findRealm } from '../../shared/providers'
import { readProfilesStrict, updateProfilesStrict, mkdirSecure, profileRealmLaunch, profileReviewRefusal, recordProfileReviewPreflight } from '../account-profiles'
import { holdProfileForRun } from '../profile-consumers'
import { resolveClaudeExecutable } from '../claude-cli-version'
import { readConfigChecked } from '../config-manager'
import { getAccountRegistry, getAccountRegistryResourcesDir } from '../provider-account-registry'
import { takeProviderSecret } from '../provider-accounts'

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
  lookup: async (ref) => {
    const doc = getAccountRegistry()?.current()
    const realm = doc ? findRealm(doc, ref.authRealmId) : undefined
    const resourcesDir = getAccountRegistryResourcesDir()
    // Only a realm being set up or in use: a retired one (an archived
    // account's) may name the same external home a newer account now uses,
    // and nothing may run there on the old record's behalf.
    const live = realm?.lifecycle === 'pending' || realm?.lifecycle === 'active'
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
}

/** Keyed by `ProviderId`, so a provider added to the union but not composed
 *  here is a compile error rather than one that silently never registers.
 *  Exactly one package per provider: the Codex realm locks live in it. */
const PACKAGE_FACTORIES: Readonly<Record<ProviderId, ProviderPackageFactory>> = {
  claude: () => createClaudePackage({ legacyAccountsIo: claudeLegacyAccountsIo, review: claudeReviewPorts }),
  codex: () => createCodexPackage({ realms: codexRealmSource, auth: { takeSecret: (handle) => takeProviderSecret(handle) } }),
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
