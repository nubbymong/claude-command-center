// Claude package: the managed-launch controls (WP1 slice 2, corrected 2026-09-22).
//
// Four layers, in the order a launch applies them:
//
//   1. STRIP the ambient authority variables an inherited developer
//      environment could carry (CLAUDE_AUTHORITY_ENV_VARIABLES, consumed as
//      the package's `ambientAuthVariables`).
//   2. SANITISE the app-owned copy of the user-scope settings file
//      (`sanitizeClaudeManagedSettings`) -- the app writes that file, so the
//      app is responsible for what is in it. Never the shared source, never a
//      repository's files.
//   3. GATE the launch on the project's own settings files
//      (`claudeAuthoritySettingsKeys`, run by the launch gate in
//      src/main/managed-launch-diagnostics.ts): a `.claude/settings.json` or
//      `settings.local.json` in the working directory that carries a
//      credential helper, an account pin, a provider switch or an endpoint
//      redirect REFUSES the launch before it starts, naming the file and the
//      key and never the value. Those files are not this app's to change, and
//      this app has no control that makes them safe to launch under.
//   4. PREFLIGHT (`claudeManagedLaunchPreflight`) -- the visible record of
//      what the three layers did, including the refusal.
//
// Why there is no host control any more
// -------------------------------------
// Slice 2 first applied `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` last on every
// managed launch: proven on 2.1.278 to block user-scope settings `env`
// injection and to suppress `apiKeyHelper` in every scope (evidence Parts 1
// to 6). Gate A1 then measured that the same flag makes the CLI read NO stored
// login -- it is Claude Desktop's mode, in which the host application supplies
// and rotates the token -- so a managed session could not sign in (Part 7). An
// alternative, presenting the session as a Claude Desktop entrypoint, was
// probed and rejected: it still executes `apiKeyHelper`, leaves user scope
// unfiltered, and attributes every request to Claude Desktop (Part 8). The
// owner's correction: keep the supported launch model (USERPROFILE/HOME realm
// plus the realm roots), do not make this app a credential host, and refuse
// rather than suppress. This app now sets no flag the CLI would read as
// "managed by a host".
//
// What is measured about repository-owned settings on 2.1.278 (Part 8, without
// any flag): a PROJECT or LOCAL `env` block DOES redirect the endpoint and DOES
// switch the provider, and `apiKeyHelper` from either scope executes and
// supplies the credential. That is why the gate refuses rather than warns.
//
// What is NOT claimed, and is recorded as a boundary rather than prevented:
// settings edited after the session started; remote / organisation-managed
// settings the CLI fetches for a signed-in account; another process of the same
// OS user acting on the realm; and a project directory the gate cannot read
// safely (a network path), which launches with a warning rather than a
// refusal. Guaranteeing against those needs a credential host, which is a
// separate design and was explicitly not authorised.
import { compareVersions } from '../../../shared/version-order'
import {
  authorityManifest, CLAUDE_AMBIENT_STRIP, isClaudeSettingsEnvAuthority, authorityEntryFor,
  claudeAuthorityFamilyRules,
  type AuthorityEntry as AuthorityEntryRef,
} from './authority-manifest'
import { summariseNames, stripLeadingBom } from '../../../shared/providers'
import type {
  SanitizedManagedSettings, ManagedCliCompatibility, PreflightFinding,
  ManagedLaunchPreflightInput, ManagedLaunchPreflight, ProjectScanSkipReason,
} from '../../../shared/providers'

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
 *  All five are removed from the app-owned copy (layer 2) and all five REFUSE
 *  a launch when a project or local settings file declares one (layer 3).
 *  There is no longer a host control that suppresses any of them at run time:
 *  the probes of 2026-09-21 that showed the flag suppressing four of the five
 *  are history (evidence Parts 1 and 5), and the flag is gone (Part 7).
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
  'thread-ceiling': 'Earlier project checks never returned (a wedged mount holds each one), so this session\'s check could not be started in time.',
  'timed-out': 'The project settings check did not answer within its deadline.',
}

export function sanitizeClaudeManagedSettings(raw: string): SanitizedManagedSettings {
  let parsed: unknown
  try {
    // A leading BOM is dropped exactly as the CLI drops it (see stripLeadingBom):
    // the copy is meant to apply wherever the source would have.
    parsed = JSON.parse(stripLeadingBom(raw))
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
 * question is "does this file carry something that would redirect the launch?"
 * and no copy is ever written -- the launch gate's question. `sanitizeClaudeManagedSettings` answers it too, but it also
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
  // The parse mirrors the CLI's (pinned 2.1.278): a leading BOM dropped, then
  // a STRICT JSON.parse -- no comments, no trailing commas. A file the CLI
  // cannot parse is one it does not apply, so "unparseable" is honestly
  // nothing here; a file it CAN parse and this could not was the gap
  // (adversarial review, design lens).
  try { parsed = JSON.parse(stripLeadingBom(raw)) } catch { return [] }
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

/** The oldest Claude Code this app will run a managed multi-account launch on.
 *
 *  2.1.278 is the version everything here was MEASURED on: which settings
 *  scopes reach the request path, which variables redirect the realm and the
 *  stores (the authority manifest is censused from that binary), and that the
 *  realm roots keep a stored login signed in. It is a floor of evidence, not
 *  of capability: an earlier release may behave the same, but nothing here has
 *  tested one, and the owner's ruling of 2026-09-21 is that the floor stays at
 *  the measured version until an earlier one is independently proven. */
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
    return { state: 'supported', required, found: version, message: `Claude Code ${version} is at or above ${required}, the version managed multi-account launches were verified on.` }
  }
  return {
    state: 'too-old',
    required,
    found: version,
    message: `Claude Code ${version} is older than ${required}, the oldest version managed multi-account launches have been verified on. Update Claude Code (\`claude update\`, or re-run the native installer) before relying on multiple accounts in AI Code Conductor.`,
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** The visible record of one managed launch.
 *
 *  THIS IS NOT A PROOF OF ISOLATION, and no caller may treat a clean result as
 *  "isolated". It reports what the launch did and what it could observe: the
 *  CLI floor, what the sanitiser removed from the app-owned copy, what the
 *  ambient pass stripped, and what the project gate decided -- a refusal
 *  included, so the panel can say why a session did not start. What it cannot
 *  observe is recorded as a boundary in the module header, not implied here. A
 *  finding names files, variables and settings KEYS, never a value. */
export function claudeManagedLaunchPreflight(input: ManagedLaunchPreflightInput): ManagedLaunchPreflight {
  const findings: PreflightFinding[] = []

  // 1. Is the CLI a version this launch model was measured on?
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

  // 2. What did the sanitiser do to the app-owned copy?
  const s = input.sanitizedSettings
  if (s === 'not-evaluated') {
    // NOT the same as "nothing was removed". The copy is written when the
    // profile home is built, and a launch that did not build one has no result
    // to report -- which silently read as a clean check (adversarial review,
    // MAJOR). Info, because it is a gap in what this report can SAY, not a
    // fault the user can act on.
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

  // 3. What did the ambient strip take out of the inherited environment?
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
      // Bounded like every other name list that reaches the panel.
      detail: `Removed so they cannot override the account this session runs as: ${summariseNames(input.strippedAmbient)}. Your own shell is unchanged.`,
    })
  }

  // 4. Project/local settings: a detectable override REFUSES the launch (owner
  //    decision, 2026-09-22, reversing the 2026-09-21 ruling that a launch must
  //    not be refused for settings the host control suppressed -- there is no
  //    host control now). The keys are named, file and key, never a value; the
  //    files are never modified.
  if (input.repositorySettingsKeys?.length) {
    findings.push({
      id: 'repository-settings-refused',
      severity: 'blocked',
      title: 'This project carries settings that could redirect the account, so the session was not started',
      detail: `Found in the project's own settings files: ${summariseNames(input.repositorySettingsKeys)}. AI Code Conductor does not modify project or repository files, and has no control that makes a managed session safe to start under them.`,
      action: 'Remove those keys from the project\'s .claude/settings.json or settings.local.json (or move them to your own shared settings, which AI Code Conductor sanitises per account), then start the session again. A session outside a managed account is not gated.',
    })
  }
  //    A verdict is a verdict FOR the directories it was formed for. When the
  //    launch's directory turned out to be another one, the launch is refused
  //    and recorded as such -- a refusal the terminal printed and the panel
  //    could not show was a refusal half-reported (spec review, MINOR).
  if (input.launchDirectoryUnverified) {
    findings.push({
      id: 'launch-directory-unverified',
      severity: 'blocked',
      title: 'The session\'s directory changed while its project settings were being checked, so the session was not started',
      detail: `The session would have run in ${input.launchDirectoryUnverified}, which is not one of the directories the check covered.`,
      action: 'Start the session again; the check runs afresh for the directory it will use.',
    })
  }
  //    ...and a gate that did NOT answer says so, as a WARNING rather than a
  //    refusal: a network path is never read on the launch path, a wedged
  //    mount or a slow one can exhaust the ceiling or the deadline, and the
  //    launch goes ahead with the project's settings UNCHECKED. That is a
  //    recorded boundary, and the report must not read as "checked, clean"
  //    (code-quality review, MAJOR; owner decision, 2026-09-22).
  if (input.projectScanSkipped) {
    findings.push({
      id: 'project-settings-not-scanned',
      severity: 'warning',
      title: 'This session started without its project settings files being checked',
      detail: `${PROJECT_SCAN_SKIP_DETAIL[input.projectScanSkipped]} If that directory's .claude/settings.json or settings.local.json carries a credential helper, an account pin, a provider switch or an endpoint redirect, this session is using it.`,
      action: 'Check those two files yourself, or start the session from a local directory.',
    })
  }

  return { ok: !findings.some((f) => f.severity === 'blocked'), findings, compatibility }
}
