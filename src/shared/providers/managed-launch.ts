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
  /** What the sanitiser removed from the app-owned settings copy.
   *
   *  `'not-evaluated'` is a THIRD state, and it is not the same as omitting the
   *  field. The copy is written when a profile home is BUILT, which not every
   *  launch path does -- so on a fresh process a headless or probe launch has no
   *  result to report, and reporting nothing read as "checked, all clear", which
   *  is a fail-OPEN diagnostic (adversarial review, MAJOR). Omitting the field
   *  still means "this caller is not reporting on the copy at all". */
  sanitizedSettings?: { removed: readonly string[]; refused?: string } | 'not-evaluated'
  /** Ambient authority variables the launch path removed from the inherited
   *  environment. Reported so a wide removal list is never silent. */
  strippedAmbient?: readonly string[]
  /** Authority-bearing keys seen in project/repository-owned settings, if the
   *  caller looked. Reported, never blocking: those files are not the app's to
   *  change, and the host control suppresses them. */
  repositorySettingsKeys?: readonly string[]
  /** Why the project scan did NOT answer for this launch, when it did not.
   *  A third state again, for the same reason as `sanitizedSettings`: the
   *  scan refuses itself on a network path, while another is outstanding, at
   *  the thread ceiling, and at its deadline -- and a report that then said
   *  nothing read exactly like "this project carries nothing" (code-quality
   *  review, MAJOR). Omitted means the scan ran, or nobody asked it to. */
  projectScanSkipped?: ProjectScanSkipReason
}

/** The ways the project-settings scan declines or fails to answer. */
export type ProjectScanSkipReason = 'network-path' | 'scan-outstanding' | 'thread-ceiling' | 'timed-out'

/** At most this many names in one finding's prose or one stored list. Every
 *  such list is driven by a file the user controls (their settings.json, a
 *  project's), is kept in a ring, crosses IPC and is rendered as one list item
 *  -- so it is bounded HERE, once, for every caller. */
export const MAX_REPORTED_NAMES = 20

/** `names`, bounded: the first MAX_REPORTED_NAMES and one trailing
 *  "and N more" element in place of the rest. */
export function boundNames(names: readonly string[]): string[] {
  if (names.length <= MAX_REPORTED_NAMES) return [...names]
  return [...names.slice(0, MAX_REPORTED_NAMES), `and ${names.length - MAX_REPORTED_NAMES} more`]
}

/** A comma-separated list of names, bounded the same way. */
export function summariseNames(names: readonly string[]): string {
  return boundNames(names).join(', ')
}

export interface ManagedLaunchPreflight {
  /** False when at least one `blocked` finding is present. */
  ok: boolean
  findings: readonly PreflightFinding[]
  compatibility: ManagedCliCompatibility
}

/**
 * Whether a managed launch was one the USER asked for, or one the app started
 * by itself -- the `claude auth status` probe behind the Accounts panel, and the
 * headless helper.
 *
 * Shared rather than main-process-only because it crosses the wire: the panel
 * decides which report to show from it, and a renderer-local copy of the field
 * meant `tsc` could not tell if the main process ever stopped sending it
 * (adversarial round 4).
 */
export type ManagedLaunchKind = 'launch' | 'probe'

/** One managed-launch report as it reaches the renderer. The absolute profile
 *  home never crosses -- see the channel comment in the preload. */
export interface ManagedLaunchReport {
  profileId: string
  sessionId: string
  kind: ManagedLaunchKind
  at: number
  preflight: ManagedLaunchPreflight
}
