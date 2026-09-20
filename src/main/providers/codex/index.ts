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
export const CODEX_PINNED_VERSION = '0.155.1'
export const CODEX_MINIMUM_VERSION_CANDIDATE = '0.153.4'
export const codexCapabilities: ProviderCapabilities = {
  'cli.discovery': { state: 'unknown', note: 'wired in the Codex adapter slice' },
  'install.recipes': { state: 'unknown', note: 'npm package @openai/codex, shown and copied, never scraped; wired in the Codex adapter slice' },
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

/** Ambient variables that could override a bound Codex realm (D3): the home
 *  override and the API key the CLI prefers over its stored login. Reviewed
 *  2026-09-20 against codex-cli 0.153.4 / 0.155.1. OPENAI_BASE_URL redirects
 *  the authority rather than the realm; open owner question, see slice 1. */
export const codexAmbientAuthVariables: readonly string[] = ['CODEX_HOME', 'OPENAI_API_KEY']

/** The Codex realm patch sets the home and nothing else. CODEX_HOME appears
 *  in BOTH lists on purpose: it is stripped from the inherited environment as
 *  an ambient override, then re-set to the bound realm. That double listing is
 *  now required -- the ambient list is no longer implicitly settable. */
export const codexOwnedLaunchVariables: readonly string[] = ['CODEX_HOME']

/** Created by the composition root; importing this entry point has no side effects. */
export function createCodexPackage(): ProviderPackage {
  const session = new CodexProvider()
  return {
    id: session.id,
    displayName: session.displayName,
    session,
    capabilities: codexCapabilities,
    ambientAuthVariables: codexAmbientAuthVariables,
    ownedLaunchVariables: codexOwnedLaunchVariables,
  }
}
