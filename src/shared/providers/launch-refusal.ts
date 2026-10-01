// WP2: main refuses every launch of a provider that is switched off (owner
// requirement, 2026-09-25). The refusal as it crosses IPC: a code the
// renderer can branch on and a plain sentence it shows as is. Main decides
// it (AccountsService.launchRefusal, asked through
// src/main/provider-launch-gate.ts); the renderer only reads the answer
// (launchRefusalOf) and never throws it, so a refused launch is said in the
// place it was asked for -- a terminal tab, the SSH overlay, the Cloud Agents
// banner, the Insights page -- rather than surfacing as a generic error.
import type { ProviderId } from '../types'

/** Why a launch was refused: the provider is switched off, the user has not
 *  said yet whether they use it (a provider whose absent value means "not
 *  answered yet", until they answer: owner decision 2026-09-26), main
 *  could not read whether it is on (no answer is never a yes, for a launch),
 *  or the config is not a Multi Spawn config and a copy of it is already
 *  running (`already-running`: pty:spawn's one-at-a-time rule, P3.13). That
 *  last one names the provider the session would have run, though it is not
 *  about the provider: the code is what the renderer branches on. */
export type ProviderLaunchRefusalCode = 'provider-off' | 'provider-not-set-up' | 'provider-state-unknown' | 'already-running'

export const PROVIDER_LAUNCH_REFUSAL_CODES: readonly ProviderLaunchRefusalCode[] = ['provider-off', 'provider-not-set-up', 'provider-state-unknown', 'already-running']

export interface ProviderLaunchRefusal {
  code: ProviderLaunchRefusalCode
  providerId: ProviderId
  /** A plain sentence naming the provider and what to do. */
  message: string
}

/** What a refused entry point answers instead of starting anything. */
export interface ProviderLaunchRefused {
  refused: ProviderLaunchRefusal
}

/** "Claude Code is off. Turn it on in Settings, Accounts." With a purpose,
 *  what turning it on is for: "... in Settings, Accounts to launch this
 *  config." Every provider-off sentence is built here. */
export function providerOffMessage(displayName: string, purpose?: string): string {
  return `${displayName} is off. Turn it on in Settings, Accounts${purpose ? ` ${purpose}` : ''}.`
}

/** "<name> is not set up yet. Set it up in Settings, Accounts." The user has
 *  not said whether they use the provider, so nothing of it starts. With a
 *  purpose, what setting it up is for. */
export function providerNotSetUpMessage(displayName: string, purpose?: string): string {
  return `${displayName} is not set up yet. Set it up in Settings, Accounts${purpose ? ` ${purpose}` : ''}.`
}

/** Main could not read the provider's on/off, so nothing was started. */
export function providerStateUnknownMessage(displayName: string): string {
  return `This app could not read whether ${displayName} is on. Check Settings, Accounts.`
}

/** What a terminal tab whose launch main refused says: "Not started.", the
 *  refusal as main worded it, and what to do once it is sorted. */
export function refusedTabText(refusal: Pick<ProviderLaunchRefusal, 'message'>): string {
  const said = refusal.message.trim().replace(/\.$/, '')
  return `Not started. ${said}, then Restart this tab.`
}

/** The refusal an IPC answer carries, or null when it carries none. Checks
 *  the shape, so anything else an entry point returns reads as no refusal. */
export function launchRefusalOf(value: unknown): ProviderLaunchRefusal | null {
  if (!value || typeof value !== 'object') return null
  const r = (value as { refused?: unknown }).refused
  if (!r || typeof r !== 'object') return null
  const { code, providerId, message } = r as Partial<ProviderLaunchRefusal>
  if (!PROVIDER_LAUNCH_REFUSAL_CODES.includes(code as ProviderLaunchRefusalCode)) return null
  if (typeof providerId !== 'string' || typeof message !== 'string' || message.length === 0) return null
  return { code: code as ProviderLaunchRefusalCode, providerId: providerId as ProviderId, message }
}
