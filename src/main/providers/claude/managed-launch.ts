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
import {
  authorityManifest, CLAUDE_AMBIENT_STRIP, isClaudeSettingsEnvAuthority, authorityEntryFor,
  claudeAuthorityFamilyRules,
  type AuthorityEntry as AuthorityEntryRef,
} from './authority-manifest'
import { summariseNames } from '../../../shared/providers'
import type {
  SanitizedManagedSettings, ManagedCliCompatibility, PreflightFinding,
  ManagedLaunchPreflightInput, ManagedLaunchPreflight, ProjectScanSkipReason,
} from '../../../shared/providers'

/** The host control, applied LAST on every app-managed Claude launch.
 *
 *  Declared as a map rather than a bare name so the core mechanism owns both
 *  the key and the value: a provider patch cannot set it, unset it, or set it
 *  to `0`, and every case-variant is removed before it is written. */
export const CLAUDE_HOST_MANAGED_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
})

/**
 * The authority set is no longer written by hand. It is GENERATED from the
 * pinned Claude binary into `claude-authority-manifest.json` and consumed here.
 *
 * The previous export was a 33-name array maintained by reading the docs and
 * grepping the binary. An adversarial pass recovered the CLI's OWN authority
 * enumerations and found 164 authority-shaped names absent from it -- among them
 * `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_ACCOUNT_UUID` and
 * `CLAUDE_CODE_REMOTE_SETTINGS_PATH`. The defect was the hand-derivation itself,
 * so the fix is structural: re-derive from the CLI, pin the provenance, and make
 * an unclassified new name a hard failure in the generator rather than a silent
 * gap here. See `./authority-manifest.ts` for the scope of the completeness
 * claim -- it is specific to one version, platform and binary digest.
 *
 * Two consumers, and they differ deliberately:
 *   - `CLAUDE_AUTHORITY_ENV_VARIABLES` is the package's `ambientAuthVariables`,
 *     removed from the inherited environment of every managed launch;
 *   - `isClaudeAuthorityEnvVariable` drives `sanitizeClaudeManagedSettings`,
 *     which strips keys from the `env` block of the app-owned settings copy.
 * A transport setting (a corporate `HTTPS_PROXY`, a `NODE_EXTRA_CA_CERTS`) is
 * stripped from the settings copy but KEPT in the ambient environment: removing
 * it would break the user's connectivity without protecting the account.
 */
export type { AuthorityKind, AuthorityEntry } from './authority-manifest'

/** Every classified authority variable, with its kind and provenance. */
export const CLAUDE_AUTHORITY_VARIABLES: readonly AuthorityEntryRef[] = authorityManifest().entries

/** The family rules the manifest was built with. An entry whose `reason` is one
 *  of these ids was ruled by that rule rather than by name, which is allowed
 *  only outside the Claude and Anthropic namespaces. */
export { claudeAuthorityFamilyRules }

/** The ambient strip list, for the package's `ambientAuthVariables`. */
export const CLAUDE_AUTHORITY_ENV_VARIABLES: readonly string[] = CLAUDE_AMBIENT_STRIP

/** Is this key authority-bearing in a settings `env` block?
 *
 *  Case-insensitive on every platform, and prefix-rule aware: the CLI's own
 *  predicate matches open-ended families (`AWS_ENDPOINT_URL*`,
 *  `VERTEX_REGION_CLAUDE_*`) that no enumeration can list. */
export function isClaudeAuthorityEnvVariable(name: string): boolean {
  return isClaudeSettingsEnvAuthority(name)
}

/** Settings keys that make the CLI RUN A COMMAND to produce a CREDENTIAL.
 *
 *  The CLI enumerates its own command-executing keys at ~@196699017:
 *    apiKeyHelper, awsAuthRefresh, awsCredentialExport, fileSuggestion,
 *    gcpAuthRefresh, otelHeadersHelper, processWrapper, policyHelpers,
 *    proxyAuthHelper, statusLine, subagentStatusLine
 *  Of those, these five mint or refresh a credential:
 *
 *   - `apiKeyHelper`        proven: executes from user, project AND local scope,
 *                           and its output goes on the wire as the API key;
 *   - `awsAuthRefresh`      runs a command to refresh AWS credentials;
 *   - `awsCredentialExport` runs a command that emits credentials;
 *   - `gcpAuthRefresh`      confirmed command-executing -- the binary's own
 *                           warning (@104200606) is "Security: gcpAuthRefresh
 *                           executed before workspace trust is confirmed";
 *   - `proxyAuthHelper`     mints a `Proxy-Authorization` header.
 *
 *  WHICH OF THEM THE HOST CONTROL ALSO COVERS, which is not the same question.
 *  Probed on 2026-09-21 with the provider preconditions actually supplied
 *  (loopback endpoints, synthetic values, no real cloud credential):
 *  `awsAuthRefresh`, `awsCredentialExport` and `gcpAuthRefresh` fire without the
 *  host flag and do NOT fire with it -- so for those, as for `apiKeyHelper`, the
 *  flag is the control that reaches project and local scope. `proxyAuthHelper`
 *  fires either way: it is removed from the app-owned copy and NOWHERE else.
 *  That is accepted rather than fixed, because it mints a header for whichever
 *  proxy the environment already selects and the proxy selector is deliberately
 *  preserved (D18 item 1), so it chooses no account, credential or endpoint.
 *  Do not describe the host control as covering all five.
 *
 *  `otelHeadersHelper` is NOT here. It is a telemetry header helper: it does not
 *  select the model account, its credentials or its provider, so it stays (D13
 *  item 3). The remaining command-executing keys -- `fileSuggestion`,
 *  `processWrapper`, `policyHelpers`, `statusLine`, `subagentStatusLine` -- are
 *  unrelated settings and are preserved too (D13 item 4). AICC does not sandbox
 *  code the same OS user can already run (D17). */
export const CLAUDE_CREDENTIAL_HELPER_SETTINGS_KEYS: readonly string[] = Object.freeze([
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'proxyAuthHelper',
])

/** The CLI's four AUTHENTICATION PINS: settings that decide WHICH account, org
 *  or gateway may authenticate at all. The CLI enumerates them together with the
 *  helpers in its own merge description (@104401700).
 *
 *  `forceLoginOrgUUID` is documented as "Organization UUID to require for OAuth
 *  login" -- it decides which account may sign in. `forceLoginMethod` decides
 *  the account TYPE; the binary's messages are "log in with a Claude.ai
 *  subscription account instead" / "...an Anthropic Console account instead".
 *  All four are account authority in a file this app writes, so all four go. */
export const CLAUDE_AUTH_PIN_SETTINGS_KEYS: readonly string[] = Object.freeze([
  'forceLoginMethod',
  'forceLoginOrgUUID',
  'forceLoginGatewayUrl',
  'gatewayInternalNetworks',
])

/** Everything removed WHOLESALE from the app-owned settings copy. */
export const CLAUDE_REMOVED_SETTINGS_KEYS: readonly string[] = Object.freeze([
  ...CLAUDE_CREDENTIAL_HELPER_SETTINGS_KEYS,
  ...CLAUDE_AUTH_PIN_SETTINGS_KEYS,
])

/**
 * EXACT-CASE matching, deliberately -- unlike the `env` block below.
 *
 * Settings keys are ordinary JSON properties and the CLI reads them as such, so
 * its matching is case-SENSITIVE. Probed against 2.1.278: `apiKeyHelper` in
 * user settings executes and its key reaches the wire, while `ApiKeyHelper` and
 * `apikeyhelper` do neither -- the CLI does not see them at all.
 *
 * So a case-insensitive strip would delete keys the CLI ignores. That is not
 * safety, it is editing the user's configuration on a false premise, and the
 * copy is meant to differ from the source only where it must. An `env` block is
 * the opposite case: those are environment variable NAMES, the CLI upper-cases
 * before testing, and Windows resolves them case-insensitively -- so
 * `isClaudeAuthorityEnvVariable` stays case-insensitive.
 */
const REMOVED_SETTINGS_KEYS_EXACT: ReadonlySet<string> = new Set(CLAUDE_REMOVED_SETTINGS_KEYS)

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
 *  a key the user wrote is a bigger change than emptying it.
 *
 *  SCOPE, stated so it is not mistaken for something wider: the TOP-LEVEL `env`
 *  block and the top-level removal keys. A per-server `mcpServers.<name>.env`
 *  is deliberately untouched -- it configures a server the user chose to run,
 *  not Claude's own model authentication, and D17 is explicit that this app
 *  does not police what the same OS user can already run. Worth knowing when
 *  reading the copy, because it is a real place a secret can be typed into the
 *  same file. */
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

/** One sentence per reason the project scan declines or fails to answer. No
 *  instruction: the reader cannot act on any of these, and a dead-end action
 *  is the same defect as a dead-end `action` string. */
const PROJECT_SCAN_SKIP_DETAIL: Record<ProjectScanSkipReason, string> = {
  'network-path': 'The working directory is on a network path, which AI Code Conductor never reads on the launch path because a slow share was measured freezing the app.',
  'scan-outstanding': 'Another project scan was still running when this session started, and only one runs at a time.',
  'thread-ceiling': 'Earlier project scans never returned (a wedged mount holds each one), so this session\'s scan was not started.',
  'timed-out': 'The project scan did not answer within two seconds.',
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
    if (REMOVED_SETTINGS_KEYS_EXACT.has(key)) {
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

  // The stringify is guarded for the same reason the parse is, and it was not.
  // A pretty-printed stringify is O(depth^2) in output size, so a deeply nested
  // settings file well INSIDE any byte cap still costs hundreds of milliseconds
  // of main-thread CPU and hundreds of megabytes of RSS -- and past about 136 KB
  // of input it throws `RangeError: Invalid string length`, which is not a
  // parse error and was not caught anywhere between here and the launch
  // (adversarial round 4). A refusal is the right outcome: the user's settings
  // stop applying to this account and they are told, rather than the home build
  // aborting silently half-done.
  try {
    return { text: `${JSON.stringify(settings, null, 2)}\n`, removed }
  } catch {
    return { text: null, removed: [], refused: 'settings.json is nested too deeply to copy safely' }
  }
}

/**
 * The authority-bearing keys a settings payload CONTAINS -- read-only, and
 * WITHOUT producing a sanitised copy.
 *
 * For files this app does not own (a project's or a repository's), where the
 * question is "what is the host control suppressing here?" and no copy is ever
 * written. `sanitizeClaudeManagedSettings` answers it too, but it also
 * `JSON.stringify`s the result, which that caller throws away -- and a
 * pretty-printed stringify is O(depth^2) in output size, so a deeply nested
 * settings file inside the size cap cost seconds of main-thread CPU per launch
 * (adversarial review, MAJOR). This path does the classification and stops.
 *
 * Names are reported CANONICALLY, as the manifest spells them, never as the
 * file spells them: a key is matched case-insensitively in an `env` block, so a
 * confusable or odd-cased spelling would otherwise be echoed verbatim into a
 * security notice that the user reads as an environment variable name.
 */
export function claudeAuthoritySettingsKeys(raw: string): readonly string[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const settings = parsed as Record<string, unknown>
  const found: string[] = []
  for (const key of Object.keys(settings)) {
    if (REMOVED_SETTINGS_KEYS_EXACT.has(key)) found.push(key)
  }
  const env = settings.env
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const key of Object.keys(env as Record<string, unknown>)) {
      const entry = authorityEntryFor(key)
      if (entry?.settingsEnv === 'strip') found.push(`env.${entry.name}`)
    }
  }
  return [...new Set(found)]
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
  return preflightAgainstControls(input, CLAUDE_HOST_MANAGED_ENV)
}

/**
 * TEST SEAM. The preflight run against a GIVEN set of host controls.
 *
 * The production entry point above always passes the package's own declaration,
 * which has exactly one entry -- so two of the checks below could never be
 * exercised by any test that went through it: the loop "checks EVERY declared
 * control" ran over a one-entry constant, and `host-control-undeclared` was
 * unreachable code with a test name implying otherwise (adversarial review,
 * MINOR). Both are regressions worth catching, so the seam exists to make them
 * reachable rather than to give a caller a second, weaker preflight: nothing in
 * `src/` calls this, and the registry wrapper passes the input alone.
 */
export function _claudeManagedLaunchPreflightAgainstControls(
  input: ManagedLaunchPreflightInput,
  hostManagedEnv: Readonly<Record<string, string>>,
): ManagedLaunchPreflight {
  return preflightAgainstControls(input, hostManagedEnv)
}

function preflightAgainstControls(
  input: ManagedLaunchPreflightInput,
  hostManagedEnv: Readonly<Record<string, string>>,
): ManagedLaunchPreflight {
  const findings: PreflightFinding[] = []
  const env = input.env ?? {}
  const hostEntries = Object.entries(hostManagedEnv)
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
        // The OBSERVED value is deliberately NOT interpolated. This string
        // travels to a renderer surface, and the module's own rule is that a
        // finding names variables and settings KEYS, never their values. The
        // fs-read and JSON-parse paths were both reduced for exactly that
        // reason; this one was not, which made "never a credential value"
        // false as written (adversarial review, MAJOR 6). It is bounded today
        // -- the only host key is our own frozen literal -- but the next host
        // control added to CLAUDE_HOST_MANAGED_ENV inherits this line, and a
        // bound that depends on a constant nobody rechecks is not a bound.
        // That it diverged is the actionable part; what it diverged to is not.
        detail: `${applied[0]} does not carry the value this app applied (expected "${expected}").`,
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
  if (s === 'not-evaluated') {
    // NOT the same as "nothing was removed". The copy is written when the
    // profile home is built, and a launch that did not build one has no result
    // to report -- which silently read as a clean check (adversarial review,
    // MAJOR). Info, because it is a gap in what this report can SAY, not a
    // fault in the session: the host control is applied either way.
    findings.push({
      id: 'settings-copy-not-evaluated',
      severity: 'info',
      title: 'This launch did not check the settings copy for this account',
      // No instruction: the reader cannot act on this, and a dead-end action is
      // the same defect as a dead-end `action` string. It is here to stop the
      // report reading as "checked, all clear", and nothing more.
      detail: 'AI Code Conductor writes a sanitised copy of your shared settings into each account when it builds that account\'s home. This launch did not build one, so this report says nothing about that copy either way.',
    })
  } else if (s?.refused) {
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
      // CAPPED, like the project-key list one function away and for the same
      // reason: this is driven by the user's own settings.json, one authority
      // name under N case variants yields N entries, and the result is stored in
      // a ring, crossed over IPC and rendered as a single list item
      // (adversarial round 4).
      detail: `Removed from the copy AI Code Conductor writes (your own settings.json is unchanged): ${summariseNames(s.removed)}.`,
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
      detail: `Suppressed by ${hostKey} for this session: ${summariseNames(input.repositorySettingsKeys)}. AI Code Conductor does not modify project or repository files.`,
    })
  }
  //    ...and a scan that did NOT answer says so, for the same reason the
  //    settings copy has its third state: the panel reads the newest report,
  //    and a report that was silent about the project read as "this project
  //    carries nothing" -- permanently, for a project on a network path, and
  //    for the newest of two launches spawned in one tick (code-quality review,
  //    MAJOR). Info, not blocking: the host control is applied either way; this
  //    is a gap in what the report can SAY.
  if (input.projectScanSkipped) {
    findings.push({
      id: 'project-settings-not-scanned',
      severity: 'info',
      title: 'This launch did not check the project\'s own settings files',
      detail: `${PROJECT_SCAN_SKIP_DETAIL[input.projectScanSkipped]} Any authority settings the project carries are still suppressed by ${hostKey}; this report just cannot name them.`,
    })
  }

  return { ok: !findings.some((f) => f.severity === 'blocked'), findings, compatibility }
}
