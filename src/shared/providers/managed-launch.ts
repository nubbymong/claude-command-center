// WP1 provider core: the provider-neutral SHAPES of managed-launch hardening.
//
// The shapes live here; the values and the behaviour live in each provider
// package (provider core never imports a concrete provider). So the launch
// path, the IPC layer and the renderer can all speak about "what the preflight
// found" without knowing which CLI it was about.
//
// The hardening itself is three things the host does to a launch it manages:
//   - it removes the provider's ambient authority variables (RealmEnvPolicy);
//   - it applies the provider's host-managed controls LAST (RealmEnvPolicy);
//   - it sanitises any settings file the APP ITSELF writes into the realm.
// The preflight below REPORTS on all three. It does not perform any of them,
// and a clean preflight never means "isolated" -- see ManagedLaunchPreflight.

export interface SanitizedManagedSettings {
  /** The text to write, or null when nothing may be written (see `refused`). */
  text: string | null
  /** Settings paths removed, dotted (`apiKeyHelper`, `env.ANTHROPIC_API_KEY`). */
  removed: readonly string[]
  /** Set when the input could not be sanitised and therefore must NOT be
   *  copied. Fail closed: a file we cannot parse is a file we cannot vouch
   *  for, and copying it unchanged would carry whatever is in it into the
   *  managed realm. */
  refused?: string
}

/** How a provider's minimum verified CLI version compares to what is installed.
 *  `unknown` means exactly one thing: no probe has returned yet. */
export type ManagedCliCompatibilityState = 'supported' | 'too-old' | 'unknown'

export interface ManagedCliCompatibility {
  state: ManagedCliCompatibilityState
  required: string
  found: string | null
  /** User-facing and actionable. Never "unsupported" with no next step. */
  message: string
}

/** `blocked` marks a control that is missing or unverifiable. `info` records
 *  something the proven mechanism handles: reported so the user can see what
 *  was done, never a reason to fail a launch. */
export type PreflightSeverity = 'info' | 'blocked'

export interface PreflightFinding {
  id: string
  severity: PreflightSeverity
  title: string
  detail: string
  /** What the user can do about it. Present on every `blocked` finding. */
  action?: string
}

export interface ManagedLaunchPreflightInput {
  /** The FINAL composed launch environment, exactly as it will be spawned. */
  env: Readonly<Record<string, string | undefined>>
  /** The observed CLI version, or null when no probe has answered. */
  cliVersion?: string | null
  /** What the sanitiser removed from the app-owned settings copy. */
  sanitizedSettings?: { removed: readonly string[]; refused?: string }
  /** Ambient authority variables the launch path removed from the inherited
   *  environment. Reported so a wide removal list is never silent. */
  strippedAmbient?: readonly string[]
  /** Authority-bearing keys seen in project/repository-owned settings, if the
   *  caller looked. Reported, never blocking: those files are not the app's to
   *  change, and the host control suppresses them. */
  repositorySettingsKeys?: readonly string[]
}

export interface ManagedLaunchPreflight {
  /** False when at least one `blocked` finding is present. */
  ok: boolean
  findings: readonly PreflightFinding[]
  compatibility: ManagedCliCompatibility
}
