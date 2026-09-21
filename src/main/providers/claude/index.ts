// Claude provider package: public entry point (WP1, design 7.1). Everything
// outside this directory imports from here; the dependency-boundary test
// ratchets the remaining deep imports down to zero.
import type { SshCapableProvider, SpawnOptions, TelemetrySource, HistorySession } from '../types'
import type { LegacyVersion, StatuslineData } from '../../../shared/types'
import type { ProviderCapabilities } from '../../../shared/providers'
import type { ProviderPackage } from '../core'
import { resolveClaudeBinary, buildClaudeLocalSpawn } from './spawn'
import { getRemoteSetupCommand, remoteSessionSettingsPath, remoteSessionMcpConfigPath } from './ssh-shim'
import { detectClaudeUi } from './ui-detection'
import { deployClaudeStatuslineScript, deployClaudeResumePickerScript } from './statusline'
import { watchClaudeStatuslineFile, listClaudeResumableSessions } from './telemetry'
import {
  CLAUDE_AUTHORITY_ENV_VARIABLES, CLAUDE_HOST_MANAGED_ENV, CLAUDE_MIN_MANAGED_CLI_VERSION,
  sanitizeClaudeManagedSettings, claudeManagedLaunchPreflight,
} from './managed-launch'

// The managed-launch surface is re-exported so the composition root and the
// conformance suite reach it through this entry point, never by deep import.
export {
  CLAUDE_AUTHORITY_VARIABLES, CLAUDE_AUTHORITY_ENV_VARIABLES, CLAUDE_HOST_MANAGED_ENV,
  CLAUDE_COMMAND_HELPER_SETTINGS_KEYS, CLAUDE_MIN_MANAGED_CLI_VERSION,
  isClaudeAuthorityEnvVariable, sanitizeClaudeManagedSettings,
  claudeManagedCliCompatibility, claudeManagedLaunchPreflight,
} from './managed-launch'
export type { AuthorityKind, AuthoritySource, AuthorityVariable } from './managed-launch'

export class ClaudeProvider implements SshCapableProvider {
  readonly id = 'claude' as const
  readonly displayName = 'Claude Code'

  resolveBinary(legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null {
    return resolveClaudeBinary(legacyVersion)
  }

  // Filled in subsequent tasks (P0.5, P0.6, P0.8)
  buildSpawnCommand(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> } {
    if (opts.ssh) throw new Error('SSH spawn handled by configureRemoteSettings -- see P0.5')
    return buildClaudeLocalSpawn(opts)
  }
  detectUiRunning(data: string): boolean {
    return detectClaudeUi(data, true)  // post-spawn convenience: assume claudeSent
  }
  ingestSessionTelemetry(
    sessionId: string,
    _opts: { cwd: string; spawnTimestamp: number },
    onUpdate: (data: StatuslineData) => void,
  ): TelemetrySource {
    // Claude telemetry arrives via the statusline file watcher (opts unused).
    return watchClaudeStatuslineFile(sessionId, onUpdate)
  }
  async listHistorySessions(): Promise<HistorySession[]> {
    return listClaudeResumableSessions()
  }
  resumeCommand(sessionId: string): { cmd: string; args: string[] } {
    const { cmd } = resolveClaudeBinary()
    return { cmd, args: ['--resume', sessionId] }
  }
  async configureMcpServer(_cfg: { name: string; url: string }): Promise<void> {
    // Conductor MCP now flows per-session via --mcp-config (writeLocalSessionMcpConfig);
    // there is no global ~/.claude.json injection. This method exists for future
    // provider parity (e.g. Codex MCP) but has no active callers yet.
  }
  getSshSettingsPath(sessionId: string): string {
    return remoteSessionSettingsPath(sessionId)
  }
  getSshMcpConfigPath(sessionId: string): string {
    return remoteSessionMcpConfigPath(sessionId)
  }
  configureRemoteSettings(
    sessionId: string,
    remotePath: string,
    hooksConfig: { port: number; secret: string } | null,
    opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number } | undefined,
    nonce: string,
  ): string {
    return getRemoteSetupCommand(sessionId, remotePath, hooksConfig, opts, nonce)
  }
  async deployStatuslineScript(resourcesDir: string): Promise<void> {
    return deployClaudeStatuslineScript(resourcesDir)
  }
  async deployResumePickerScript(resourcesDir: string): Promise<void> {
    return deployClaudeResumePickerScript(resourcesDir)
  }
}

/** What Claude Code supports through this app, stated honestly (design 7.3).
 *  A key is `supported` only once this package exposes the operation behind
 *  it (registration enforces that), so the setup/auth/realm keys stay
 *  `unknown` until the Claude adapter slice wires them. Account isolation is
 *  the existing profile-home mechanism (owner decision D1); it is not
 *  available on macOS, where the login keychain is located through $HOME
 *  (D2, WP1 only). No tested CLI version range is declared yet: the range is
 *  established by the D7 conformance evidence (dev host: Claude Code 2.1.278). */
export const claudeCapabilities: ProviderCapabilities = {
  'cli.discovery': { state: 'unknown', note: 'wired in the Claude adapter slice' },
  'install.recipes': { state: 'unknown', note: 'the official native installer, shown and copied, never scraped; wired in the Claude adapter slice' },
  'auth.browser': { state: 'unknown', note: 'the genuine CLI login in a Conductor terminal; wired in the Claude adapter slice' },
  'auth.device': { state: 'unsupported', note: 'Claude Code has no device-code sign-in' },
  'auth.apiKey': { state: 'unsupported', note: 'managed accounts use the CLI sign-in; an API key is never collected' },
  'auth.status': { state: 'unknown', note: 'wired in the Claude adapter slice' },
  'auth.logout': { state: 'unknown', note: 'wired in the Claude adapter slice' },
  'realm.isolated': { state: 'unknown', platformOverrides: { darwin: 'unsupported' }, note: 'profile homes; not on macOS in WP1 (D2); wired in the Claude adapter slice' },
  'account.labelFields': { state: 'unknown', note: 'email read from the profile identity file; wired in the Claude adapter slice' },
  'account.usage': { state: 'unknown', note: 'the per-account usage fetch lives in src/main/usage, not on this package; wired in a later slice' },
  'session.launch': { state: 'supported' },
  'session.history': { state: 'supported', note: 'resume picker and history listing' },
  'session.cloud': { state: 'unknown', note: 'cloud agents run through cloud-agent-manager, not through the provider package; wired in a later slice' },
  'session.ssh': { state: 'supported' },
}

/** Ambient variables that could override a bound Claude realm (D3).
 *
 *  Slice 1 carried four names and left an open question beside them: do the
 *  authority/cloud switches (`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`,
 *  ...) belong here, given they redirect where a credential GOES rather than
 *  which realm is read? The owner's ruling of 2026-09-21 answers it -- yes:
 *  a session pointed at an attacker's endpoint is not isolated merely because
 *  it read the right stored login. The full derived, classified list now lives
 *  in ./managed-launch, one entry per variable with its authority kind and
 *  whether it is documented, observed in the pinned binary, or both. */
export const claudeAmbientAuthVariables: readonly string[] = CLAUDE_AUTHORITY_ENV_VARIABLES

/** Variables the realm patch may set: the profile-home selector, and HOME as
 *  its POSIX sibling (D1). Nothing else.
 *
 *  Three things withProfileHome also sets are deliberately NOT here, for one
 *  reason: a realm patch can only REPLACE a variable wholesale, and none of
 *  them is a realm selector.
 *  - PATH: withProfileHome APPENDS <home>/.local/bin to the inherited PATH, so
 *    a system binary still wins. Owning it would hand the package the child's
 *    whole executable search order -- the PATH hijack this contract forbids.
 *  - GIT_CONFIG_GLOBAL and npm_config_userconfig: withProfileHome points these
 *    at the REAL home ("keep git/npm reading the real shared config",
 *    src/main/account-profiles.ts), i.e. deliberately OUTSIDE the realm. They
 *    take an arbitrary absolute path, and a git config file executes commands
 *    (core.pager, core.sshCommand, alias.*, filter.*), so owning them would be
 *    the PATH hijack one indirection later.
 *  All three stay in the launch path, where withProfileHome already composes
 *  them. Registration refuses them (NEVER_OWNED_LAUNCH_VARIABLES). */
export const claudeOwnedLaunchVariables: readonly string[] = ['USERPROFILE', 'HOME']

/** Created by the composition root; importing this entry point has no side effects. */
export function createClaudePackage(): ProviderPackage {
  const session = new ClaudeProvider()
  return {
    id: session.id,
    displayName: session.displayName,
    session,
    capabilities: claudeCapabilities,
    ambientAuthVariables: claudeAmbientAuthVariables,
    ownedLaunchVariables: claudeOwnedLaunchVariables,
    // The proven control (evidence 2026-09-21). Applied LAST by
    // applyRealmEnvPatch; a realm patch that names it is refused.
    hostManagedEnv: CLAUDE_HOST_MANAGED_ENV,
    managedLaunch: {
      minimumCliVersion: CLAUDE_MIN_MANAGED_CLI_VERSION,
      sanitizeManagedSettings: sanitizeClaudeManagedSettings,
      preflight: claudeManagedLaunchPreflight,
    },
  }
}
