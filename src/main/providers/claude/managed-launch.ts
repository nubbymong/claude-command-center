// Claude package: the managed-launch security controls (WP1 slice 2).
//
// Four layers, in the order a launch applies them:
//
//   1. STRIP the ambient authority variables an inherited developer
//      environment could carry (CLAUDE_AUTHORITY_ENV_VARIABLES, consumed as
//      the package's `ambientAuthVariables`).
//   2. SANITISE the app-owned copy of the user-scope settings file
//      (`sanitizeClaudeManagedSettings`) -- the app writes that file, so the
//      app is responsible for what is in it.
//   3. APPLY the host control `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` LAST
//      (CLAUDE_HOST_MANAGED_ENV, consumed as the package's `hostManagedEnv`,
//      applied by applyRealmEnvPatch after everything else).
//   4. PREFLIGHT (`claudeManagedLaunchPreflight`) -- a visible diagnostic.
//
// Why layer 3 is load-bearing rather than defence in depth
// -------------------------------------------------------
// Proven against Claude Code 2.1.278 on 2026-09-21 and recorded in
// docs/wp1/evidence/claude-settings-isolation-2026-09-21.md:
//
//   - a USER-scope settings `env` block DOES reach the CLI (finding 1), and
//     that is exactly the file this app writes into every managed profile;
//   - `apiKeyHelper` executes and supplies the credential from USER, PROJECT
//     and LOCAL scope (finding 5) -- it is arbitrary command execution and an
//     account redirect at once;
//   - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` blocks the first and suppresses
//     the second in all three scopes, and fails CLOSED (findings 3, 6);
//   - PROJECT and LOCAL `env` blocks do NOT reach the CLI, but `apiKeyHelper`
//     from those same scopes DOES (finding 7).
//
// Layer 2 cannot cover project or repository-owned settings, because this app
// must never mutate files it does not own. For those scopes layer 3 is the
// ONLY control. That is why it is declared as a host-managed control on the
// package (applied last by the core mechanism, rejectable by nobody) instead
// of being merged into a realm patch a provider could later overwrite.
//
// What is NOT claimed: complete settings-source isolation. Remote /
// organizationally managed settings, mid-session settings mutation, and two
// managed realms with conflicting credentials are manual acceptance items and
// are not locally observable. The preflight is a diagnostic, never the
// boundary -- see `claudeManagedLaunchPreflight`.
import { compareVersions } from '../../../shared/version-order'
import type {
  SanitizedManagedSettings, ManagedCliCompatibility, PreflightFinding,
  ManagedLaunchPreflightInput, ManagedLaunchPreflight,
} from '../../../shared/providers'

/** The host control, applied LAST on every app-managed Claude launch.
 *
 *  Declared as a map rather than a bare name so the core mechanism owns both
 *  the key and the value: a provider patch cannot set it, unset it, or set it
 *  to `0`, and every case-variant is removed before it is written. */
export const CLAUDE_HOST_MANAGED_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
})

/** Where a variable's authority claim comes from. The owner's ruling of
 *  2026-09-20: every entry states whether it is documented, observed in the
 *  pinned binary, or both, so a future version bump can re-derive the list
 *  rather than inherit it on trust. */
export type AuthoritySource = 'official-doc' | 'pinned-binary' | 'both'

export type AuthorityKind =
  /** Selects the config/state root, i.e. WHICH stored identity is read. */
  | 'config-root'
  /** Supplies a credential directly from the environment. */
  | 'credential'
  /** Selects the organization/workspace/profile the credential acts as. */
  | 'federation'
  /** Redirects where the credential is SENT. */
  | 'routing'
  /** Switches the CLI onto a different provider/auth backend entirely. */
  | 'provider-switch'
  /** Undocumented host-integration hooks. Treated as untrusted input (owner
   *  ruling 2026-09-21): never set by this app, always removed if inherited. */
  | 'host-hook'

export interface AuthorityVariable {
  name: string
  kind: AuthorityKind
  source: AuthoritySource
}

/** Every environment variable that can decide WHICH account a Claude Code
 *  process acts as, WHERE its traffic goes, or WHICH stored identity it reads.
 *
 *  Derived 2026-09-21 against Claude Code 2.1.278 (native, commit
 *  `809c980662e3`) and code.claude.com/docs/en/env-vars. Every name below was
 *  confirmed present in that binary; `source` records whether the docs carry
 *  it too.
 *
 *  Two uses, and the distinction matters:
 *    - the whole list is the package's `ambientAuthVariables`, removed from
 *      every managed launch environment;
 *    - the same list drives `sanitizeClaudeManagedSettings`, which strips these
 *      keys -- and ONLY these keys -- from the `env` block of the app-owned
 *      settings copy, leaving every harmless entry in place.
 *
 *  PINNED-VERSION DERIVATION. This is behaviour of 2.1.278, not a permanent
 *  property of the CLI. Re-derive it when the floor moves
 *  (CLAUDE_MIN_MANAGED_CLI_VERSION). */
export const CLAUDE_AUTHORITY_VARIABLES: readonly AuthorityVariable[] = Object.freeze([
  // --- which stored identity is read -------------------------------------
  { name: 'CLAUDE_CONFIG_DIR', kind: 'config-root', source: 'both' },
  // Present in the binary (20 occurrences) and absent from the published env
  // var page -- exactly the kind of entry an official-doc-only list misses.
  { name: 'ANTHROPIC_CONFIG_DIR', kind: 'config-root', source: 'pinned-binary' },

  // --- credentials supplied straight from the environment ----------------
  { name: 'ANTHROPIC_API_KEY', kind: 'credential', source: 'both' },
  { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'credential', source: 'both' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', kind: 'credential', source: 'both' },
  { name: 'ANTHROPIC_IDENTITY_TOKEN', kind: 'credential', source: 'pinned-binary' },
  { name: 'ANTHROPIC_IDENTITY_TOKEN_FILE', kind: 'credential', source: 'pinned-binary' },
  { name: 'ANTHROPIC_AWS_API_KEY', kind: 'credential', source: 'pinned-binary' },
  { name: 'ANTHROPIC_FOUNDRY_API_KEY', kind: 'credential', source: 'pinned-binary' },
  { name: 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', kind: 'credential', source: 'pinned-binary' },
  { name: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'credential', source: 'both' },

  // --- which org/workspace/profile the credential acts as ----------------
  { name: 'ANTHROPIC_FEDERATION_RULE_ID', kind: 'federation', source: 'pinned-binary' },
  { name: 'ANTHROPIC_ORGANIZATION_ID', kind: 'federation', source: 'pinned-binary' },
  { name: 'ANTHROPIC_WORKSPACE_ID', kind: 'federation', source: 'pinned-binary' },
  { name: 'ANTHROPIC_PROFILE', kind: 'federation', source: 'pinned-binary' },

  // --- where the credential is SENT --------------------------------------
  { name: 'ANTHROPIC_BASE_URL', kind: 'routing', source: 'both' },
  { name: 'ANTHROPIC_AWS_BASE_URL', kind: 'routing', source: 'pinned-binary' },
  { name: 'ANTHROPIC_BEDROCK_BASE_URL', kind: 'routing', source: 'both' },
  { name: 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', kind: 'routing', source: 'pinned-binary' },
  { name: 'ANTHROPIC_VERTEX_BASE_URL', kind: 'routing', source: 'both' },
  { name: 'ANTHROPIC_FOUNDRY_BASE_URL', kind: 'routing', source: 'pinned-binary' },
  { name: 'ANTHROPIC_FOUNDRY_RESOURCE', kind: 'routing', source: 'pinned-binary' },
  { name: 'ANTHROPIC_VERTEX_PROJECT_ID', kind: 'routing', source: 'both' },

  // --- which auth backend the CLI uses at all ----------------------------
  { name: 'CLAUDE_CODE_USE_BEDROCK', kind: 'provider-switch', source: 'both' },
  { name: 'CLAUDE_CODE_USE_VERTEX', kind: 'provider-switch', source: 'both' },
  { name: 'CLAUDE_CODE_USE_FOUNDRY', kind: 'provider-switch', source: 'pinned-binary' },
  { name: 'CLAUDE_CODE_USE_MANTLE', kind: 'provider-switch', source: 'pinned-binary' },
  { name: 'CLAUDE_CODE_USE_ANTHROPIC_AWS', kind: 'provider-switch', source: 'pinned-binary' },
  { name: 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', kind: 'provider-switch', source: 'both' },
  { name: 'CLAUDE_CODE_SKIP_VERTEX_AUTH', kind: 'provider-switch', source: 'both' },

  // --- undocumented host-integration hooks -------------------------------
  // Owner ruling 2026-09-21: treat as untrusted. Their contract is not
  // established, so this app never sets one -- but an INHERITED one would be
  // an authority override we did not choose, so all three are stripped. They
  // are removal-only; nothing here grants a way to set them.
  { name: 'CLAUDE_CODE_MANAGED_SETTINGS_PATH', kind: 'host-hook', source: 'pinned-binary' },
  { name: 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', kind: 'host-hook', source: 'pinned-binary' },
  { name: 'CLAUDE_CODE_HOST_CREDS_FILE', kind: 'host-hook', source: 'pinned-binary' },
])

/** The flat name list, for the package's `ambientAuthVariables`. */
export const CLAUDE_AUTHORITY_ENV_VARIABLES: readonly string[] =
  Object.freeze(CLAUDE_AUTHORITY_VARIABLES.map((v) => v.name))

const AUTHORITY_LOWER: ReadonlySet<string> =
  new Set(CLAUDE_AUTHORITY_VARIABLES.map((v) => v.name.toLowerCase()))

/** Is this an authority-bearing environment name?
 *
 *  Case-insensitive on every platform, not only Windows. The CLI reads its
 *  environment through Node, and a settings `env` block is a JSON object whose
 *  keys are written by hand -- `anthropic_api_key` in a poisoned file must not
 *  survive a pass that only knows the canonical spelling. */
export function isClaudeAuthorityEnvVariable(name: string): boolean {
  return typeof name === 'string' && AUTHORITY_LOWER.has(name.toLowerCase())
}

/** Settings keys that make the CLI RUN A COMMAND to obtain a credential or a
 *  request header. Each is removed WHOLESALE from the app-owned copy -- there
 *  is no benign value for one in a file this app writes.
 *
 *  `apiKeyHelper` is the proven case (evidence finding 5: it executes from all
 *  three scopes and its key goes on the wire). The other three are the same
 *  defect class -- a settings-file-supplied command line -- and are present in
 *  the pinned binary; they are removed on that basis alone. Removing a key
 *  from THIS APP'S OWN COPY is safe whether or not the CLI would have honoured
 *  it, whereas leaving one in is a hole if it does.
 *
 *  Scope note: this is a DELTA from the literal wording of the 2026-09-21
 *  instruction, which named `apiKeyHelper` alone. Recorded so the owner can
 *  narrow it back to one key if they prefer the literal scope. */
export const CLAUDE_COMMAND_HELPER_SETTINGS_KEYS: readonly string[] = Object.freeze([
  'apiKeyHelper',        // proven: executes from user/project/local scope
  'awsAuthRefresh',      // present in 2.1.278; runs a command to refresh AWS creds
  'awsCredentialExport', // present in 2.1.278; runs a command that emits creds
  'otelHeadersHelper',   // present in 2.1.278; runs a command that supplies headers
])

const HELPER_LOWER: ReadonlySet<string> =
  new Set(CLAUDE_COMMAND_HELPER_SETTINGS_KEYS.map((k) => k.toLowerCase()))

/** Sanitise the APP-OWNED copy of a user-scope `settings.json` before it is
 *  written into a managed profile home.
 *
 *  Contract, exactly as the owner specified it on 2026-09-21:
 *    - command/credential helper keys are removed ENTIRELY;
 *    - inside `env`, ONLY authority-bearing entries are removed;
 *    - every other `env` entry and every unrelated setting is preserved;
 *    - the SOURCE file is never touched. This function is pure: it takes text
 *      and returns text. The shared settings file the user edits, and any
 *      project- or repository-owned settings, are out of reach by construction.
 *
 *  An `env` block left empty by the pass is kept as an empty object rather than
 *  deleted: the difference is visible to anyone diffing the copy, and deleting
 *  a key the user wrote is a bigger change than emptying it. */
/** Reduce a `JSON.parse` failure to a POSITION, discarding the message text.
 *
 *  V8 quotes a window of the source in its error ("Unexpected token 's',
 *  ...\"API_KEY\": sk-ant-api\"... is not valid JSON"). That message travels
 *  from here into a `blocked` preflight finding, over IPC, and onto the
 *  Accounts panel -- so interpolating it verbatim puts a slice of the user's
 *  settings file, credential line included, on a screen. A half-edited API key
 *  is one of the likelier ways to malform that file in the first place.
 *
 *  The position is the useful part and carries no content, so keep only that. */
function jsonErrorPosition(e: unknown): string {
  const m = /at position (\d+)(?:\s*\(line (\d+) column (\d+)\))?/.exec((e as Error)?.message ?? '')
  if (!m) return ''
  return m[2] ? ` at line ${m[2]}, column ${m[3]}` : ` at position ${m[1]}`
}

export function sanitizeClaudeManagedSettings(raw: string): SanitizedManagedSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { text: null, removed: [], refused: `settings.json is not valid JSON${jsonErrorPosition(e)}` }
  }
  // `null` is valid JSON and typeof null === 'object'; an array is an object
  // too. Neither is a settings file, and neither can be sanitised meaningfully.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text: null, removed: [], refused: 'settings.json is not a JSON object' }
  }
  const settings = parsed as Record<string, unknown>
  const removed: string[] = []

  for (const key of Object.keys(settings)) {
    if (HELPER_LOWER.has(key.toLowerCase())) {
      delete settings[key]
      removed.push(key)
    }
  }

  const env = settings.env
  // Only a plain object is an `env` block. Anything else is left exactly as it
  // is: it is not ours to interpret, and the CLI will reject it on its own.
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const envObj = env as Record<string, unknown>
    for (const key of Object.keys(envObj)) {
      if (isClaudeAuthorityEnvVariable(key)) {
        delete envObj[key]
        removed.push(`env.${key}`)
      }
    }
  }

  return { text: `${JSON.stringify(settings, null, 2)}\n`, removed }
}

// ---------------------------------------------------------------------------
// Minimum compatible CLI version
// ---------------------------------------------------------------------------

/** The oldest Claude Code this app will treat as enforcing the host control.
 *
 *  2.1.278 is the version the control was PROVEN on (evidence doc, rounds 1-3).
 *  It is a floor of evidence, not of capability: the control may well work in
 *  earlier releases, but nothing here has tested one, and the owner's ruling of
 *  2026-09-21 is that the floor stays at the proven version until an earlier
 *  one is independently proven. Lowering it means re-running the probe matrix
 *  against that version and recording the result beside the 2.1.278 rows. */
export const CLAUDE_MIN_MANAGED_CLI_VERSION = '2.1.278'

/** Classify an observed CLI version against the floor.
 *
 *  An UNPARSEABLE version is `too-old`, not `unknown`: we have an answer and it
 *  is not a version we can vouch for, so it gets the upgrade requirement rather
 *  than the softer "not probed yet" state. `unknown` means exactly one thing --
 *  no probe has returned. */
export function claudeManagedCliCompatibility(found: string | null | undefined): ManagedCliCompatibility {
  const required = CLAUDE_MIN_MANAGED_CLI_VERSION
  if (found === null || found === undefined || found.trim() === '') {
    return {
      state: 'unknown',
      required,
      found: null,
      message: `Claude Code's version has not been probed yet, so multi-account isolation cannot be confirmed. AI Code Conductor requires ${required} or newer for managed multi-account sessions.`,
    }
  }
  const version = found.trim()
  if (compareVersions(version, required) >= 0) {
    // "at or above the verified version", NOT "isolation works". The latter is
    // a claim gate A1 has not yet supported, and this string is user-facing.
    return { state: 'supported', required, found: version, message: `Claude Code ${version} is at or above ${required}, the version the host isolation control was verified on.` }
  }
  return {
    state: 'too-old',
    required,
    found: version,
    message: `Claude Code ${version} is older than ${required}, the oldest version host-managed account isolation has been verified on. Update Claude Code (\`claude update\`, or re-run the native installer) before relying on multiple accounts in AI Code Conductor.`,
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** A visible diagnostic for one managed launch.
 *
 *  THIS IS NOT THE SECURITY BOUNDARY, and no caller may treat a clean result as
 *  "isolated". It reports only what is locally observable, and the sources that
 *  matter most are not: remote / organizationally managed settings are fetched
 *  from the server for a signed-in account, and settings can change after the
 *  process has started. The boundary is the host control itself
 *  (CLAUDE_HOST_MANAGED_ENV), which the core mechanism applies last and which
 *  fails closed. The preflight's job is to make a MISSING control loud, and to
 *  show the user what the sanitiser took out. */
export function claudeManagedLaunchPreflight(input: ManagedLaunchPreflightInput): ManagedLaunchPreflight {
  const findings: PreflightFinding[] = []
  const env = input.env ?? {}
  const hostEntries = Object.entries(CLAUDE_HOST_MANAGED_ENV)
  const hostKey = hostEntries[0]?.[0] ?? 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'

  // 1. Was the control actually applied to the environment being spawned?
  //
  //    EVERY declared entry is checked, not just the first. The declaration has
  //    one entry today; reading only `[0]` would mean a second control added
  //    later went unchecked, and an EMPTY declaration -- the regression that
  //    disables the whole mechanism -- would destructure `undefined` and throw
  //    where the caller swallows it. An empty declaration is itself a finding.
  if (hostEntries.length === 0) {
    findings.push({
      id: 'host-control-undeclared',
      severity: 'blocked',
      title: 'Account isolation declares no host control at all',
      detail: 'The Claude provider package declares an empty set of host-managed controls, so nothing prevents a settings file from redirecting this session.',
      action: 'Report this: it is a fault in AI Code Conductor, not in your configuration.',
    })
  }
  for (const [key, expected] of hostEntries) {
    // Read case-insensitively so a launch path that lower-cased its keys is
    // reported honestly rather than flagged as missing.
    const applied = Object.entries(env).find(([k]) => k.toLowerCase() === key.toLowerCase())
    if (!applied) {
      findings.push({
        id: 'host-control-missing',
        severity: 'blocked',
        title: 'Account isolation control was not applied',
        detail: `${key} is absent from this session's environment. Without it, a settings file can redirect the session to a different account or run a command of its choosing.`,
        action: 'Report this: it indicates a fault in AI Code Conductor, not in your configuration. Sessions started this way are not account-isolated.',
      })
    } else if (applied[1] !== expected) {
      findings.push({
        id: 'host-control-altered',
        severity: 'blocked',
        title: 'Account isolation control carries an unexpected value',
        detail: `${applied[0]} is "${String(applied[1])}", expected "${expected}".`,
        action: 'Report this: something overwrote a host-managed control after it was applied.',
      })
    }
  }

  // 2. Is the CLI new enough for the control to be one we have verified?
  const compatibility = claudeManagedCliCompatibility(input.cliVersion ?? null)
  if (compatibility.state === 'too-old') {
    findings.push({
      id: 'cli-below-floor',
      severity: 'blocked',
      title: `Claude Code ${compatibility.found} is below the verified floor`,
      detail: compatibility.message,
      action: `Update Claude Code to ${compatibility.required} or newer.`,
    })
  } else if (compatibility.state === 'unknown') {
    findings.push({
      id: 'cli-version-unverified',
      severity: 'blocked',
      title: 'Claude Code version not yet verified',
      detail: compatibility.message,
      action: `Run \`claude --version\` in a terminal and confirm it reports ${compatibility.required} or newer. If AI Code Conductor cannot find the CLI at all, check that \`claude\` is on the PATH your login shell uses.`,
    })
  }

  // 3. What did the sanitiser do to the app-owned copy?
  const s = input.sanitizedSettings
  if (s?.refused) {
    findings.push({
      id: 'settings-copy-refused',
      severity: 'blocked',
      title: 'The shared settings file could not be sanitised',
      detail: `${s.refused} No settings copy was written into this account's home, so the session starts without your shared settings.`,
      action: 'Fix the JSON in your shared settings.json, then restart the session.',
    })
  } else if (s && s.removed.length > 0) {
    findings.push({
      id: 'settings-copy-sanitised',
      severity: 'info',
      title: 'Authority settings were removed from this account\'s settings copy',
      detail: `Removed from the copy AI Code Conductor writes (your own settings.json is unchanged): ${s.removed.join(', ')}.`,
    })
  }

  // 4. What did the ambient strip take out of the inherited environment?
  //    Reported because it is otherwise SILENT and the list is wide: it
  //    includes the endpoint and provider-switch variables, so a developer
  //    who routes Claude through Bedrock, Vertex or a corporate proxy by
  //    exporting `ANTHROPIC_BASE_URL` will find managed sessions behaving
  //    differently from their own shell with nothing to explain why. `info`,
  //    never blocking -- removing these is the point of the layer.
  if (input.strippedAmbient?.length) {
    findings.push({
      id: 'ambient-authority-stripped',
      severity: 'info',
      title: 'Authority variables from your environment were not passed to this session',
      // No "set these per account instead" -- there is no per-account
      // environment feature to point at, and a dead-end instruction is the
      // same defect as a dead-end action string.
      detail: `Removed so they cannot override the account this session runs as: ${input.strippedAmbient.join(', ')}. Your own shell is unchanged.`,
    })
  }

  // 5. Project/local settings: reported, never blocking. The owner's ruling of
  //    2026-09-21 is explicit -- a launch must not be refused because a
  //    repository carries settings the proven mechanism already suppresses.
  if (input.repositorySettingsKeys?.length) {
    findings.push({
      id: 'repository-settings-suppressed',
      severity: 'info',
      title: 'This project carries settings that could redirect the account',
      detail: `Suppressed by ${hostKey} for this session: ${input.repositorySettingsKeys.join(', ')}. AI Code Conductor does not modify project or repository files.`,
    })
  }

  return { ok: !findings.some((f) => f.severity === 'blocked'), findings, compatibility }
}
