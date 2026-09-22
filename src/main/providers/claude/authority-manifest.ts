import { createHash } from 'node:crypto'
import manifestJson from './claude-authority-manifest.json'

/**
 * The GENERATED Claude authority manifest, and the only source of truth for what
 * a managed Claude launch strips.
 *
 * It replaces a hand-maintained array. That array was an incomplete denylist: an
 * adversarial pass recovered the CLI's own authority enumerations from the pinned
 * binary and found 164 authority-shaped names absent from our 33 -- including
 * `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `CLAUDE_CODE_REMOTE_SETTINGS_PATH`.
 * Hand-deriving the list is the defect; this module consumes a manifest derived
 * FROM the CLI instead. (`CLAUDE_CODE_ACCOUNT_UUID` was cited here as a third
 * example while the shipped manifest did not contain it, because the enumeration
 * holding it was not extracted until a later round. The claim and the artefact
 * now agree; a doc that outruns its artefact is the same defect one level up.)
 *
 * `scripts/gen-claude-authority-manifest.mjs` produces the JSON. That script is
 * MAINTAINER-ONLY: it is never run by a build, by packaging, by CI, by startup or
 * by a routine Sentinel check, and it needs a Claude binary this repo does not
 * vendor. Everything here works from the checked-in JSON alone, so the app builds
 * and the whole suite passes with Claude Code not installed.
 *
 * SCOPE OF THE COMPLETENESS CLAIM, and read this before repeating it anywhere.
 * The manifest is derived from the sources named in `provenance.extractedFrom`
 * as they exist in the exact binary named in `provenance` -- Claude Code
 * 2.1.278, win32-x64, the recorded SHA-256. It is NOT a completeness claim for
 * any other version or platform. A different SHA means REVALIDATION IS
 * REQUIRED; it does not by itself mean incompatible.
 *
 * The sources were once TWO hand-anchored enumerations, and three rounds of
 * adversarial review each found one more that the anchors missed -- the third
 * holding the account identity names, the fourth a path the CLI reads and
 * JSON-parses as an auth snapshot. An anchor list is a denylist of places to
 * look, so the generator now also CENSUSES the binary: every environment-shaped
 * name in the namespaces this app cares about, from literals and from
 * `process.env` reads. A censused name that is authority-SHAPED and unruled is
 * a hard generator failure; the rest are counted and digested in
 * `provenance.census` rather than carried as entries. That is what makes "did
 * we find every enumeration?" a question the tool answers rather than one the
 * next review round answers for it.
 */

export type AuthorityKind =
  // removed -- Claude/Anthropic-specific account authority (D18 item 3)
  | 'claude-credential'
  | 'account-pin'
  | 'provider-switch'
  | 'claude-endpoint'
  | 'claude-realm-root'
  | 'host-hook'
  // The CLI passes this into a helper through a CONDITIONAL spread of the
  // ambient environment, so an inherited value reaches a credential-minting
  // helper where the CLI has none of its own (adversarial round 4).
  | 'child-helper-channel'
  // preserved -- cannot independently redirect Claude (D18 items 1, 2, 4)
  | 'dev-tool-credential'
  | 'shared-sdk-config'
  | 'transport'
  | 'runtime'
  | 'model-selection'
  | 'operational'
  // Found by the census, ruled by D3, and KEPT. D3 removes what can override
  // the selected account, credential, provider or endpoint -- not everything a
  // census finds. Each of these names what the variable actually does, so a
  // preserve decision can be re-argued from the reason (adversarial round 4).
  | 'cli-set-child-variable'
  // A shared OS config root that COULD select the Anthropic profile store, but
  // is outranked by ANTHROPIC_CONFIG_DIR, which the realm patch owns and sets.
  // Stripped from a settings block, kept from the ambient environment, because
  // gh, npm and git read it for the developer's own configuration (D3).
  | 'superseded-config-root'
  // The POSIX home: owned and overwritten by the patch on Linux, KEPT elsewhere.
  // Its own kind so that `replace` keeps meaning what it says.
  | 'posix-home-selector'
  | 'non-redirecting-secret'
  | 'non-redirecting-identifier'
  | 'non-redirecting-sink'
  | 'non-redirecting-endpoint'
  | 'non-redirecting-exec-path'
  | 'non-redirecting-operator-switch'
  | 'non-redirecting-subcommand-credential'

/** What the app-owned settings copy does with the key. */
export type SettingsEnvDisposition = 'strip' | 'keep'
/** What a managed launch does with an INHERITED environment variable. */
export type AmbientDisposition = 'strip' | 'keep' | 'replace'

export interface AuthorityEntry {
  readonly name: string
  readonly kind: AuthorityKind
  readonly settingsEnv: SettingsEnvDisposition
  readonly ambient: AmbientDisposition
  readonly reason: string
  readonly sources: readonly string[]
}

export interface AuthorityProvenance {
  readonly cliVersion: string
  readonly platform: string
  readonly binarySha256: string
  readonly binaryBytes: number
  readonly extractedFrom: readonly { readonly id: string; readonly offset: number; readonly what: string }[]
  readonly prefixRules: readonly string[]
  /** The CLI's own namespaces the generator used. A name in one of these is
   *  never settled by a family rule; the validator enforces that with THIS list,
   *  so the manifest and its own rule cannot disagree. */
  readonly cliOwnedNamespaces: readonly string[]
  /** The census the generator ran over the whole binary: how many
   *  environment-shaped names it found, how many of those were authority-shaped
   *  and how many sit in a CLI-owned namespace (each of the second group is an
   *  entry -- the validator checks the count, so a hand-edited manifest cannot
   *  drop one), the run-time prefix fragments it could not resolve, and a
   *  digest of the full list. The digest moves when a CLI version adds or
   *  removes any of them. */
  readonly census: {
    readonly names: number
    readonly authorityShaped: number
    readonly cliOwned: number
    readonly fragments: readonly string[]
    readonly digest: string
  }
  /** The family rules, written once. An entry whose `reason` is one of these
   *  ids was ruled by that rule rather than by name -- which is allowed only
   *  for names OUTSIDE the Claude and Anthropic namespaces. */
  readonly familyRules: readonly { readonly id: string; readonly why: string }[]
}

export interface AuthorityManifest {
  readonly schemaVersion: number
  readonly provenance: AuthorityProvenance
  readonly entries: readonly AuthorityEntry[]
  readonly digest: string
}

export const AUTHORITY_MANIFEST_SCHEMA_VERSION = 2

const KINDS: ReadonlySet<string> = new Set<AuthorityKind>([
  'claude-credential', 'account-pin', 'provider-switch', 'claude-endpoint',
  'child-helper-channel',
  'cli-set-child-variable', 'superseded-config-root', 'posix-home-selector',
  'non-redirecting-secret', 'non-redirecting-identifier',
  'non-redirecting-sink', 'non-redirecting-endpoint', 'non-redirecting-exec-path',
  'non-redirecting-subcommand-credential', 'non-redirecting-operator-switch',
  'claude-realm-root', 'host-hook', 'dev-tool-credential', 'shared-sdk-config',
  'transport', 'runtime', 'model-selection', 'operational',
])
const SETTINGS_DISPOSITIONS: ReadonlySet<string> = new Set<SettingsEnvDisposition>(['strip', 'keep'])
const AMBIENT_DISPOSITIONS: ReadonlySet<string> = new Set<AmbientDisposition>(['strip', 'keep', 'replace'])

/** Must mirror `canonicalManifestDigest` in the generator, byte for byte. */
function canonicalDigest(m: AuthorityManifest): string {
  const c = m.provenance.census
  const canonical = JSON.stringify({
    schemaVersion: m.schemaVersion,
    cliVersion: m.provenance.cliVersion,
    platform: m.provenance.platform,
    binarySha256: m.provenance.binarySha256,
    prefixRules: m.provenance.prefixRules,
    cliOwnedNamespaces: m.provenance.cliOwnedNamespaces ?? null,
    census: c ? { names: c.names, authorityShaped: c.authorityShaped, cliOwned: c.cliOwned, fragments: c.fragments, digest: c.digest } : null,
    entries: m.entries.map((e) => [e.name, e.kind, e.settingsEnv, e.ambient, e.sources.join('|')]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Validate the checked-in manifest. Needs NO Claude binary -- it checks the
 * schema and recomputes the manifest's own digest, which is what CI runs.
 */
export function validateAuthorityManifest(value: unknown): { ok: true; manifest: AuthorityManifest } | { ok: false; error: string } {
  const m = value as AuthorityManifest
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest is not an object' }
  if (m.schemaVersion !== AUTHORITY_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported schemaVersion ${String(m.schemaVersion)}` }
  }
  const p = m.provenance
  if (!p || typeof p.cliVersion !== 'string' || typeof p.platform !== 'string') {
    return { ok: false, error: 'provenance is missing cliVersion/platform' }
  }
  if (typeof p.binarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.binarySha256)) {
    return { ok: false, error: 'provenance.binarySha256 is not a sha-256 hex digest' }
  }
  if (!Array.isArray(p.prefixRules) || !p.prefixRules.every((r) => typeof r === 'string' && r.length > 0)) {
    return { ok: false, error: 'provenance.prefixRules is not a list of non-empty strings' }
  }
  // The namespace list is load-bearing for the family-rule guard below, so it
  // is required, and it may not be NARROWER than the floor every version of
  // this rule has had -- a manifest edited to drop a namespace would otherwise
  // disable the guard for exactly the names it protects.
  // Literal prefixes only: the list is interpolated into a RegExp, and a
  // quantifier here would WIDEN the family-rule guard (`CLAUDEX?` matches
  // `CLAUDE`), not narrow it (code-quality review, MINOR).
  if (!Array.isArray(p.cliOwnedNamespaces) || !p.cliOwnedNamespaces.every((r) => typeof r === 'string' && /^[A-Z][A-Z0-9_]*$/.test(r))) {
    return { ok: false, error: 'provenance.cliOwnedNamespaces is not a list of namespace prefixes' }
  }
  for (const floor of ['CLAUDE', 'ANTHROPIC']) {
    if (!p.cliOwnedNamespaces.includes(floor)) return { ok: false, error: `provenance.cliOwnedNamespaces omits ${floor}` }
  }
  const cliOwned = new RegExp(`^(${p.cliOwnedNamespaces.join('|')})`)
  // The census is the difference between "we anchored on the enumerations we
  // knew about" and "we looked at the whole binary". A manifest without it is
  // one produced by a generator that did not run it, which is exactly the state
  // three review rounds kept finding names in.
  const c = p.census
  if (!c || typeof c.names !== 'number' || typeof c.authorityShaped !== 'number' || typeof c.cliOwned !== 'number' || !/^[0-9a-f]{64}$/.test(String(c.digest))) {
    return { ok: false, error: 'provenance.census is missing or malformed' }
  }
  if (c.authorityShaped > c.names || c.cliOwned > c.names) return { ok: false, error: 'provenance.census counts are inconsistent' }
  // The fragments are the residual stated with the prefixes it hides behind:
  // each must be a CLI-owned prefix ending in '_', and none may be an entry.
  if (!Array.isArray(c.fragments) || !c.fragments.every((f) => typeof f === 'string' && f.endsWith('_') && cliOwned.test(f))) {
    return { ok: false, error: 'provenance.census.fragments is not a list of CLI-owned prefix fragments' }
  }
  const fr = p.familyRules
  if (!Array.isArray(fr) || !fr.every((r) => r && typeof r.id === 'string' && r.id.length > 0 && typeof r.why === 'string' && r.why.length > 0)) {
    return { ok: false, error: 'provenance.familyRules is missing or malformed' }
  }
  const familyIds = new Set(fr.map((r) => r.id))
  if (!Array.isArray(m.entries) || m.entries.length === 0) return { ok: false, error: 'entries is empty' }
  const seen = new Set<string>()
  let cliOwnedFromCensus = 0
  for (const e of m.entries) {
    if (!e || typeof e.name !== 'string' || !/^[A-Z_][A-Z0-9_]*[A-Z0-9]$/.test(e.name)) {
      return { ok: false, error: `entry has a name that is not an environment variable: ${String(e?.name)}` }
    }
    if (seen.has(e.name)) return { ok: false, error: `duplicate entry ${e.name}` }
    seen.add(e.name)
    if (!KINDS.has(e.kind)) return { ok: false, error: `${e.name}: unknown kind ${String(e.kind)}` }
    if (!SETTINGS_DISPOSITIONS.has(e.settingsEnv)) return { ok: false, error: `${e.name}: bad settingsEnv` }
    if (!AMBIENT_DISPOSITIONS.has(e.ambient)) return { ok: false, error: `${e.name}: bad ambient` }
    if (typeof e.reason !== 'string' || e.reason.length === 0) return { ok: false, error: `${e.name}: missing reason` }
    // A Claude or Anthropic name may only be ruled BY NAME. A family rule is a
    // pattern, and the names that decide which account a session runs as are
    // exactly the ones that must not be settled by a pattern -- so an entry in
    // those namespaces whose reason is a family id is a manifest built the
    // wrong way, not merely one documented tersely.
    if (familyIds.has(e.reason) && cliOwned.test(e.name)) {
      return { ok: false, error: `${e.name}: ruled by the family rule "${e.reason}"; a Claude/Anthropic name needs a ruling of its own` }
    }
    if (!Array.isArray(e.sources) || e.sources.length === 0 || !e.sources.every((src: unknown) => typeof src === 'string')) {
      return { ok: false, error: `${e.name}: missing sources` }
    }
    // The second trigger of the generator's exact-ruling rule: a name the CLI
    // lists among its OWN secrets may not be family-ruled either, whatever its
    // prefix. The generator refuses to build such a manifest; this refuses to
    // load one that was edited into that state (adversarial round 7).
    if (familyIds.has(e.reason) && e.sources.includes('cli-secret-list')) {
      return { ok: false, error: `${e.name}: ruled by the family rule "${e.reason}", but the CLI lists it among its own secrets; it needs a ruling of its own` }
    }
    if (cliOwned.test(e.name) && e.sources.includes('census')) cliOwnedFromCensus += 1
  }
  if (typeof m.digest !== 'string' || m.digest !== canonicalDigest(m)) {
    return { ok: false, error: 'digest does not match the manifest contents' }
  }
  // Every CLI-owned census name is an entry (adversarial round 8). The count is
  // the form of that invariant checkable without the binary, and it is drift
  // detection, not proof: the census figures are in the digest, so an edit to
  // either side without a re-sign fails above, and this catches an entry
  // deleted with a re-sign that left the count alone. An edit that deletes an
  // entry, decrements the count and re-signs is consistent by construction and
  // is caught only by `--check` against the binary.
  if (cliOwnedFromCensus !== c.cliOwned) {
    return { ok: false, error: `provenance.census.cliOwned says ${c.cliOwned} CLI-owned census names but ${cliOwnedFromCensus} are entries` }
  }
  return { ok: true, manifest: m }
}

// Validation itself never throws at module evaluation: a validator that met a
// shape it did not anticipate is an unusable manifest, reported like any other.
const loaded: ReturnType<typeof validateAuthorityManifest> = (() => {
  try {
    return validateAuthorityManifest(manifestJson as unknown)
  } catch (err) {
    return { ok: false, error: `manifest validation threw: ${err instanceof Error ? err.message : String(err)}` }
  }
})()

/**
 * A manifest that fails validation must not silently degrade into a shorter strip
 * list -- that is the exact failure this work exists to remove. The Claude
 * package reads the derived data first thing in its factory, so an unusable
 * manifest stops startup inside `composeProviders`' error boundary (the error
 * dialog, then exit), and any later caller that reaches it fails closed.
 */
export const AUTHORITY_MANIFEST_ERROR: string | null = loaded.ok ? null : loaded.error

const MANIFEST: AuthorityManifest | null = loaded.ok ? loaded.manifest : null

export function authorityManifest(): AuthorityManifest {
  if (!MANIFEST) throw new Error(`Claude authority manifest is unusable: ${AUTHORITY_MANIFEST_ERROR ?? 'unknown'}`)
  return MANIFEST
}

/** Provenance for Sentinel and for the diagnostics surface. */
export function authorityManifestProvenance(): AuthorityProvenance | null {
  return MANIFEST?.provenance ?? null
}

// THE DERIVED DATA FAILS CLOSED -- AND ONLY WHEN FIRST USED.
//
// It used to be `MANIFEST?.entries ?? []`, so an unusable manifest produced an
// EMPTY strip list and a predicate that answered `false` for every name -- the
// "silently degrade into a shorter strip list" failure the comment above says
// must never happen (adversarial review, MAJOR). The fix derived everything at
// module evaluation through the throwing accessor, which closed that and opened
// another: `index.ts` imports `compose.ts` statically, `compose.ts` imports the
// Claude package, and so this module was evaluated -- and threw -- while the
// main process was still loading, long before `app.whenReady()` reached the
// `try` around `composeProviders()`. A malformed manifest ended the app with no
// window and no message, which is the startup failure that `try` exists to
// report (exact-head review, BLOCKER).
//
// So nothing here reads the manifest at module evaluation. Every derived value
// is built on first use through `authorityManifest()`, which throws for an
// unusable manifest; the Claude package factory asks for the ambient list while
// it is being composed, so the throw lands inside the startup boundary and the
// user sees the error dialog. Any later caller that reaches a predicate or a
// list gets the same throw -- never an empty answer. The manifest is a
// constant of the build, so the first successful derivation is memoised.
interface DerivedAuthority {
  readonly entries: readonly AuthorityEntry[]
  readonly prefixRules: readonly string[]
  readonly byLowerName: ReadonlyMap<string, AuthorityEntry>
  readonly settingsEnvStrip: readonly string[]
  readonly ambientStrip: readonly string[]
}
let derivedAuthority: DerivedAuthority | null = null

function derived(): DerivedAuthority {
  if (derivedAuthority) return derivedAuthority
  const manifest = authorityManifest()
  const entries = manifest.entries
  derivedAuthority = {
    entries,
    prefixRules: manifest.provenance.prefixRules,
    byLowerName: new Map(entries.map((e) => [e.name.toLowerCase(), e])),
    settingsEnvStrip: Object.freeze(entries.filter((e) => e.settingsEnv === 'strip').map((e) => e.name)),
    ambientStrip: Object.freeze(entries.filter((e) => e.ambient === 'strip').map((e) => e.name)),
  }
  return derivedAuthority
}

/** Every classified entry. Throws for an unusable manifest. */
export function authorityEntries(): readonly AuthorityEntry[] {
  return derived().entries
}

/**
 * The CLI's own predicate also matches two open-ended families by PREFIX
 * (`AWS_ENDPOINT_URL*`, `VERTEX_REGION_CLAUDE_*`). They are recorded as
 * provenance and deliberately do NOT drive the strip.
 *
 * D18 item 4: a shared SDK variable is removed only if a probe shows it can
 * redirect Claude on its own once the provider selectors are gone. It cannot --
 * with `CLAUDE_CODE_USE_BEDROCK` absent, setting
 * `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` left the CLI on `firstParty`. Classifying
 * this family by name would strip `AWS_ENDPOINT_URL` out of the environment
 * Claude's own Bash tool inherits, breaking `aws` for no security gain.
 */
/** The family rules the manifest was built with, written once. An entry whose
 *  `reason` is one of these ids was ruled by that rule rather than by name. */
export function claudeAuthorityFamilyRules(): readonly { id: string; why: string }[] {
  return authorityManifest().provenance.familyRules
}
export function claudeCliPrefixRules(): readonly string[] {
  return derived().prefixRules
}

/** Names removed from the `env` block of the app-owned settings copy. */
export function claudeSettingsEnvStrip(): readonly string[] {
  return derived().settingsEnvStrip
}

/** Names removed from the inherited environment of a managed launch. */
export function claudeAmbientStrip(): readonly string[] {
  return derived().ambientStrip
}

/**
 * Is this key authority-bearing in a settings `env` block?
 *
 * Case-insensitive on every platform, not only Windows: the CLI upper-cases
 * before testing, and a settings `env` block is hand-written JSON, so
 * `anthropic_api_key` in a poisoned file must not survive a pass that only knows
 * the canonical spelling.
 */
export function isClaudeSettingsEnvAuthority(name: string): boolean {
  if (typeof name !== 'string') return false
  return derived().byLowerName.get(name.toLowerCase())?.settingsEnv === 'strip'
}

/** Is this an inherited environment name a managed launch must remove? */
export function isClaudeAmbientAuthority(name: string): boolean {
  if (typeof name !== 'string') return false
  return derived().byLowerName.get(name.toLowerCase())?.ambient === 'strip'
}

/** The recorded classification for a name, or null if the manifest has none. */
export function authorityEntryFor(name: string): AuthorityEntry | null {
  if (typeof name !== 'string') return null
  return derived().byLowerName.get(name.toLowerCase()) ?? null
}
