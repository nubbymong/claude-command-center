// Disposition POLICY for the generated Claude authority manifest.
//
// Maintainer-owned, checked in, consulted ONLY by
// scripts/gen-claude-authority-manifest.mjs. Nothing in src/ imports this file;
// the manifest it produces is what the app reads.
//
// WHAT THIS FILE IS, AND IS NOT
// -----------------------------
// The manifest's ENTRY LIST is a CENSUS of ONE pinned binary -- Claude Code
// 2.1.278, win32-x64, sha256
// 006ea5c8638f67f10a5ae66bb232fd267c9f6af294e3f03f4cfcf1fd3f2cced8 -- produced
// by the sources named in `provenance.extractedFrom`. It is NOT a completeness
// claim for any other version or platform, and not one in the absolute either:
// two review rounds have each found a read form the census could not see, and a
// name ASSEMBLED AT RUNTIME from fragments cannot be found by any literal scan.
// That residual is stated rather than closed.
//
// This file is the separate, deliberate question: what should AICC actually DO
// with each one. A census entry is NOT a policy -- see D3 below.
//
// The two are not the same, and the difference matters. "The CLI calls it
// authority" is not a reason to remove a variable from a developer's
// environment. The removal rule is D3, whose four items the owner numbered as
// D18 (both labels appear below; they are the same rule):
//
//   A variable is removed only when it can INDEPENDENTLY override the selected
//   account, credential source, provider or model endpoint.
//
// Two ways a name earns removal under that rule:
//
//   1. It is Claude/Anthropic-specific -- a direct credential override, an
//      account or organization pin, a provider-selection switch, a
//      Claude-specific endpoint override, or a configuration root that redirects
//      the managed realm. (D18 item 3.)
//
//   2. It is shared with other tools AND a probe proved it redirects Claude's
//      model authentication on its own, with every provider selector removed.
//      (D18 items 2 and 4.) Nothing has met this bar -- see PROBE below.
//
// PROBE (2026-09-21, Claude Code 2.1.278, win32-x64)
// --------------------------------------------------
// Three capture servers; provider read from the CLI's own debug log.
//   positive controls -- selector PRESENT:
//     CLAUDE_CODE_USE_BEDROCK + AWS creds  -> "bedrock model=us.anthropic.claude-opus-5"
//     CLAUDE_CODE_USE_VERTEX  + GCP creds  -> "vertex model=claude-opus-5"
//   selector ABSENT, every row -> "firstParty model=claude-opus-5[1m]", traffic
//   to the Anthropic endpoint only:
//     AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN + AWS_ENDPOINT_URL_BEDROCK_RUNTIME
//     AWS_PROFILE + AWS_SHARED_CREDENTIALS_FILE + AWS_CONFIG_FILE
//     GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT + vertex endpoint
//     AWS_ENDPOINT_URL* with no credentials and no selector
//     AWS_BEARER_TOKEN_BEDROCK
// Conclusion: the provider selector is the necessary switch. A shared credential
// or SDK endpoint variable cannot redirect Claude once the selectors are gone.
//
// WHY PRESERVING THEM IS THE SAFER CHOICE, NOT THE LAXER ONE
// ----------------------------------------------------------
// Claude's Bash/PowerShell tools INHERIT this environment. Stripping
// AWS_PROFILE, GOOGLE_APPLICATION_CREDENTIALS or HTTPS_PROXY would stop the
// agent running `aws`, `gcloud` or anything behind a corporate proxy -- breaking
// the product to defend against a redirect the probe shows cannot happen.
import { createHash } from 'node:crypto'
import { CLI_OWNED_CENSUS_RULINGS, CLI_OWNED_CENSUS_FRAGMENTS } from './claude-authority-census-rulings.mjs'

export const MANIFEST_SCHEMA_VERSION = 2

/**
 * The digest covers the ENTRIES and the extraction provenance only -- never the
 * binary path or a timestamp -- so the same binary always yields the same digest
 * and the manifest can be validated with no binary present. The census figures
 * are in it (adversarial round 8): the validator's count invariant compares
 * `census.cliOwned` with the entries, and a number the digest did not cover
 * could be edited to match whatever the entries were edited to.
 */
export function canonicalManifestDigest(manifest) {
  const c = manifest.provenance.census
  const canonical = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    cliVersion: manifest.provenance.cliVersion,
    platform: manifest.provenance.platform,
    binarySha256: manifest.provenance.binarySha256,
    prefixRules: manifest.provenance.prefixRules,
    cliOwnedNamespaces: manifest.provenance.cliOwnedNamespaces ?? null,
    census: c ? { names: c.names, authorityShaped: c.authorityShaped, cliOwned: c.cliOwned, fragments: c.fragments, digest: c.digest } : null,
    entries: manifest.entries.map((e) => [e.name, e.kind, e.settingsEnv, e.ambient, e.sources.join('|')]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Where `name` occurs in `text` as a STANDALONE environment name that is read,
 * or -1.
 *
 * This backs the generator's presence assertion for a `repo-added` name -- one
 * this repo classifies although neither CLI enumeration lists it. A bare
 * `indexOf` was not enough: it would pass on `CLAUDE_CODE_X` when the binary
 * only ever contains `CLAUDE_CODE_X_LEGACY`, or when the name appears solely in
 * a help string, and give false confidence exactly as that list grows.
 *
 * So both halves are required:
 *   - a WORD BOUNDARY on each side, so a longer identifier does not count;
 *   - a READ pattern nearby (`process.env`, an `env` index, a Set membership
 *     test, the CLI's `toUpperCase()` fold), so a mention is not an occurrence.
 *
 * Exported and pure so it can be unit-tested against synthetic text, with no
 * Claude binary present -- the generator itself cannot be tested that way.
 */
export function repoAddedOccurrence(text, name) {
  const WORD = /[A-Za-z0-9_]/
  const READ = /(process\.env|\.env\b|env\[|\.has\(|toUpperCase\(\))/
  let i = -1
  while ((i = text.indexOf(name, i + 1)) !== -1) {
    const before = i > 0 ? text[i - 1] : ''
    const after = text[i + name.length] ?? ''
    if (WORD.test(before) || WORD.test(after)) continue
    if (READ.test(text.slice(Math.max(0, i - 120), i + name.length + 120))) return i
  }
  return -1
}

const group = (names, spec) => Object.fromEntries(names.map((n) => [n, spec]))

/**
 * The namespaces that are the CLI's OWN -- Claude Code's, Anthropic's, and the
 * prefixes the CLI itself coins for its proxy, its session ingress, its remote
 * (CCR) sessions and its OAuth environment switches. A name in one of these is
 * never settled by a family rule: it is ruled by name or the generator fails.
 *
 * DECLARED ONCE. The generator builds the census namespace list from it, writes
 * it into the manifest as `provenance.cliOwnedNamespaces`, and the runtime
 * validator and the WP1 suite check that copy against this one -- so the census
 * cannot again treat a prefix as the CLI's own while the exact-ruling rule does
 * not. Everything else the census looks at (AWS, GOOGLE, OTEL, MCP_, ...) is a
 * third party's and belongs under the family rules.
 *
 * Pinned: Claude Code 2.1.278, win32-x64. A new CLI prefix is added HERE.
 */
export const CLI_OWNED_NAMESPACES = ['CLAUDE', 'ANTHROPIC', 'ANT_', 'CCR_', 'AGENT_PROXY', 'SESSION_INGRESS', 'USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH']
export const CLI_OWNED_NAMESPACE_RE = new RegExp(`^(${CLI_OWNED_NAMESPACES.join('|')})`)

/**
 * Does this name have to be ruled on BY NAME, rather than by family?
 *
 * Two triggers.
 *
 * 1. The CLI's OWN namespaces, always -- every prefix in CLI_OWNED_NAMESPACES.
 *    Not a three-item list. That list was `CLAUDE|ANTHROPIC`, then
 *    `CLAUDE|ANTHROPIC|ANT_`, and each time a namespace the census already
 *    treated as the CLI's own was missing from it -- `AGENT_PROXY_AUTH_TOKEN` is
 *    stripped as a Claude credential while a hypothetical
 *    `AGENT_PROXY_AUTH_TOKEN_V2` would have been family-ruled keep with no hard
 *    failure. The census and this rule now read ONE constant (adversarial
 *    round 6, third occurrence of the same defect). A family rule is a
 *    pattern, and a pattern is how a list stops being read: for the names that
 *    decide which Claude account a session runs as, each one gets an individual
 *    ruling and an individual reason, and a new one is a hard failure until
 *    someone writes them. Everything else -- a third-party SDK's credential, a
 *    loader path, a bundled dependency's constant -- is a decision this repo has
 *    already taken once, and restating it 245 times would make the file
 *    unreadable without making it truer.
 *
 * 2. `opts.cliSecret` -- the CLI lists this name among its OWN secrets
 *    (generator source 7). The prefix test alone was not enough, and the gap was
 *    exploitable rather than theoretical: `ENVIRONMENT_SERVICE_KEY` is a Claude
 *    credential that wears no Claude prefix, so rule 1 let the
 *    `third-party-dev-credential` family swallow it and rule it KEEP on both
 *    axes (adversarial round 4). A pattern cannot know which member of its
 *    family is a Claude credential under another name. The CLI can, so its own
 *    designation is what decides whether a name may be family-ruled at all.
 *
 * `opts` is optional so that a caller with no source information -- a test, or
 * a direct question about one name -- still gets rule 1.
 */
export function requiresExactRuling(name, opts = {}) {
  return CLI_OWNED_NAMESPACE_RE.test(name) || opts.cliSecret === true
}

// --- removed: Claude/Anthropic-specific account authority (D18 item 3) ------
const CLAUDE_CREDENTIAL = {
  kind: 'claude-credential',
  settingsEnv: 'strip',
  ambient: 'strip',
  reason: 'a direct Claude/Anthropic credential override -- an inherited value authenticates as an account the user did not select',
}
const ACCOUNT_PIN = {
  kind: 'account-pin',
  settingsEnv: 'strip',
  ambient: 'strip',
  reason: 'pins the account, organization, workspace or scope the credential acts as',
}
const PROVIDER_SWITCH = {
  kind: 'provider-switch',
  settingsEnv: 'strip',
  ambient: 'strip',
  reason: 'the provider selector itself -- proved by probe to be the necessary switch that redirects model authentication',
}
const CLAUDE_ENDPOINT = {
  kind: 'claude-endpoint',
  settingsEnv: 'strip',
  ambient: 'strip',
  reason: 'a Claude-specific endpoint override: it redirects where Claude sends the selected account\'s credential',
}
const CLAUDE_REALM_ROOT = {
  kind: 'claude-realm-root',
  settingsEnv: 'strip',
  ambient: 'strip',
  reason: 'a configuration or state root that redirects the managed realm, i.e. which stored Claude identity is read',
}
const HOME_ROOT = {
  kind: 'claude-realm-root',
  settingsEnv: 'strip',
  ambient: 'replace',
  reason: 'the fake-home mechanism sets this deliberately; host-managed values are applied last and cannot be overwritten',
}
const POSIX_HOME_SELECTOR = {
  kind: 'posix-home-selector',
  settingsEnv: 'strip',
  ambient: 'keep',
  reason: 'the POSIX home. On Linux the realm patch owns it and overwrites the inherited value; on win32 the pinned CLI ignores it in favour of USERPROFILE (measured, 2.1.278) and on macOS the realm is deliberately not redirected, so it is KEPT there for D3 fidelity -- Git Bash and every POSIX tool resolve ~ from it. Pinned-binary evidence, not a contract: a CLI that began honouring HOME on Windows would make this a hole',
}
const SUPERSEDED_CONFIG_ROOT = {
  kind: 'superseded-config-root',
  settingsEnv: 'strip',
  ambient: 'keep',
  reason: 'a shared OS config root that could select the Anthropic profile store, but is OUTRANKED by ANTHROPIC_CONFIG_DIR, which the realm patch owns and sets; kept from the ambient environment because gh, npm and git read it for their own configuration and D3 preserves that (adversarial round 4)',
}

const HOST_HOOK = {
  kind: 'host-hook',
  settingsEnv: 'strip',
  ambient: 'strip',
  reason: 'a Claude host-integration hook: this app never sets it, and an inherited one is an authority override it did not choose',
}

// --- preserved: not independently account-redirecting (D18 items 1, 2, 4) ---
const DEV_TOOL_CREDENTIAL = {
  kind: 'dev-tool-credential',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'an ordinary AWS/Azure/GCP SDK credential; probed NOT to redirect Claude with the provider selectors removed, and Claude\'s Bash tools need it to run aws/gcloud',
}
const SHARED_SDK_CONFIG = {
  kind: 'shared-sdk-config',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'shared cloud-SDK configuration used by many tools; probed NOT to redirect Claude on its own once the provider selectors are removed',
}
const TRANSPORT = {
  kind: 'transport',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'generic transport and corporate trust configuration required for connectivity; it selects no account and cannot change which identity authenticates',
}
const RUNTIME = {
  kind: 'runtime',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'Node runtime configuration; it selects no account, and AICC does not sandbox code the same OS user can already run',
}
const MODEL_SELECTION = {
  kind: 'model-selection',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'selects which model answers, not which account authenticates',
}
const OPERATIONAL = {
  kind: 'operational',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'telemetry or timeout behaviour with no bearing on account, credential, provider or endpoint',
}
const CHILD_HELPER_CHANNEL = {
  kind: 'child-helper-channel',
  settingsEnv: 'strip',
  ambient: 'strip',
  reason: 'the CLI passes this into a helper it spawns through a CONDITIONAL spread of the ambient environment, so where the CLI has no value of its own the inherited one reaches a helper that mints a credential -- capable of changing credentials under D3',
}

// --- preserved: found by the census, ruled by D3, and KEPT ------------------
// D3 removes what can override the selected account, credential, provider or
// endpoint. It does not remove everything a census finds, and it does not
// remove secrets that redirect nothing: an interactive session inherits the
// developer's environment, so a needless strip is a cost with no benefit. Each
// kind below names what the variable actually does, so the decision can be
// re-argued from the reason rather than re-derived from the binary.
const CLI_SET_CHILD_VARIABLE = {
  kind: 'cli-set-child-variable',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'the CLI ASSIGNS this unconditionally into a child process\'s environment from its own verified state, so an inherited value is overwritten before anything reads it and cannot select an account, credential, provider or endpoint (D3)',
}
const NON_REDIRECTING_SECRET = {
  kind: 'non-redirecting-secret',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'a secret the CLI uses to VERIFY something inbound rather than to authenticate itself outbound; it selects no account, credential, provider or endpoint, and D3 removes redirection rather than secrecy',
}
const NON_REDIRECTING_IDENTIFIER = {
  kind: 'non-redirecting-identifier',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'an identifier carried inside a request that a SEPARATE credential authorises; with that credential removed it selects nothing, and it cannot attribute work outside the environment the credential already grants (D3)',
}
const NON_REDIRECTING_SINK = {
  kind: 'non-redirecting-sink',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'names a directory the CLI WRITES its own diagnostics to; it selects no account, credential, provider or endpoint. Residual, recorded rather than used to justify a strip: an inherited value decides where a transcript lands, which is a confidentiality question and not an isolation one',
}
const NON_REDIRECTING_ENDPOINT = {
  kind: 'non-redirecting-endpoint',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'an endpoint for a non-model service (feature flags, changelog); it carries no account credential and is not a provider endpoint, so it cannot redirect where the selected account authenticates (D3)',
}
const NON_REDIRECTING_SUBCOMMAND_CREDENTIAL = {
  kind: 'non-redirecting-subcommand-credential',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'an Anthropic-side credential read only by a SUBCOMMAND a managed interactive launch never runs, so it cannot redirect the selected realm (D3). Ruled separately from the third-party group because that group\'s reason -- "it authenticates that tool, not Claude" -- is false of this one',
}
const NON_REDIRECTING_OPERATOR_SWITCH = {
  kind: 'non-redirecting-operator-switch',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'an opt-in a developer sets in their own shell to enable a CLI feature; it selects no account, credential, provider or endpoint, so D3 preserves it, and removing it would break that feature inside a managed session while the CLI names the variable the user did set',
}
const NON_REDIRECTING_EXEC_PATH = {
  kind: 'non-redirecting-exec-path',
  settingsEnv: 'keep',
  ambient: 'keep',
  reason: 'names an executable or script the CLI runs. A command-execution primitive, the same accepted class as PATH and CLAUDE_CODE_GIT_BASH_PATH under D17 -- this app does not sandbox code the same OS user can already run -- and it redirects no authority, so D3 preserves it',
}

// The D3 clause each KEEP kind's ruling rests on. A ruling made with `each`
// below, or composed from the census table, carries the reviewer's finding
// for the name plus this clause, so its reason reads as one argument: what
// the CLI does with an inherited value, and why that is not a redirect. The
// strip kinds keep their canonical reason verbatim.
const D3_CLAUSE = {
  'cli-set-child-variable': 'assigned unconditionally by the CLI from its own state, so an inherited value is overwritten before anything reads it (D3)',
  'non-redirecting-identifier': 'an identifier a separate credential authorises; with that credential removed it selects nothing (D3)',
  'non-redirecting-sink': 'a location the CLI only writes to; it selects no account, credential, provider or endpoint (D3)',
  'non-redirecting-endpoint': 'a non-model endpoint carrying no account credential; not where the selected credential is sent (D3)',
  'non-redirecting-exec-path': 'command execution under the same OS user, the accepted D17 class; it redirects no authority',
  'non-redirecting-operator-switch': 'an operator opt-in that selects no account, credential, provider or endpoint (D3)',
  'non-redirecting-secret': 'used to verify something inbound, never sent as Claude\'s own credential (D3)',
  'transport': 'transport configuration that selects no account and cannot change which identity authenticates (D18 item 1)',
  'runtime': 'runtime configuration that selects no account; this app does not sandbox code the same OS user can already run (D17)',
  'model-selection': 'selects which model answers, not which account authenticates',
  'operational': 'selects no account, credential, provider or endpoint, so D3 preserves it',
}
/** A group whose members each carry their OWN finding: `{ NAME: what }`. The
 *  reason is the finding plus the kind's D3 clause. Used where a shared reason
 *  was found FALSE of a member -- "telemetry or timeout behaviour" was the
 *  reason of record for a bash executable path and for a key in the OAuth
 *  constants object (spec review, adversarial round 8). */
const each = (spec, findings) => Object.fromEntries(
  Object.entries(findings).map(([n, what]) => [n, { ...spec, reason: `${what} -- ${D3_CLAUSE[spec.kind] ?? spec.reason}` }]),
)

export const AUTHORITY_CLASSIFICATION = {
  ...group(
    [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY',
      'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
      'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
      'CLAUDE_CODE_OAUTH_CLIENT_ID', 'CLAUDE_CODE_OAUTH_SCOPES',
      'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
      'CLAUDE_BRIDGE_OAUTH_TOKEN', 'CLAUDE_CODE_ARTIFACTS_API_TOKEN',
      'CLAUDE_CODE_MEMORY_API_TOKEN', 'CLAUDE_CODE_HOST_CREDS_FILE',
    ],
    CLAUDE_CREDENTIAL,
  ),

  ...group(
    [
      'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
      'ANTHROPIC_WORKSPACE_ID', 'ANTHROPIC_PROFILE', 'ANTHROPIC_SCOPE',
      'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_AWS_WORKSPACE_ID',
      'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
    ],
    ACCOUNT_PIN,
  ),

  ...group(
    [
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
      'CLAUDE_CODE_SKIP_FOUNDRY_AUTH', 'CLAUDE_CODE_SKIP_MANTLE_AUTH',
      'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH', 'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
    ],
    PROVIDER_SWITCH,
  ),

  ...group(
    [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_BEDROCK_REGION_PREFIX',
      'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
      'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'ANTHROPIC_GOOGLE_CLOUD_LOCATION',
      'ANTHROPIC_GOOGLE_CLOUD_PROJECT', 'ANTHROPIC_UNIX_SOCKET',
      'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
      'CLAUDE_CODE_API_BASE_URL', 'CLAUDE_CODE_CUSTOM_OAUTH_URL',
      'CLAUDE_CODE_ARTIFACTS_API_BASE_URL', 'CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL',
      'CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL', 'CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL',
      'CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL', 'CLAUDE_CODE_MEMORY_API_BASE_URL',
      'CLAUDE_BRIDGE_BASE_URL', 'CLAUDE_BRIDGE_SESSION_INGRESS_URL',
      'CLAUDE_REMOTE_TOOLS_BRIDGE_URL', 'CLAUDE_LOCAL_OAUTH_API_BASE',
      'CLAUDE_LOCAL_OAUTH_APPS_BASE', 'CLAUDE_LOCAL_OAUTH_CONSOLE_BASE',
      'USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH',
      '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
    ],
    CLAUDE_ENDPOINT,
  ),

  ...group(
    [
      'CLAUDE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'CLAUDE_CODE_FEDERATION_CACHE_DIR',
      // Selects the credential STORE the CLI reads and writes on Windows, which
      // is the same question as which stored identity a managed launch
      // resolves -- so it belongs with the other realm roots. A `repo-added`
      // name: the CLI reads it before either extracted filter is consulted, so
      // neither enumeration lists it and the extraction alone would miss it.
      'CLAUDE_CODE_FORCE_WINDOWS_CREDMAN',
    ],
    CLAUDE_REALM_ROOT,
  ),
  // `replace` means: the realm patch SETS this, so it is not stripped -- a
  // host-managed value is applied last and an inherited one cannot survive it.
  // That is only true of a variable the Claude package actually OWNS
  // (`claudeOwnedLaunchVariables`), and a name here that nothing owns is a
  // silent hole rather than a policy.
  //
  // It was one. APPDATA and XDG_CONFIG_HOME carried this ruling while the
  // package owned only USERPROFILE and HOME, so they were neither stripped NOR
  // replaced -- and on Windows the SDK resolves its profile store as
  // ANTHROPIC_CONFIG_DIR, then %APPDATA%\Anthropic, and only then
  // %USERPROFILE%\AppData\Roaming\Anthropic, so APPDATA decided which stored
  // identity was read (adversarial round 4).
  //
  // The fix sets the FIRST key instead of owning the second. ANTHROPIC_CONFIG_DIR
  // is consulted first and returns immediately, so owning it isolates the store
  // whatever APPDATA says.
  // HOME and USERPROFILE only. `replace` means the patch SETS this instead of
  // removing it, and that is right for these two because removing HOME on a
  // platform where the patch does not set it (macOS) would leave the child with
  // no home at all.
  //
  // ANTHROPIC_CONFIG_DIR is deliberately NOT here, although the patch owns and
  // sets it. It stays `strip` on both axes, which the removal pass applies
  // unconditionally, and the patch then sets it where this app has a value --
  // `settable` comes from the owned list and the removal from the ambient list,
  // so the two do not conflict. `replace` would have been a hole on macOS,
  // where profileRealmConfigRoot is null: nothing would set it and nothing
  // would remove it, so a poisoned ambient value would survive where it used
  // to be stripped (adversarial round 4).
  // STATED LIMIT on HOME. USERPROFILE is set on every platform this app
  // redirects. HOME is set only on LINUX: on win32 the CLI ignores it (measured
  // against the pinned binary -- with HOME and USERPROFILE pointed at different
  // directories, the config directory followed USERPROFILE and nothing was
  // created under HOME), and on macOS it is deliberately left at the real home
  // for the keychain. So on those two platforms HOME is neither stripped nor
  // set, which is the SHAPE of the APPDATA defect. It is kept here knowingly:
  // stripping HOME breaks Git Bash and every POSIX tool the Bash tool runs, and
  // the measurement says it redirects nothing on win32. That is pinned-binary
  // evidence, not a contract -- a CLI that starts honouring HOME on Windows
  // would make this a hole, and revalidation is what would find it
  // (adversarial round 5).
  // USERPROFILE alone is `replace`: the patch sets it on every platform it
  // redirects, so 'the realm patch SETS this' is simply true of it.
  'USERPROFILE': HOME_ROOT,
  // HOME is NOT `replace`, because that would be false on two platforms of
  // three -- which is precisely how APPDATA carried a ruling nothing honoured.
  // It is kept from the ambient environment and says why; on Linux the patch
  // owns it and overwrites the inherited value, which needs no ruling to allow.
  'HOME': POSIX_HOME_SELECTOR,

  // ...and APPDATA and XDG_CONFIG_HOME are then SUPERSEDED rather than taken.
  // They are stripped from a settings `env` block, because a settings file has
  // no business introducing a config root; they are KEPT from the ambient
  // environment, because that is where `gh` keeps its OAuth tokens, npm its
  // cache and global prefix, and git its XDG-style config -- the developer
  // configuration D3 says an interactive session inherits. Removing them would
  // break the Bash tool to defend a redirect the owned first key already wins.
  ...group(['APPDATA', 'XDG_CONFIG_HOME'], SUPERSEDED_CONFIG_ROOT),

  // The three remote/managed names are INERT in 2.1.278 -- probed, and the
  // override reader is a stub in that build. They stay because their inactivity
  // is pinned-version evidence, not a contract. (owner ruling, D16 item 8)
  ...group(
    [
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
      'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS',
      'CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'CLAUDE_CODE_REMOTE_SETTINGS_PATH',
      'CLAUDE_CODE_MOCK_REMOTE_SETTINGS', 'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION',
      'CLAUDE_CODE_ENVIRONMENT_KIND', 'CLAUDE_CODE_REMOTE_SESSION_ID',
    ],
    HOST_HOOK,
  ),

  // --- preserved -----------------------------------------------------------
  ...group(
    [
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_PROFILE',
      'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES',
    ],
    DEV_TOOL_CREDENTIAL,
  ),

  ...group(
    [
      'AWS_REGION', 'AWS_DEFAULT_REGION',
      'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_STS', 'AWS_ENDPOINT_URL_SSO',
      'AWS_ENDPOINT_URL_SSO_OIDC', 'AWS_ENDPOINT_URL_BEDROCK',
      'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
      'AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
      'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'GCE_METADATA_ROOT',
      'METADATA_SERVER_DETECTION', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_QUOTA_PROJECT', 'CLOUD_ML_REGION', 'CLOUDSDK_CONFIG',
    ],
    SHARED_SDK_CONFIG,
  ),

  ...group(
    [
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
      'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
      'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY',
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'CLAUDE_CODE_CERT_STORE',
      'CLAUDE_CODE_PROXY_RESOLVES_HOSTS', 'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER',
      'CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS',
    ],
    TRANSPORT,
  ),

  ...group(['NODE_OPTIONS'], RUNTIME),

  ...group(
    [
      'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
      'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
      'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
      'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME', 'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
      'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_BEDROCK_SERVICE_TIER',
      'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
      'CLAUDE_CODE_AUTO_MODE_MODEL', 'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
      'CLAUDE_CODE_3P_PROBE_WROTE_OPUS_DEFAULT', 'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT',
    ],
    MODEL_SELECTION,
  ),
  // --- the session/bridge CARRIER set (extraction source 5) ----------------
  // The CLI's own list of environment names it carries across its session
  // boundary. It is not a settings filter, which is why neither of the other
  // two anchors reaches it -- and it is where the account IDENTITY names live.
  //
  // These three are read straight off `process.env` and decide who the session
  // IS, so they are account authority by the plain reading of D18 item 3:
  //   CLAUDE_CODE_ACCOUNT_UUID       account-identity fallback in getUserId
  //   CLAUDE_CODE_ORGANIZATION_UUID  becomes an X-Organization request header
  //   CLAUDE_CODE_USER_EMAIL         identity attribution for the session
  // The two BRIDGE_OWNER_* names are the same question asked about the parent
  // session, and CCR_SESSION_PROFILE selects which stored session profile is
  // used, so all six are pins.
  ...group(
    [
      'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL',
      'CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID', 'CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID',
      'CCR_SESSION_PROFILE',
    ],
    ACCOUNT_PIN,
  ),
  // Bearer tokens the session carries. A token is a credential whatever it is
  // addressed to, and neither name is shared with other developer tooling, so
  // removing them costs nothing.
  ...group(['AGENT_PROXY_AUTH_TOKEN', 'CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN'], CLAUDE_CREDENTIAL),
  // Where the session's own traffic goes.
  ...group(['AGENT_PROXY_URL', 'SESSION_INGRESS_URL'], CLAUDE_ENDPOINT),
  // A settings-source pointer: it redirects where a child session reads its
  // configuration from, the same class as the managed/remote settings paths.
  ...group(['CLAUDE_CODE_BRIDGE_CHILD_MACHINE_SETTINGS'], CLAUDE_REALM_ROOT),
  // Proxy relay behaviour. Transport, by the same D18 item 1 reasoning as
  // HTTPS_PROXY: it selects no account and cannot change which identity
  // authenticates, and stripping it would break connectivity for no gain.
  ...group(
    [
      'CCR_AGENT_PROXY_ENABLED', 'CCR_AGENT_PROXY_RELAY_MODE', 'CCR_AGENT_PROXY_INCLUDE_HOSTS',
      'CCR_AGENT_PROXY_RECEIVE_GATE_DISABLED', 'CCR_AGENT_PROXY_UPLOAD_GATE_DISABLED',
      'CCR_AGENT_PROXY_NO_PROXY_LOCAL_ONLY', 'CCR_AGENT_PROXY_FRAME_HOSTS',
    ],
    TRANSPORT,
  ),
  // Everything else in the carrier set: session plumbing, sync toggles,
  // timeouts and feature switches. None of them names an account, a credential,
  // a provider or an endpoint, and D17 is explicit that this app does not
  // restrict what Claude Code may otherwise do.
  ...each(OPERATIONAL, {
    CLAUDE_CODE_REMOTE: "marks the process as a cloud (CCR/byoc) session: it raises NODE_OPTIONS --max-old-space-size to 8192 at entry, and gates hermetic mode, artifact/pin availability, auto-memory and startup-timing emission",
    CLAUDE_CODE_REMOTE_HERMETIC_MODE: "with CLAUDE_CODE_REMOTE, puts the cloud session in hermetic mode, which refuses hook and plugin forwarding and the home-settings seed",
    CLAUDE_CODE_BRIDGE_CHILD_AUTO_DEFAULT: "marks the process as a bridge child whose permission mode defaults to auto; the bridge sets it in the child env it builds (alongside modePinned/autoDefault) and clears it otherwise",
    CLAUDE_CODE_BRIDGE_CHILD_ARTIFACT: "marks the process as a bridge child that may use the Artifact tool (read beside CLAUDE_CODE_ARTIFACT in the sdk_default_off test); reading it also makes the CLI scrub the bridge-child markers from subprocess environments",
    CLAUDE_CODE_BRIDGE_MCP_CARRIER: "marks the process as the bridge's MCP carrier child ('1') or a descendant of one, which makes the CLI scrub CLAUDE_CODE_SESSION_ACCESS_TOKEN / SESSION_INGRESS_URL / BRIDGE_PROMPT_SHA256 out of the envs it spawns and arms the appended-prompt digest check",
    CLAUDE_CODE_BRIDGE_PROMPT_SHA256: "the expected sha256 of the system-prompt file the bridge daemon wrote; the CLI hashes --append-system-prompt-file against it and DROPS the prompt on mismatch, then unsets the variable (a verification input, fails closed when absent in a carrier child)",
    CLAUDE_CODE_POLL_EVENTS: "enables poll-event delivery, which injects queued <event> payloads into the session as chunked system deliveries and forces the poll-event delivery guard that clears always-allow command rules",
    CLAUDE_CODE_SYNC_SESSION_REFS: "turns on syncing this session's skills and plugins from the claude.ai account (the same switch as CLAUDE_CODE_SYNC_SKILLS/SYNC_PLUGINS), gated on a latched cloud session id",
    CLAUDE_CODE_SKILL_PROPOSALS: "adds the skill-saving/proposal instructions to the system prompt so Claude offers to save a skill it just used",
    CLAUDE_CODE_HOVER_REST: "pins the v5 storage backend and config home captured at process entry so a hover/preload launch reuses them; the CLI refuses the pin if CLAUDE_CONFIG_DIR later names a different home",
    CLAUDE_CODE_REMOTE_SESSION_ORIGIN: "names what started the cloud session; the value 'review' puts the session in code-review mode",
    CLAUDE_CODE_DISABLE_DIR_SYNC: "stops the cloud directory-sync worker starting at all (reason 'disabled')",
    CLAUDE_CODE_DISABLE_WORKING_SYNC: "stops the synced-file worker that mirrors the /.synced working tree in an SDK cloud session",
    CLAUDE_CODE_DIR_SYNC_GIT: "turns on the git engine for cloud directory sync and makes the turn loop wait for a sync pass and emit dir_sync_notice messages",
    CLAUDE_CODE_HOME_SEED_HOLD_TIMEOUT_MS: "caps how long a managed cloud worker holds the session while seeding settings from the account home; clamped to the built-in maximum, so it can only shorten the wait",
    CLAUDE_CODE_HOME_SEED_VERDICT_TIMEOUT_MS: "caps how long the home-settings seed waits for its trust verdict; clamped to the built-in maximum, so it can only shorten the wait",
    CLAUDE_CODE_DISABLE_HOOK_FORWARDING: "refuses admission of hooks forwarded over the remote session channel, so a cloud client cannot run this machine's hooks",
    CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING: "refuses admission of plugins forwarded over the remote session channel and hides the /cloud-plugins command",
    CLAUDE_CODE_DISABLE_TURN_HANDOFF: "refuses the turn-handoff admission that lets a remote client take over an in-flight turn",
    CLAUDE_CODE_RESTRICTED: "turns on restricted mode (config.restricted) for the launch, which narrows the tool and command surface; it can only restrict, and the CLI drops it from spawned envs",
  }),
  ...each(NON_REDIRECTING_IDENTIFIER, {
    CLAUDE_CODE_CONTAINER_ID: "identifies the container the session runs in: it is reported as claudeCodeContainerId in telemetry, and it downgrades the temp-directory owner-uid mismatch from a refusal to a warning when running as uid 0",
    CLAUDE_CODE_SESSION_ID: "the session id: the CLI assigns it unconditionally into every child, MCP server and shell-snapshot environment from its own session, and a non-canonical inherited value is latched as the cloud session id for session-ref syncing",
    CLAUDE_CODE_WORKER_EPOCH: "the cloud worker's life number, emitted in the init payload so a --cloud client re-registers its device hooks only when the worker restarted; the runner assigns it unconditionally in the child it spawns",
  }),
  ...each(TRANSPORT, {
    CLAUDE_CODE_AGENT_PROXY_GIT_CONFIG: "makes the agent proxy append a governed-git block to GIT_CONFIG_GLOBAL (url.insteadOf rewrites and placeholder git credentials) so git goes through the session proxy; it configures git, not Claude's credential",
    CLAUDE_CODE_AGENT_PROXY_GH_SHIM: "makes the agent proxy write a gh PATH shim directory so the gh CLI's GitHub traffic goes through the session proxy; a third-party tool's routing, not Claude's",
  }),

  // --- the CENSUS (extraction source 7) ------------------------------------
  // Everything below was found by censusing the binary rather than by anchoring
  // on one more Set. Only the AUTHORITY-SHAPED names need a ruling, and these
  // are those rulings. Three rounds of adversarial review each found one more
  // enumeration; this is the answer to that pattern rather than to its latest
  // instance.

  // Credentials, proven or unambiguous. `CLAUDE_BG_AUTH_SNAPSHOT_PATH` is the
  // sharpest: the CLI reads the PATH from the environment, reads that file and
  // JSON-parses it as an auth snapshot (`let e=process.env.CLAUDE_BG_AUTH_SNAPSHOT_PATH;
  // ... let r=JSON.parse(n)`), which is a credential-injection primitive of the
  // same shape as ANTHROPIC_IDENTITY_TOKEN_FILE. `CLAUDE_CODE_MESSAGING_TOKEN`
  // is a literal bearer handshake to a socket that then relays messages typed
  // as 'user' into the session.
  ...group(
    [
      'CLAUDE_BG_AUTH_SNAPSHOT_PATH', 'CLAUDE_BG_SOCKET_TOKENS_PATH',
      'CLAUDE_BG_CLAIM_AUTH', 'CLAUDE_BG_PTY_AUTH', 'CLAUDE_BG_RV_AUTH',
      'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_TRUSTED_DEVICE_TOKEN',
      'CLAUDE_CODE_GATEWAY_TOKEN', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', 'CLAUDE_CODE_SLACK_TAG_TOKEN',
      // Header injection on the wire, the same class as ANTHROPIC_CUSTOM_HEADERS.
      'CLAUDE_CODE_GATEWAY_HINT_HEADERS',
    ],
    CLAUDE_CREDENTIAL,
  ),

  // Who the session acts as, or which stored identity/plan it claims.
  ...group(
    [
      'CLAUDE_CODE_ACCOUNT_TAGGED_ID', 'CLAUDE_BRIDGE_REATTACH_OWNER_ORG',
      'CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID', 'CLAUDE_CODE_SUBSCRIPTION_TYPE',
      'CLAUDE_BG_DISPATCHER_SUBSCRIPTION_TYPE',
      // Skips an organisation check outright, which is an account gate.
      'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK',
    ],
    ACCOUNT_PIN,
  ),

  // Where the session's traffic goes, or where its handshake connects.
  ...group(
    [
      'ANTHROPIC_API_HOST', 'ANTHROPIC_ASSETS_HOST', 'CLAUDE_AI_HOST', 'CLAUDE_AI_ORIGIN',
      'CLAUDEAI_SUCCESS_URL', 'CLAUDE_CODE_MODEL_CATALOG_URL', 'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_GATEWAY_ALLOW_LOOPBACK', 'CLAUDE_GATEWAY_PROXY_IS_EGRESS_BOUNDARY',
    ],
    CLAUDE_ENDPOINT,
  ),

  // Tells the CLI the HOST refreshes auth, like its SDK sibling already in the
  // list -- an inherited claim about the host is the host's to make.
  ...group(['CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH'], HOST_HOOK),

  // PRESERVED. Each of these matched the authority SHAPE and is not authority:
  // token BUDGETS and thresholds, timings, directories that hold no identity,
  // session identifiers, and telemetry. Ruled on rather than skipped, because
  // the shape test is what forces the ruling -- that is its whole job.
  ...each(OPERATIONAL, {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "sets the max_tokens the CLI asks for on each model request, clamped between the model's default and its upper limit",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "declares the context window the CLI assumes for an unrecognised model, which sets the auto-compaction ceiling (and is the only window used when DISABLE_COMPACT is set)",
    CLAUDE_CODE_IDLE_TOKEN_THRESHOLD: "the context-token floor (default 100000) a session must exceed before the idle-return notification is scheduled",
    CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "the estimated-token floor (default 100000) a resumed session must exceed before the resume-return prompt is offered",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "selects the total_tokens reminder mode (off / padded-countdown / ...) shown in the prompt, overriding the setting and the GrowthBook arm",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER_AFTER_USER_TURN: "decides whether the total_tokens reminder is re-emitted and its budget re-anchored at each user turn, rather than counting down across the whole session",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET: "the starting token budget the padded-countdown reminder counts down from (default 15000000)",
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "raises or lowers the per-file token cap the Read tool enforces before refusing with MaxFileReadTokenExceededError",
    CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS: "the projected-token cap above which the workflow size warning fires before scheduling a large workflow",
    CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT: "appends a token_usage attachment (used/total/remaining) to the turn context",
    CLAUDE_CODE_OAUTH_401_WAIT_MS: "how long the CLI waits before retrying after an OAuth 401 (default 60000 in a runner child, 0 otherwise); a backoff, not a credential source",
    CLAUDE_CODE_AUTH_FAIL_EXIT_MS: "how long a remote child tolerates an unrecovered OAuth 401 before exiting so the runner recycles it with fresh credentials (default 600000; <=0 disables the exit)",
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "how long the credential minted by the apiKeyHelper is cached before it is re-run; it sets the lifetime of a credential the helper produces but names no helper and selects no credential source",
    CLAUDE_CODE_ARG_KEY_SHAPE: "a member of the CLI's own set of CLI-owned key names (a8t) used to decide which env keys are Claude's rather than a third party's when filtering argv/env; not a behaviour switch",
    CLAUDE_GATEWAY_DRAIN_TIMEOUT_MS: "how long the `claude` apps-gateway subcommand lets in-flight requests finish after SIGTERM before cutting them (default 25000)",
    CLAUDE_GATEWAY_LOG_LEVEL: "sets the minimum level of the apps-gateway subcommand's own [gateway] log lines (debug/info/warn/error, default info)",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "allows the bootstrap to GET /v1/models from the already-selected ANTHROPIC_BASE_URL gateway with the already-selected credential, to list additional model options; it selects neither the endpoint nor the credential",
    CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: "extends the timeout of the gateway /v1/models discovery request (default 3000)",
    CLAUDE_CODE_REMOTE_MEMORY_DIR: "REPLACES the base directory the auto-memory store reads and writes (memory/ and MEMORY.md) in place of the config home, and its presence also re-enables auto-memory inside a cloud session; the credential store is not resolved from it",
    CLAUDE_CODE_CHROME_MCP_ORG_DENIED: "asserts that the parent's organization policy denied Claude in Chrome; the CLI sets it into the Chrome MCP child when the policy denies, and an inherited value can only DENY the feature, never grant it",
    CLAUDE_CODE_DISABLE_ORG_MEMORY: "turns off the organization-wide memory store (the shared store synced across a company's projects), leaving only local memory",
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "makes the Bash tool keep the project working directory across calls instead of resetting it each invocation",
    CLAUDE_CODE_PROFILE_QUERY: "enables per-query profiling checkpoints and the TTFT report printed on demand",
    CLAUDE_CODE_PROFILE_STARTUP: "forces startup/headless latency profiling on for this process (otherwise sampled at 5%/0.5%) and prints the per-phase timings",
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "decides whether the authenticated account's UUID (user.account_uuid, and the derived user.account_id) is attached to exported metrics; it reports the account the CLI already resolved and cannot change it (defaults on)",
    OTEL_METRICS_INCLUDE_SESSION_ID: "decides whether session.id (and ccr.session.id) is attached to exported metrics; a telemetry-attribute switch with a built-in default of true",
  }),
  ...each(NON_REDIRECTING_IDENTIFIER, {
    CLAUDE_PROJECT_UUID: "names WHICH claude.ai project the Projects tool attaches to, reads knowledge from and writes to; access is authorised by the separate claude.ai login and the allow_projects_tool policy, so it selects a document container, not an auth scope",
    CLAUDE_CODE_REMOTE_SESSION_UUID: "the UUID form of the cloud session id; the self-hosted runner derives it from the session id and sets it unconditionally in the child it spawns, beside CLAUDE_CODE_REMOTE_SESSION_ID",
    CLAUDE_CODE_BRIDGE_SESSION_ID: "names the repl-bridge session this process is bound to; the CLI writes it into process.env from its own repl handle and deletes it when there is none, and it is scrubbed from spawned envs",
    CLAUDE_CODE_CLOUD_SESSION_ID: "the cloud session id the CLI injects into every hook command's environment as envExtra, and stamps on the /tool_calls hook POST",
    CLAUDE_CODE_HOST_SESSION_ID: "the embedding host's session id, resolved into the session registry's name/record so a desktop or IDE host can find its session again",
    CLAUDE_CODE_SESSION_ORIGIN: "names what started the session; it is read into the bootstrap/telemetry context object beside the account and organization UUIDs, as an attribution field only",
    CLAUDE_CODE_WORKSPACE_HOST_PATHS: "a pipe-separated list of host-side workspace paths that is split and attached to every exported telemetry event as the workspace.host_paths attribute; nothing is read or written at those paths",
  }),
  ...each(NON_REDIRECTING_EXEC_PATH, {
    CLAUDE_CODE_PLUGIN_CACHE_DIR: "replaces the directory plugins are installed into and loaded from (default <configHome>/plugins), including the marketplace zip cache; plugin code, hooks and MCP servers are read from there, which is the accepted command-execution class, and no credential or identity is resolved from it",
    CLAUDE_CODE_PLUGIN_SEED_DIR: "a PATH-delimited list of directories pre-populated with plugins that the CLI seeds from (used by self-hosted runner operators); same accepted class as the plugin cache, and it carries no credential",
    CLAUDE_CODE_GIT_BASH_PATH: "names the bash.exe/sh.exe the Bash tool runs on Windows; the CLI rejects it unless the basename is bash/sh and the file exists, then falls back to auto-detection - a command-execution primitive of the same accepted class as PATH",
  }),
  ...each(NON_REDIRECTING_SINK, {
    CLAUDE_CODE_EVAL_ARTIFACT_STUB_DIR: "names the directory the plugin-eval harness writes stub artifacts to instead of publishing them (eval-stub://artifact/ URLs); one of the four eval keys the harness allows a case to set",
    CLAUDE_JOB_DIR: "the background job's directory, which the CLI WRITES its exit-cause and exit-detail files into and derives the job id from for the session pid-file; the CLI sets it when it spawns a daemon job and deletes it on respawn",
  }),
  ...each(NON_REDIRECTING_ENDPOINT, {
    OTEL_EXPORTER_OTLP_ENDPOINT: "the collector URL the OTLP metric/log/trace exporters send telemetry to (and the host used to pick the http agent); a telemetry endpoint, not a model-provider one, and it carries no account credential",
    OTEL_EXPORTER_PROMETHEUS_HOST: "the host the bundled Prometheus metrics exporter BINDS its scrape server on (with OTEL_EXPORTER_PROMETHEUS_PORT); an inbound listen address for metrics, not an outbound credential path",
  }),
  ...each(CLI_SET_CHILD_VARIABLE, {
    CLAUDE_PROJECT_DIR: "the project root: the CLI assigns it unconditionally into every MCP server and hook child environment from its own resolved root, and it is one of only three placeholders a hook `file` path may expand",
  }),
  // Corporate TLS material, the same family as CLAUDE_CODE_CLIENT_CERT: needed
  // for connectivity, and it selects no account.
  ...group(['CLIENT_CERTIFICATE', 'CLIENT_KEY'], TRANSPORT),
  // An AWS SSO login cache location. A developer credential store by D18 item
  // 2: probed not to redirect Claude with the provider selectors removed.
  ...group(['AWS_LOGIN_CACHE_DIRECTORY', 'CLAUDE_CODE_SKIP_AWS_CRED_CACHE'], SHARED_SDK_CONFIG),

  ...each(OPERATIONAL, {
    DISABLE_GROWTHBOOK: "turns off GrowthBook feature-flag evaluation entirely, which also disables Remote Control (which requires flag evaluation) and is reported in `claude doctor`",
  }),
  ...each(TRANSPORT, {
    API_FORCE_IDLE_TIMEOUT: "decides whether the fetch idle timeout is disabled on Anthropic API requests that already have a body idle watchdog; sits in the CLI's proxy/TLS transport set beside HTTPS_PROXY",
  }),

  // --- census: the four Claude-namespaced names the shape test added later ---
  // A capability grant, validated by the CLI against a schema naming `servers`
  // and `tools` and passed beside `credentials` into an artifact-publish call.
  // A grant travelling next to a credential is scope, so it is a pin.
  'CLAUDE_ARTIFACT_HOST_GRANT': ACCOUNT_PIN,
  // Decides whether the ambient environment is allowlist-filtered before it
  // reaches an MCP server child. Same class as CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION,
  // which is already a host hook: an inherited value turning it off widens what
  // a subprocess inherits.
  'CLAUDE_CODE_MCP_ALLOWLIST_ENV': HOST_HOOK,
  // A paired-device id for the companion browser, validated and accepted. It
  // identifies a BROWSER, not the Claude account, and cannot select a
  // credential or an endpoint -- preserved, ruled rather than skipped.
  ...each(NON_REDIRECTING_IDENTIFIER, {
    CLAUDE_CHROME_PAIRED_DEVICE_ID: "names the paired browser-extension device the Claude-in-Chrome bridge talks to; regex-validated and ignored when it is not an extension device id, and it identifies a BROWSER, not a Claude account",
  }),
  // An error-code constant the census caught by shape, not an environment name.
  ...each(OPERATIONAL, {
    CLAUDEAI_BEARER_REJECTED: "NOT read as a variable: an MCP failure error-code constant ('a claude.ai connector rejected the claude.ai login'), matched to classify a failed server row as user_auth",
  }),

  // --- adversarial round 4: what the WIDENED census found -----------------
  // Round 3's census could not see four read forms -- a list containing a
  // spread, an alias longer than two characters, a typed env-schema object KEY,
  // and a lone quoted argument. Finding a name is one question; what to DO with
  // it is D3, and the two are answered separately here.
  //
  // D3 is the whole test: an ambient variable is removed only when it can
  // override the selected account, credential, provider or provider endpoint.
  // An interactive session otherwise INHERITS the developer's environment, and
  // stripping a name that cannot redirect anything is a cost with no benefit.
  // The first pass over these 49 names got that wrong in one direction --
  // "stripping is harmless, so strip" -- which is not the rule. Each ruling
  // below now carries the evidence that decided it. All of it is from the
  // pinned binary: Claude Code 2.1.278, win32-x64, digest 006ea5c8...cced8.

  // --- REMOVED: these really can redirect (D3) ---
  // `R("ANTHROPIC_ENVIRONMENT_KEY")` in the environments worker, passed straight
  // into `authToken` on an Anthropic-side request. A bearer credential by use,
  // whatever its name suggests.
  'ANTHROPIC_ENVIRONMENT_KEY': CLAUDE_CREDENTIAL,
  // A member of the CLI's own token list beside CLAUDE_CODE_OAUTH_TOKEN, and of
  // its authentication env-schema map. Invisible to round 3 because the list
  // contains a spread and the map's keys are computed.
  'CLAUDE_CODE_HFI_BEARER_TOKEN': CLAUDE_CREDENTIAL,
  // THE name the family rules swallowed. It sits in the CLI's own secret list
  // between MCP_XAA_IDP_CLIENT_SECRET and SELF_HOSTED_RUNNER_POOL_SECRET, is
  // read by the environments worker, and is sent as `authToken` to Anthropic.
  // It was written INTO the third-party-dev-credential regex and ruled keep on
  // both axes with a reason -- "it authenticates that tool, not Claude" -- that
  // was false of it. See `requiresExactRuling`.
  'ENVIRONMENT_SERVICE_KEY': CLAUDE_CREDENTIAL,
  // The proxy-authorization helper's inputs, and the ONE child-helper group
  // that is removed. The distinction is the spread, and it is visible in the
  // source: this helper's environment is
  // `{...process.env, ...o && {CLAUDE_CODE_PROXY_URL:o}}` -- CONDITIONAL, so
  // where the CLI has no value of its own the ambient one reaches a helper
  // whose entire job is to mint a `Proxy-Authorization` credential. That is
  // "capable of changing credentials" under D3. Compare the marketplace, plugin
  // and MCP headers helpers below, whose environments are built fresh.
  ...group(
    ['CLAUDE_CODE_PROXY_URL', 'CLAUDE_CODE_PROXY_HOST', 'CLAUDE_CODE_PROXY_AUTHENTICATE'],
    CHILD_HELPER_CHANNEL,
  ),

  // --- PRESERVED: found by the census, ruled by D3, and kept ---
  // `R("ANTHROPIC_WEBHOOK_SIGNING_KEY")` is the bundled SDK constructor's
  // `webhookKey`. It VERIFIES inbound webhook payloads; it is never sent, and
  // it selects no account, credential, provider or endpoint. A secret, but not
  // an authority variable -- and D3 does not remove secrets, it removes
  // redirection.
  'ANTHROPIC_WEBHOOK_SIGNING_KEY': NON_REDIRECTING_SECRET,
  // `R("ANTHROPIC_SESSION_ID")` reaches exactly one place: the `data:{type:
  // "session", id:n}` field of a work-order payload whose authorisation is the
  // separate `environmentKey` -- which IS removed above. So it cannot override
  // managed identity, and attribution stays inside whichever environment that
  // key already authorises, which is not a cross-account move. Ruled keep on
  // the evidence rather than stripped on the resemblance (adversarial round 4,
  // owner requirement 3).
  'ANTHROPIC_SESSION_ID': NON_REDIRECTING_IDENTIFIER,
  // A LOG SINK. `this.deps.env.CLAUDE_CODE_DEBUG_LOGS_DIR` (a three-character
  // alias, which is why round 3's `\w{1,2}` could not see it) is the directory
  // the CLI writes its own debug transcript to. It selects no account, no
  // credential, no provider and no endpoint, so D3 preserves it. Stated
  // residual: an ambient value does decide WHERE a transcript is written, which
  // is a confidentiality question and not an isolation one -- it is recorded
  // here rather than used to justify a strip (owner requirement 2).
  'CLAUDE_CODE_DEBUG_LOGS_DIR': NON_REDIRECTING_SINK,
  // `& ($env:CLAUDE_CODE_POLICY_HELPER_PS1_PATH)` inside a PowerShell helper the
  // CLI launches `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, with its
  // own environment denylist (DOTNET_, COMPLUS_, __PSLOCKDOWNPOLICY, ...). That
  // makes it a command-execution primitive, which is the SAME accepted class as
  // CLAUDE_CODE_GIT_BASH_PATH and PATH under D17: this app does not sandbox code
  // the same OS user can already run. It redirects no authority, so D3 keeps it
  // and D17 says why that is consistent rather than lax.
  'CLAUDE_CODE_POLICY_HELPER_PS1_PATH': NON_REDIRECTING_EXEC_PATH,
  // Every CLAUDE_RUNNER_* name is assigned UNCONDITIONALLY from verified JWT
  // claims into the runner's environment --
  // `{...process.env, CLAUDE_RUNNER_ACCOUNT_EMAIL: e.claims.account_email, ...}`
  // with no `&&` guard on any of them -- so an inherited value is overwritten
  // before anything reads it. It cannot become an account claim the user did
  // not make, which is what the first pass assumed. (The one name in that object
  // that IS conditional, CLAUDE_RUNNER_CLIENT_PLATFORM, carries no authority and
  // is not in this set.)
  ...group(
    [
      'CLAUDE_RUNNER_ACCOUNT_EMAIL', 'CLAUDE_RUNNER_ACCOUNT_ID',
      'CLAUDE_RUNNER_SESSION_ID', 'CLAUDE_RUNNER_SESSION_UUID',
      'CLAUDE_RUNNER_API_BASE_URL', 'CLAUDE_RUNNER_CHECKOUT_PATH',
      'CLAUDE_RUNNER_DEBUG_LOG_PATH', 'CLAUDE_RUNNER_GIT_MOUNT_URL',
      'CLAUDE_RUNNER_PRIMARY_REPO_URL', 'CLAUDE_RUNNER_REPO_URL',
      'CLAUDE_RUNNER_WORKSPACE_PATHS',
    ],
    CLI_SET_CHILD_VARIABLE,
  ),
  // The marketplace, plugin-archive and MCP headers helpers.
  //
  // The reason first recorded here was WRONG and is corrected rather than
  // quietly dropped, because a maintainer applying it to the next helper would
  // mis-rule it. It said these helpers' environments are "built FRESH ... with
  // no `...process.env` spread". They are not: all three route through
  // `bt(e)`, which is `{...subprocessEnv()}`, and `subprocessEnv()` returns
  // `process.env` itself in its fast path. The ambient environment DOES reach
  // them (adversarial round 5).
  //
  // The disposition still holds, on the SAME test as the runner group above:
  // each of these three names is assigned UNCONDITIONALLY in the helper's own
  // `e.env`, which is applied last, so an inherited value is overwritten before
  // the helper reads it. Conditional-versus-unconditional is the real rule;
  // fresh-versus-spread was never the rule and is not true.
  ...group(
    ['CLAUDE_CODE_MARKETPLACE_URL', 'CLAUDE_CODE_MCP_SERVER_URL', 'CLAUDE_CODE_PLUGIN_ARCHIVE_URL'],
    CLI_SET_CHILD_VARIABLE,
  ),
  // Members of the CLI's typed env-schema maps that decide where it fetches a
  // feature-flag payload and a changelog. Neither is a MODEL provider endpoint
  // and neither carries the account's credential, so D3 keeps them.
  ...group(['CLAUDE_CODE_GB_BASE_URL', 'CLAUDE_CODE_DEV_RAW_CHANGELOG_URL'], NON_REDIRECTING_ENDPOINT),
  // Set by a bundled plugin's own MCP server config from ${CLAUDE_PROJECT_DIR}.
  // A working directory, not an authority variable.
  'CLAUDE_TEST_PROJECT_DIR': CLI_SET_CHILD_VARIABLE,

  // NOT an environment variable: a key in the CLI's OAuth constants object
  // (`{BASE_API_URL:"https://api.anthropic.com", CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize", ...}`),
  // caught by the object-KEY census. Ruled rather than filtered out, so that a
  // name which later becomes a real variable is already on the record.
  ...each(OPERATIONAL, {
    CLAUDE_AI_AUTHORIZE_URL: "NOT read as a variable: a KEY in the CLI's OAuth constants object whose value is derived from CLAUDE_LOCAL_OAUTH_APPS_BASE / CLAUDE_CODE_CUSTOM_OAUTH_URL (both already stripped), then read as Yt().CLAUDE_AI_AUTHORIZE_URL to build the authorize URL",
  }),

  // --- adversarial round 5: what the WIDENED SHAPE TEST then demanded -----
  // Both names were already in the census's 1284. Neither ever became an ENTRY,
  // because `AUTHORITY_SHAPED` did not match them, so the "an authority-shaped
  // name with no ruling is a hard failure" gate never fired for either. Round 4
  // fixed an incomplete CENSUS; this is an incomplete SHAPE TEST -- a different
  // defect in the same machine, and the reason `RATE_LIMIT` and `ENV_SCRUB` are
  // now part of that pattern.

  // The TIER twins of two names already ruled `account-pin`. The CLI treats the
  // pair as ONE fact everywhere it touches them: it writes both out of
  // authenticated account state when consuming a background auth snapshot
  // (`if(r.subscriptionType) process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE=...;`
  // `if(r.rateLimitTier) process.env.CLAUDE_CODE_RATE_LIMIT_TIER=...`), reads
  // both off the env alias for the dispatcher, and lists both side by side in
  // its own `childScrubbedCredentialKeys`. The CLI's project/local settings
  // filter refuses the tier name from an untrusted scope; ours did not. Keeping
  // it let a session present a plan claim the selected account never made while
  // the identical claim in its twin was removed.
  ...group(['CLAUDE_CODE_RATE_LIMIT_TIER', 'CLAUDE_BG_DISPATCHER_RATE_LIMIT_TIER'], ACCOUNT_PIN),
  // Disables the CLI's OWN credential redaction for every subprocess it spawns
  // (`xRn()` -> `subprocessEnv()`), and forces permission mode to `default`.
  // That is exactly the consequence recorded for CLAUDE_CODE_MCP_ALLOWLIST_ENV
  // -- "an inherited value turning it off widens what a subprocess inherits" --
  // which is already a stripped host hook, so this is the same ruling for the
  // same reason.
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB': HOST_HOOK,

  // The feature-flag OVERRIDE channel. It
  // is INERT in 2.1.278 -- the consumer is a stub in this build
  // (`getEnvironmentOverrides(){return null}`), so the wired-in reader
  // `readEnvironmentOverrides:()=>a.CLAUDE_INTERNAL_FC_OVERRIDES` is never
  // consulted -- and it cannot change an account, credential, provider or
  // endpoint today. It is ruled by the OWNER'S EXISTING PRECEDENT for
  // exactly this situation, D16 item 8: an inert override name stays in the
  // strip, because its inactivity is pinned-version evidence and not a
  // contract. The precedent applies with some force here: what this channel
  // would override is feature flags, and the credential-store backend is
  // selected BY a feature flag. The CLI itself lists the first name in its
  // provider-env allowlist beside CLAUDE_CONFIG_DIR and
  // CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, every other member of which this
  // manifest already rules. Found because `_OVERRIDES` was not an authority
  // SHAPE, so the gate never asked (adversarial round 6).
  'CLAUDE_INTERNAL_FC_OVERRIDES': HOST_HOOK,
  // NOT the same ruling as its neighbour, although the first draft gave it one.
  // The stub above is the GrowthBook client's; this switch never goes through
  // it and is LIVE in the pinned build: the plugin-eval harness reads it at run
  // time to decide whether a case may seed its own feature-flag overrides, and
  // prints "operator allowlist required -- CLAUDE_CODE_EVAL_ALLOW_FLAG_OVERRIDES"
  // when it may not. The CLI's own error text says where the value comes from:
  // "Anything else must come from the operator's shell." An opt-in a developer
  // sets in their own shell, selecting no account, credential, provider or
  // endpoint, is exactly what D3 preserves; stripping it would break `claude
  // plugin eval` inside a managed session while naming a variable the user DID
  // set (adversarial round 6). The precedent for the name above does not
  // reach this one, because the precedent is about inertness.
  'CLAUDE_CODE_EVAL_ALLOW_FLAG_OVERRIDES': NON_REDIRECTING_OPERATOR_SWITCH,

  // What the shared namespace list found the moment it existed: two CCR_ names
  // the family rules had been settling as keep/keep while their sibling
  // CCR_SESSION_PROFILE was stripped as an account pin (adversarial round 6).
  // A credential-source LABEL, not a read. The CLI's own auth resolver returns
  // `{source:"CCR_OAUTH_TOKEN_FILE", hasToken:true}` and reports it as the
  // login method beside CLAUDE_CODE_OAUTH_TOKEN and the token file descriptor,
  // but every occurrence in the pinned build is that label, a `case` arm or a
  // display-map key: the token it names arrives by a well-known file path the
  // resolver checks itself, never through this variable (adversarial round 7,
  // correcting round 6's reason). Stripped all the same, like the OAuth host
  // constants -- a build that began reading the name it labels would be
  // reading a credential file, and the strip costs a developer nothing.
  'CCR_OAUTH_TOKEN_FILE': {
    ...CLAUDE_CREDENTIAL,
    reason: 'a credential-source label in the pinned build, not a variable it reads: the OAuth token it names is found by a well-known path. Stripped because a build that read the name it labels would read a credential file, and the strip costs nothing (adversarial round 7)',
  },
  // The session's account identity: set by the CCR host beside
  // CLAUDE_CODE_ACCOUNT_UUID and CLAUDE_CODE_USER_EMAIL, and written verbatim
  // into the git hook the CLI installs. Same ruling as those two.
  'CCR_SESSION_ACCOUNT_EMAIL': ACCOUNT_PIN,

  // The ANT_ family. Keys in the CLI's OWN typed env-schema map, read through
  // a `process.env` proxy -- the same read form that hid the bearer token in
  // round 4, in a namespace the census did not list until round 5. Adding the
  // namespace made them VISIBLE and nothing more: `requiresExactRuling` still
  // tested only CLAUDE and ANTHROPIC, so every ANT_ name fell through to the
  // catch-all family rule with the reason "not an environment variable the CLI
  // reads" -- false of both -- and a future ANT_ bearer would have been kept
  // with no hard failure. That is the ENVIRONMENT_SERVICE_KEY defect reopened
  // in the namespace the previous fix had just opened (adversarial round 6).
  // ANT_ now requires an exact ruling, here and in the validator. These two
  // are telemetry endpoints: no credential, not a provider endpoint (D3).
  ...group(['ANT_CLAUDE_CODE_METRICS_ENDPOINT', 'ANT_OTEL_EXPORTER_OTLP_ENDPOINT'], NON_REDIRECTING_ENDPOINT),

  // The two members of the CLI's secret list that are NOT a third party's
  // credential, pulled out of that group because its reason was false of them.
  // They are the self-hosted runner's registration secrets: read at the
  // `--api-url` registration call, described in the CLI's own help as "Shown
  // beside the runner in the Anthropic console", and paired with
  // `--lock-to-account <id>`. That is an Anthropic-side credential wearing a
  // third party's name -- the ENVIRONMENT_SERVICE_KEY defect restated by hand,
  // one slot away in the same nine-member list (adversarial round 5).
  //
  // The DISPOSITION is unchanged, and on its own evidence rather than by
  // inheritance: both are consumed only by the `claude self-hosted-runner`
  // subcommand, which a managed interactive launch never runs, so neither can
  // redirect the selected realm (D3).
  ...group(
    ['SELF_HOSTED_RUNNER_POOL_SECRET', 'SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET'],
    NON_REDIRECTING_SUBCOMMAND_CREDENTIAL,
  ),

  // --- the CLI's secret lists, now ruled BY NAME --------------------------
  // These were already keep/keep by family. What changed is that the CLI names
  // them as secrets, so a family rule may no longer settle them
  // (`requiresExactRuling`) -- each states its own position instead. The
  // position is unchanged and is D18 item 2: a third-party tool's credential or
  // registry, which authenticates that tool rather than Claude, and which
  // Claude's Bash tool needs in order to run the tool at all.
  ...group(
    [
      'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_PASSWORD',
      'CARGO_REGISTRY_TOKEN', 'CODEARTIFACT_AUTH_TOKEN',
      'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'GOAUTH', 'GOPROXY',
      'MCP_CLIENT_SECRET', 'MCP_XAA_IDP_CLIENT_SECRET',
      'NPM_TOKEN', 'PYPI_TOKEN', 'TWINE_PASSWORD',
      'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL',
      'UV_INDEX', 'UV_INDEX_URL', 'UV_DEFAULT_INDEX', 'UV_EXTRA_INDEX_URL',
    ],
    DEV_TOOL_CREDENTIAL,
  ),
}

// --- the CLI-owned census, ruled by name (adversarial round 8) --------------
// Until round 8 the generator asked for an exact ruling only of a census name
// that was ALSO authority-shaped, so the "each CLI-owned name gets its own
// ruling" rule above was true of the names a shape pattern happened to
// describe and false of the other six hundred. One of those was
// CLAUDE_BRIDGE_REATTACH_OWNER_ACCT, the account half of an identity pair whose
// organization half sits in the strip. The gate now asks about EVERY CLI-owned
// census name; the answers live in claude-authority-census-rulings.mjs as
// [kind, what] rows and are composed into exact rulings here, with the same
// dispositions the kind carries everywhere else and a reason that is the
// reviewer's finding plus the D3 clause that finding satisfies.
const CENSUS_KIND_SPECS = {
  'account-pin': ACCOUNT_PIN,
  'claude-credential': CLAUDE_CREDENTIAL,
  'claude-endpoint': CLAUDE_ENDPOINT,
  'claude-realm-root': CLAUDE_REALM_ROOT,
  'provider-switch': PROVIDER_SWITCH,
  'child-helper-channel': CHILD_HELPER_CHANNEL,
  'host-hook': HOST_HOOK,
  'cli-set-child-variable': CLI_SET_CHILD_VARIABLE,
  'non-redirecting-identifier': NON_REDIRECTING_IDENTIFIER,
  'non-redirecting-sink': NON_REDIRECTING_SINK,
  'non-redirecting-endpoint': NON_REDIRECTING_ENDPOINT,
  'non-redirecting-exec-path': NON_REDIRECTING_EXEC_PATH,
  'non-redirecting-operator-switch': NON_REDIRECTING_OPERATOR_SWITCH,
  'non-redirecting-secret': NON_REDIRECTING_SECRET,
  'transport': TRANSPORT,
  'runtime': RUNTIME,
  'model-selection': MODEL_SELECTION,
  'operational': OPERATIONAL,
}

/**
 * Compose the census table into exact rulings. Exported for the test that
 * proves each refusal below can fire; the module-level result is what
 * `classify` consults. Every refusal is a hard failure at import time, because
 * a row that silently lost is a name that silently went unruled.
 */
export function composeCensusRulings(table, { exact = AUTHORITY_CLASSIFICATION, fragments = CLI_OWNED_CENSUS_FRAGMENTS } = {}) {
  const out = {}
  for (const [name, row] of Object.entries(table)) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || typeof row[1] !== 'string' || row[1].trim().length === 0) {
      throw new Error(`census ruling ${name}: expected [kind, what]`)
    }
    const [kind, what] = row
    if (Object.hasOwn(exact, name)) throw new Error(`census ruling ${name}: already ruled by name in AUTHORITY_CLASSIFICATION; delete one`)
    if (!CLI_OWNED_NAMESPACE_RE.test(name)) throw new Error(`census ruling ${name}: not in a CLI-owned namespace; third-party names are settled by the family rules`)
    if (name.endsWith('_') || fragments.includes(name)) throw new Error(`census ruling ${name}: a prefix fragment is not a variable and is not ruled`)
    const spec = CENSUS_KIND_SPECS[kind]
    if (!spec) throw new Error(`census ruling ${name}: unknown kind ${kind}`)
    out[name] = { ...spec, reason: `${what} -- ${D3_CLAUSE[kind] ?? spec.reason}` }
  }
  return out
}
export const CENSUS_CLASSIFICATION = composeCensusRulings(CLI_OWNED_CENSUS_RULINGS)
export { CLI_OWNED_CENSUS_FRAGMENTS }

/**
 * FAMILY RULES, consulted only when no exact classification matches AND the
 * name does not require an exact ruling (see `requiresExactRuling`).
 *
 * The census looks at the whole binary, so it finds the environment names a
 * BUNDLED DEPENDENCY reads as well as every one Claude reads: Azure's
 * credentials, a dozen package registries' publish tokens, the GitHub Actions
 * runner's secrets, the dynamic loader's search paths, and a long tail of SDK
 * constants that are not environment names at all. Ruling on those 245 by name
 * would make this file unreadable without making it truer -- each is an
 * instance of ONE decision this repo has already taken, and each rule below
 * states which.
 *
 * Ordered: the first match wins.
 */
export const AUTHORITY_FAMILY_RULES = [
  {
    id: 'third-party-dev-credential',
    test: /^(AZURE_|VAULT_|CONSUL_|NOMAD_|GITHUB_|GH_|ACTIONS_|RUNNER_|SELF_HOSTED_RUNNER_|OVERRIDE_GITHUB_|DEFAULT_WORKFLOW_|PYPI_|TWINE_|POETRY_|UV_|PIP_|CARGO_|CONAN_|COMPOSER_|MATURIN_|FLIT_|HATCH_|HF_|HUGGING|ANACONDA_|BINSTAR_|GEM_|NUGET_|NODE_AUTH_|VSS_|SBT_|SONAR_|SOPS_|COURSIER_|ARTIFACTS_CREDENTIALPROVIDER|REGISTRY_AUTH_FILE|ANSIBLE_|PG(PASSWORD|SSLCERT)|MSI_SECRET|IDENTITY_HEADER|GOAUTH|GOOGLE_|CLOUDSDK_|BOTO_|KUBERNETES_|DOCKER_|SSH_|GIT_|DENO_CERT|NIX_SSL|SSL_|GRPC_|HTTPLIB2_|HEX_CACERTS|MATCH_GIT_|CODER_|GITPOD_|DEVPOD_|TERMINATOR_|DISCORD_WEBHOOK|SLACK_WEBHOOK|TEAMS_WEBHOOK|APP_SERVICE_SECRET|ADFS_|ARTIFACT_IFRAME_HOST|VERTEX_|MCP_|MAX_MCP_|BETA_TRACING_ENDPOINT|OTEL_)/,
    spec: DEV_TOOL_CREDENTIAL,
    why: 'a THIRD-PARTY tool\'s own credential, registry or endpoint. D18 item 2, and the same reasoning that preserves the AWS and GCP families: it authenticates that tool, not Claude, and a probe showed a shared credential cannot redirect Claude once the provider selectors are gone. Removing it would break `az`, `vault`, `gh`, `pip` and the rest in the Bash tool that inherits this environment.',
  },
  {
    test: /^(DYLD_|LD_|NODE_PATH|LIBRARY_PATH|C(PLUS)?_INCLUDE_PATH|GCONV_PATH|MODULE_PATH|MONO_PATH|QT_PLUGIN_PATH|GTK_PATH|GIO_MODULE_DIR|PHP_INI_SCAN_DIR|SASL_PATH|BASH_|R_PROFILE_USER|XDG_|DEVELOPER_DIR|CLIPBOARD_NAPI_NODE_PATH|COMPUTER_USE_SWIFT_NODE_PATH|DS_CHROMIUM_PATH|ALLUSERSPROFILE|CREDENTIALS_DIRECTORY|ADD_DIR|BASE_PATH|APP_URL|BASE_API_URL)/,
    id: 'loader-or-runtime-path',
    spec: RUNTIME,
    why: 'a loader, toolchain or runtime search path. It decides what a child process LOADS, not which account authenticates, and D17 is explicit that this app does not sandbox code the same OS user can already run. The realm patch may never own one either (NEVER_OWNED_LAUNCH_VARIABLES).',
  },
  {
    id: 'bundled-constant',
    test: /.*/,
    spec: OPERATIONAL,
    why: 'not an environment variable the CLI reads: a constant, error code or header name inside a bundled dependency that the census caught by SHAPE. Inventoried rather than filtered out silently, so that a name which later becomes a real variable is already on the record.',
  },
]

/** The classification for `name`, by exact ruling or by family. Null when the
 *  name needs an exact ruling and has none -- the generator's hard failure. */
export function classify(name, opts = {}) {
  const exact = AUTHORITY_CLASSIFICATION[name] ?? CENSUS_CLASSIFICATION[name]
  if (exact) return exact
  if (requiresExactRuling(name, opts)) return null
  const rule = AUTHORITY_FAMILY_RULES.find((r) => r.test.test(name))
  // A family-ruled entry carries the rule's ID, not its prose: the prose is
  // written once into `provenance.familyRules`, and repeating 300 characters of
  // it 245 times would triple the file without adding a word.
  return rule ? { ...rule.spec, reason: rule.id } : null
}
