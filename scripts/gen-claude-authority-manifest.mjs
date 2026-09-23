#!/usr/bin/env node
// MAINTAINER-ONLY evidence tool. Regenerates the Claude authority manifest from a
// pinned Claude Code binary.
//
// THIS SCRIPT IS NEVER RUN BY A BUILD, BY PACKAGING, BY CI, BY APPLICATION
// STARTUP OR BY A ROUTINE SENTINEL CHECK. Nothing in `src/` imports it, no npm
// lifecycle hook calls it, and the test suite does not require it. It exists so a
// maintainer can re-derive `claude-authority-manifest.json` when the pinned CLI
// moves, and so that derivation is reproducible rather than remembered.
//
// The Claude binary is proprietary: it is READ here and never copied, excerpted,
// bundled or committed. Only the extracted variable NAMES, the classification and
// the provenance stamp are written out.
//
//   node scripts/gen-claude-authority-manifest.mjs --binary <path-to-claude> [--out <path>] [--check]
//
//   --check  re-derive and compare against the checked-in manifest without
//            writing (exit 1 on any difference). Requires the CLI; CI does NOT
//            run this -- CI validates the manifest's schema and internal digest
//            instead, which needs no proprietary binary.
//
// WHAT IS EXTRACTED, AND FROM WHERE (Claude Code 2.1.278, win32-x64).
// THREE independent enumerations inside the CLI, because no one of them is
// complete -- plus a CENSUS of the whole binary (source 7), because three
// review rounds each found one more enumeration the anchors missed, and a short
// repo-classified list for what none of them lists:
//
//   1. `settings-env-filter` -- the Set the CLI builds and then consults as
//      `Ai.has(key.toUpperCase())` to OMIT keys from a settings `env` block
//      (`Va` resolves to lodash `omitBy`: `Zs(obj, negate(iteratee(pred)))`).
//      These are the names the CLI itself refuses to honour from a settings
//      payload it has not verified.
//
//   2. `host-managed-suppression` -- the set + prefix rules behind the predicate
//      the CLI uses when `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is in force, the
//      one that emits `Ignoring <NAME> from <source> - this session's provider
//      routing is managed by the host`. Built from spreads, so the extractor
//      resolves them.
//
//   3. `session-carrier` -- the Set of environment names the CLI carries across
//      its own session/bridge boundary. Not a settings filter at all, which is
//      why the first two anchors do not reach it, and where the account
//      IDENTITY names live (`CLAUDE_CODE_ACCOUNT_UUID`,
//      `CLAUDE_CODE_ORGANIZATION_UUID`, `CLAUDE_CODE_USER_EMAIL`, each read
//      straight off `process.env`).
//
// Set 1 does NOT contain ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL /
// CLAUDE_CODE_USE_BEDROCK; set 2 does; neither contains the identity names in
// set 3. That is precisely why a single hand-maintained list kept missing
// names -- and why set 3 was itself found by an adversarial pass rather than by
// this extraction. Adding an enumeration is cheap; assuming the ones you have
// are all of them is what costs.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  classify,
  CLI_OWNED_NAMESPACES,
  CLI_OWNED_NAMESPACE_RE,
  CLI_OWNED_CENSUS_FRAGMENTS,
  AUTHORITY_FAMILY_RULES,
  MANIFEST_SCHEMA_VERSION,
  canonicalManifestDigest,
  repoAddedOccurrence,
} from './claude-authority-classification.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = path.join(HERE, '..', 'src', 'main', 'providers', 'claude', 'claude-authority-manifest.json')

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}
const CHECK = process.argv.includes('--check')
const OUT = arg('--out') ?? DEFAULT_OUT

function defaultBinary() {
  const candidates = [
    process.env.CLAUDE_BINARY,
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  ].filter(Boolean)
  return candidates.find((c) => existsSync(c))
}
const BINARY = arg('--binary') ?? defaultBinary()

if (!BINARY || !existsSync(BINARY)) {
  console.error(
    [
      'gen-claude-authority-manifest: no Claude Code binary found.',
      '',
      'This is a MAINTAINER-ONLY tool and the binary is deliberately not vendored.',
      'Pass one explicitly:',
      '  node scripts/gen-claude-authority-manifest.mjs --binary <path-to-claude>',
      '',
      'Nothing else in this repo needs it: the build, the packaged app and the full',
      'test suite all run without Claude Code installed.',
    ].join('\n'),
  )
  process.exit(2)
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------
const bytes = readFileSync(BINARY)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const text = bytes.toString('latin1')

function cliVersion() {
  try {
    const out = execFileSync(BINARY, ['--version'], { encoding: 'utf8', timeout: 60000 })
    return (out.match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// extraction primitives
// ---------------------------------------------------------------------------
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

function fail(msg) {
  console.error(`gen-claude-authority-manifest: ${msg}`)
  console.error('The binary layout changed. Re-read the anchors before trusting any output.')
  process.exit(3)
}

/** Balanced `[...]` starting at `open`. */
function balanced(open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]
    if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return null
}

/**
 * Nearest declaration of `name` AT OR BEFORE `near`.
 *
 * Minified bundles reuse short identifiers across chunks -- a naive global search
 * for `cn=[` finds an unrelated module's array of directory names
 * (`node_modules`, `venv`, ...). Scoping the lookup to the nearest preceding
 * declaration is what JS itself does, and the all-caps assertion below is the
 * backstop that makes a wrong match loud instead of silent.
 */
function findDeclNear(name, near) {
  const re = new RegExp(`(?:var |[,;}{\\s])${name}=(?:new Set\\()?\\[`, 'g')
  let best = null
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > near) break
    best = m.index
  }
  if (best === null) return null
  const open = text.indexOf('[', best)
  return { at: open, body: balanced(open) }
}

/** Literal names + resolved spreads of the array declared for `name`. */
function resolveNames(name, near, depth = 0, trail = []) {
  if (depth > 8) fail(`spread resolution for ${name} exceeded depth 8 (${trail.join(' -> ')})`)
  const decl = findDeclNear(name, near)
  if (!decl || decl.body === null) fail(`could not resolve declaration for ${name} (${trail.join(' -> ')})`)
  const out = []
  for (const m of decl.body.matchAll(/"([^"\\]*)"/g)) out.push(m[1])
  for (const m of decl.body.matchAll(/\.\.\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    out.push(...resolveNames(m[1], decl.at, depth + 1, [...trail, name]))
  }
  return out
}

function assertNames(names, label) {
  const bad = names.filter((n) => !NAME_RE.test(n))
  if (bad.length) {
    fail(`${label} produced ${bad.length} value(s) that are not environment variable names: ${bad.slice(0, 8).join(', ')}`)
  }
  return [...new Set(names)].sort()
}

// ---------------------------------------------------------------------------
// source 1: the settings `env` filter set
// ---------------------------------------------------------------------------
const SETTINGS_ANCHOR = '.map((e)=>e.toUpperCase()));function vi(e)'
const settingsAt = text.indexOf(SETTINGS_ANCHOR)
if (settingsAt === -1) fail('settings-env filter anchor not found')
const settingsArrEnd = settingsAt
if (text[settingsArrEnd - 1] !== ']') fail('settings-env filter anchor is not preceded by an array literal')
let d = 0
let settingsArrStart = -1
for (let i = settingsArrEnd - 1; i >= 0; i -= 1) {
  if (text[i] === ']') d += 1
  else if (text[i] === '[') {
    d -= 1
    if (d === 0) {
      settingsArrStart = i
      break
    }
  }
}
if (settingsArrStart === -1) fail('settings-env filter array literal is unbalanced')
const settingsEnvFilter = assertNames(
  [...text.slice(settingsArrStart, settingsArrEnd).matchAll(/"([^"\\]*)"/g)].map((m) => m[1]),
  'settings-env filter',
)

// ---------------------------------------------------------------------------
// source 2: the host-managed suppression set + its prefix rules
// ---------------------------------------------------------------------------
const HOST_ANCHOR = /function (T8t|[A-Za-z0-9_$]+)\(e\)\{let n=e\.toUpperCase\(\);return ([A-Za-z0-9_$]+)\.has\(n\)\|\|([A-Za-z0-9_$]+)\.some\(\(s\)=>n\.startsWith\(s\)\)\|\|([A-Za-z0-9_$]+)\.some\(\(s\)=>n\.startsWith\(s\)\)\}/
const hostMatch = text.match(HOST_ANCHOR)
if (!hostMatch) fail('host-managed suppression predicate not found')
const hostAt = hostMatch.index
const [, , setVar, prefixVarA, prefixVarB] = hostMatch
const hostManaged = assertNames(resolveNames(setVar, hostAt), 'host-managed suppression set')
const hostPrefixes = [...new Set([...resolveNames(prefixVarA, hostAt), ...resolveNames(prefixVarB, hostAt)])].sort()
if (!hostPrefixes.length) fail('host-managed prefix rules resolved to nothing')

// Two further sets the same filter consults when the host FLAG (as opposed to a
// desktop-host marker) is set: proxy names and TLS/client-certificate names.
const PROXY_ANCHOR = /var ([A-Za-z0-9_$]+)=new Set\(\["HTTP_PROXY","HTTPS_PROXY","NO_PROXY"\]\)/
const proxyMatch = text.match(PROXY_ANCHOR)
if (!proxyMatch) fail('proxy suppression set not found')
const hostFlagProxy = assertNames(resolveNames(proxyMatch[1], proxyMatch.index + proxyMatch[0].length), 'proxy set')

const TLS_ANCHOR = /var ([A-Za-z0-9_$]+)=new Set\(\["CLAUDE_CODE_CLIENT_CERT"/
const tlsMatch = text.match(TLS_ANCHOR)
if (!tlsMatch) fail('TLS/client-certificate suppression set not found')
const hostFlagTls = assertNames(resolveNames(tlsMatch[1], tlsMatch.index + tlsMatch[0].length), 'TLS set')

// ---------------------------------------------------------------------------
// source 5: the session/bridge env CARRIER set
// ---------------------------------------------------------------------------
// A THIRD enumeration, and the reason this file now says "three" where it used
// to say "two". The first two sets are about what the CLI REFUSES from an
// unverified settings payload; this one is the set of environment names the CLI
// carries across its own session boundary -- and it is where the account
// IDENTITY names live. They are read straight off `process.env`:
//   `ae().oauthAccount?.accountUuid || process.env.CLAUDE_CODE_ACCOUNT_UUID`
//   `let r = process.env.CLAUDE_CODE_ORGANIZATION_UUID; if (r) n["X-Organizati..."]`
// Neither of the first two anchors reaches this set, so an inherited value for
// either name passed both strip layers untouched -- which is exactly the class
// of contamination the generated manifest exists to close, and it was found by
// an adversarial pass rather than by the extraction.
//
// SCOPE, stated precisely: this extracts the ONE set the anchor names. Sibling
// Sets are declared at the same site (a workflow set, a cowork/forwarding set,
// and smaller ones). They are NOT extracted, because they have no anchor of
// their own and picking them up by "whatever is declared nearby" is the same
// loose heuristic that once injected `node_modules` and `venv` into the
// authority list. They remain a known gap, recorded in the evidence doc.
const CARRIER_ANCHOR = /var ([A-Za-z0-9_$]+)=new Set\(\["CLAUDE_CODE_REMOTE","CLAUDE_CODE_REMOTE_HERMETIC_MODE"/
const carrierMatch = text.match(CARRIER_ANCHOR)
if (!carrierMatch) fail('session/bridge env carrier set not found')
const sessionCarrier = assertNames(
  resolveNames(carrierMatch[1], carrierMatch.index + carrierMatch[0].length),
  'session carrier set',
)

// ---------------------------------------------------------------------------
// source 6: names this repo adds on its own judgement
// ---------------------------------------------------------------------------
// The two CLI enumerations are what the CLI singles out. That is not the same
// as every name deciding which stored identity a launch resolves, and the
// difference is not hypothetical: a credential-STORE selector is read long
// before either filter is consulted, so neither set lists it. A name here is
// one AICC classifies as authority although the extraction does not produce it.
//
// The rule that keeps this from drifting back into folklore: each one must
// OCCUR in the pinned binary, and a name that has gone away is a hard failure
// rather than a quiet carry-forward.
const REPO_ADDED = ['CLAUDE_CODE_FORCE_WINDOWS_CREDMAN']
const repoAddedAt = new Map()
for (const name of REPO_ADDED) {
  const at = repoAddedOccurrence(text, name)
  if (at === -1) {
    fail(`repo-added name ${name} does not occur in this binary as a read environment name; re-check the classification before shipping the manifest`)
  }
  repoAddedAt.set(name, at)
}

// ---------------------------------------------------------------------------
// source 7: the CLI's own SECRET-NAME lists
// ---------------------------------------------------------------------------
// Not a strip list -- a list of names the CLI ITSELF calls secrets, which it
// redacts and refuses to forward. It is extracted for one reason: membership
// FORCES AN EXACT RULING (see `requiresExactRuling`), so a family rule may not
// settle one of these by pattern.
//
// That is a fix for a real defect, not a precaution. `ENVIRONMENT_SERVICE_KEY`
// sits in this list between `MCP_XAA_IDP_CLIENT_SECRET` and
// `SELF_HOSTED_RUNNER_POOL_SECRET`; it is read by the environments worker and
// passed as `authToken` on an Anthropic-side request. The
// `third-party-dev-credential` family rule had it written into its own regex
// and ruled it KEEP on both axes, with a reason -- "it authenticates that tool,
// not Claude" -- that was false of it. `requiresExactRuling` could not catch
// that, because it tests for a CLAUDE/ANTHROPIC prefix and this name has
// neither (adversarial round 4).
//
// The general shape of the defect: a family rule is a pattern, and a pattern
// cannot know that one member of its family is a Claude credential wearing a
// third party's name. The CLI knows. So the CLI's own designation is what
// decides whether a name may be ruled by family at all.
const SECRET_LIST_ANCHORS = [
  /var ([A-Za-z0-9_$]+)=\["CLAUDE_CODE_OAUTH_REFRESH_TOKEN","CLAUDE_SESSION_INGRESS_TOKEN_FILE"/,
  /([A-Za-z0-9_$]+)=\["AWS_CONTAINER_AUTHORIZATION_TOKEN","ANTHROPIC_IDENTITY_TOKEN"/,
]
const cliSecretNames = []
const cliSecretAt = []
for (const anchor of SECRET_LIST_ANCHORS) {
  const m = text.match(anchor)
  if (!m) fail(`CLI secret-name list not found (anchor ${anchor})`)
  cliSecretAt.push(m.index)
  cliSecretNames.push(...resolveNames(m[1], m.index + m[0].length))
}
// Case matters here and nowhere else in this file: these lists carry the
// lowercase proxy spellings (`https_proxy`) beside the uppercase ones, and
// those are real, distinct variables on POSIX. `assertNames` would reject them
// as malformed, so they are filtered rather than asserted -- the uppercase
// spelling of each is already in the list.
const cliSecretList = [...new Set(cliSecretNames.filter((n) => NAME_RE.test(n)))].sort()
if (!cliSecretList.length) fail('CLI secret-name lists resolved to nothing')

// ---------------------------------------------------------------------------
// source 8: the CENSUS -- stop finding enumerations one review round at a time
// ---------------------------------------------------------------------------
// Three adversarial rounds each found ONE more hand-anchored Set, and each time
// the fix was to add an anchor. That is the defect, not the Sets: an anchor list
// is a denylist of places to look, and the fourth family it missed contained a
// path the CLI reads and JSON-parses as an auth snapshot, plus a bearer token
// for a socket that relays messages into the session.
//
// So the binary is CENSUSED instead, through the five read forms
// `censusEnvNames` documents one by one below. The census is a GATE, not a
// strip list: a censused name that is AUTHORITY-SHAPED, or that sits in one of
// the CLI's OWN namespaces, must have a classification or the run is a hard
// failure, exactly like an unclassified extracted name. Until adversarial
// round 8 the second clause was written here and not implemented: only the
// shaped names reached `classify`, so six hundred CLI-owned names were counted
// and digested and never asked about, and the account half of an identity
// pair (`..._OWNER_ACCT`, beside a stripped `..._OWNER_ORG`) went unruled
// because ACCT is not a shape the pattern knew. A shape pattern is a denylist
// of shapes. Now every CLI-owned census name becomes an entry with a ruling of
// its own; third-party names still qualify by shape alone, and the rest are
// counted and digested, not carried. A CLI that adds names in its own
// namespaces fails this generator until each is ruled.
//
// Names that END in `_` are prefix FRAGMENTS of names the CLI assembles at run
// time (`startsWith` sweeps, scrub lists). They are not variables: they are
// excluded from the entries, must match the list the classification module
// declares, and are recorded in `provenance.census.fragments` so the residual
// "a name assembled at run time is invisible to a literal scan" names the
// prefixes it is known to hide behind.
//
// WHAT THE CENSUS IS NOT. It is not "every" anything, and an earlier version of
// this paragraph said it was. Three things it provably does not see, in the
// pinned binary (2.1.278, win32-x64, sha256 006ea5c8...cced8):
//   - a name ASSEMBLED AT RUNTIME from fragments, which no literal scan can find;
//   - an environment list with NO namespaced member -- the run rule drops the
//     Azure identity SDK's nine-name list and a four-name GitHub token Set.
//     Nothing authority-bearing is lost that way in this binary (those names
//     arrive by another form, or are third-party and kept), but it is a false
//     negative by construction, not a guarantee;
//   - a THIRD-PARTY name whose SHAPE the pattern below does not describe. Two
//     rounds each found one (`RATE_LIMIT`, `ENV_SCRUB`, then `_OVERRIDES`): such
//     a name is in the census and never becomes an entry, so the gate never
//     asks. Since round 8 this is true of third-party names only; a name in a
//     CLI-owned namespace becomes an entry whatever its shape.
//
// The shape test is a pattern over NAMES, and it fails LOUD rather than silent:
// anything matching must be ruled on. That is a different thing from a denylist
// of exact names, which is what kept missing them.
// Two filters, and a name qualifies on EITHER. The namespace list alone was a
// blind spot of exactly the kind it was written to remove: `MCP_CLIENT_SECRET`
// and `MCP_XAA_IDP_CLIENT_SECRET` are CLI-documented OAuth client secrets read
// from the environment, and `MCP_` is not a namespace this app had listed, so
// no census method could see them (adversarial round 3). The SHAPE test now
// qualifies a name on its own, whatever its prefix.
// The CLI's OWN namespaces come from the classification module, so the census
// and the exact-ruling rule cannot disagree about which prefixes are Claude's.
// The rest are third parties whose members the census inventories and the
// family rules settle.
const THIRD_PARTY_NAMESPACES = ['AWS', 'GOOGLE', 'GCLOUD', 'GCE', 'CLOUD_ML', 'VERTEX', 'HTTPS?_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS', 'NODE_OPTIONS', 'METADATA_SERVER', 'API_FORCE', 'DISABLE_GROWTHBOOK', 'CLIENT_CERT', 'CLIENT_KEY', 'OTEL', 'MCP_']
const CENSUS_NAMESPACES = new RegExp(`^(${[...CLI_OWNED_NAMESPACES, ...THIRD_PARTY_NAMESPACES].join('|')})`)
const AUTHORITY_SHAPED = /(TOKEN|_KEY$|_KEY_|APIKEY|SECRET|CRED|PASSWORD|AUTH|OAUTH|LOGIN|SESSION_ID|UUID|_EMAIL|ACCOUNT|ORGANIZATION|_ORG|WORKSPACE|PROFILE|BASE_URL|ENDPOINT|_URL$|_HOST$|_ORIGIN$|CONFIG_DIR|SETTINGS_PATH|SETTINGS_FILE|_DIR$|IDENTITY|BEARER|CERT|_PATH$|SOCKET|USE_BEDROCK|USE_VERTEX|GATEWAY|FEDERATION|SUBSCRIPTION|RATE_LIMIT|ENV_SCRUB|_OVERRIDES$|BILLING|GRANT|ALLOWLIST|PAIRED|DEVICE_ID)/
const qualifies = (n) => NAME_RE.test(n) && (CENSUS_NAMESPACES.test(n) || AUTHORITY_SHAPED.test(n))

// How far apart two quoted literals may sit and still count as members of one
// list. Wide enough to step over a spread, a short call or a comma-comment;
// narrow enough that two unrelated literals in different statements do not
// merge into one run.
const LIST_GAP = 40

function censusEnvNames() {
  const found = new Set()

  // (b) direct reads. The only NON-namespaced form that qualifies on shape
  //     alone, because `process.env.NAME` is unambiguous.
  for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
    if (qualifies(m[1])) found.add(m[1])
  }

  const literals = []
  for (const m of text.matchAll(/"([A-Z_][A-Z0-9_]{2,})"/g)) literals.push([m.index, m[1]])

  // (a) LIST RUNS, not bracket literals.
  //
  // The first version matched `["A","B",...]` as one regex, so a single spread
  // inside the array made the whole thing stop matching -- and the CLI's token
  // list is exactly `["CLAUDE_CODE_OAUTH_TOKEN",...Bkt,"CLAUDE_CODE_HFI_BEARER_TOKEN",...]`,
  // which contributed NOTHING while every name in it was a bearer token
  // (adversarial round 4). Runs are built from adjacency instead, so anything
  // may sit between two members.
  //
  // A run is an ENVIRONMENT list when at least ONE member is namespaced. That
  // is a PRESENCE test, deliberately not the majority vote round 3 removed:
  // the secret-redaction list is four Claude names out of nine, and 4 >= 1
  // passes where 4/9 did not. It is also what keeps the census off the bundle's
  // error-code enums (`ERR_MYSQL_AUTHENTICATION_FAILED`, `UNAUTHENTICATED`),
  // which are the same SHAPE as a credential name and are not variables.
  let run = []
  const flushRun = () => {
    if (run.length >= 2 && run.some(([, n]) => CENSUS_NAMESPACES.test(n))) {
      for (const [, n] of run) if (qualifies(n)) found.add(n)
    }
    run = []
  }
  for (const [at, n] of literals) {
    if (run.length) {
      const [prevAt, prevName] = run[run.length - 1]
      if (at - (prevAt + prevName.length + 2) > LIST_GAP) flushRun()
    }
    run.push([at, n])
  }
  flushRun()

  // (c) reads through the bundle's minified alias for `process.env`.
  //
  // NAMESPACE-restricted, unlike (b): an alias read is `<something>.NAME`,
  // which is also the shape of every enum member in every bundled dependency
  // (`ATTR_URL_PATH`, `AUTHORIZATION_PENDING`, `BEARER`), so without the
  // namespace it censuses the whole bundle's constants. The alias LENGTH is
  // not restricted: capping it at two characters missed
  // `this.deps.env.CLAUDE_CODE_DEBUG_LOGS_DIR`, whose alias is three
  // (adversarial round 4). Minification does not promise a short name.
  for (const m of text.matchAll(/\.([A-Z_][A-Z0-9_]{2,})\b/g)) {
    if (NAME_RE.test(m[1]) && CENSUS_NAMESPACES.test(m[1])) found.add(m[1])
  }

  // (d) object-literal KEYS, namespace-restricted.
  //
  // The read form none of the above can see. The CLI declares its environment
  // through typed schema maps -- `Cs(l,{ANTHROPIC_API_KEY:()=>ut,
  // CLAUDE_CODE_HFI_BEARER_TOKEN:()=>gt, ...})` over a proxy built with
  // `Object.defineProperty(_,r,{get:()=>process.env[r]})`. The name exists only
  // as a KEY; every consumer is rewritten to the local binding, so the variable
  // never appears as `process.env.NAME` or `alias.NAME` anywhere in the bundle.
  // Six such maps ship in this binary and the first is the CLI's own
  // authentication module (adversarial round 4).
  //
  // This also catches ordinary constants objects and the env objects the CLI
  // BUILDS for a helper it spawns. Those are false positives in the sense that
  // the CLI does not read them -- and they are ruled on anyway, by name, with a
  // reason saying which they are. Over-collecting costs a ruling;
  // under-collecting costs a bearer token.
  for (const m of text.matchAll(/[{,]\s*([A-Z_][A-Z0-9_]{2,})\s*:/g)) {
    if (NAME_RE.test(m[1]) && CENSUS_NAMESPACES.test(m[1])) found.add(m[1])
  }

  // (e) a standalone quoted literal, namespace-restricted.
  //
  // `R("ANTHROPIC_ENVIRONMENT_KEY")` -- a helper taking the name as its only
  // argument, so the literal has no list to belong to and no key to be. That is
  // how the environments worker reads the key it then sends as `authToken`.
  for (const [, n] of literals) {
    if (NAME_RE.test(n) && CENSUS_NAMESPACES.test(n)) found.add(n)
  }

  return [...found].sort()
}

const census = censusEnvNames()
const censusDigest = createHash('sha256').update(census.join('\n')).digest('hex')
const censusFragments = census.filter((n) => n.endsWith('_') && CLI_OWNED_NAMESPACE_RE.test(n))
{
  const declared = [...CLI_OWNED_CENSUS_FRAGMENTS].sort()
  if (JSON.stringify(censusFragments) !== JSON.stringify(declared)) {
    fail(
      `the census found prefix fragments [${censusFragments.join(', ')}] but the classification module declares [${declared.join(', ')}]; ` +
      'update CLI_OWNED_CENSUS_FRAGMENTS so the recorded residual matches the binary',
    )
  }
}
const censusShaped = census.filter((n) => AUTHORITY_SHAPED.test(n) && !n.endsWith('_'))
const censusCliOwned = census.filter((n) => CLI_OWNED_NAMESPACE_RE.test(n) && !n.endsWith('_'))
// The entries the census carries: every CLI-owned name, plus every third-party
// name the shape test qualifies. De-duplicated, because a name can be both.
const censusEntries = [...new Set([...censusCliOwned, ...censusShaped])].sort()

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------
const sources = {
  'settings-env-filter': settingsEnvFilter,
  'host-managed-suppression': hostManaged,
  'host-flag-proxy': hostFlagProxy,
  'host-flag-tls': hostFlagTls,
  'session-carrier': sessionCarrier,
  'repo-added': assertNames(REPO_ADDED, 'repo-added names'),
  'cli-secret-list': cliSecretList,
  // Every CLI-owned name and every authority-shaped third-party name becomes
  // an entry. The rest is a count and a digest in provenance -- inventoried,
  // not carried.
  census: censusEntries,
}

const sourcesFor = new Map()
for (const [src, names] of Object.entries(sources)) {
  for (const n of names) {
    if (!sourcesFor.has(n)) sourcesFor.set(n, [])
    sourcesFor.get(n).push(src)
  }
}

const cliSecretSet = new Set(cliSecretList)
const allNames = [...sourcesFor.keys()].sort()
const classified = new Map(allNames.map((n) => [n, classify(n, { cliSecret: cliSecretSet.has(n) })]))
const unclassified = allNames.filter((n) => !classified.get(n))
if (unclassified.length) {
  console.error(
    [
      `gen-claude-authority-manifest: ${unclassified.length} name(s) have no classification.`,
      '',
      'A new CLI version added authority names this repo has never ruled on -- either the CLI',
      'itself singles them out, or the CENSUS found an authority-SHAPED name nothing has ruled',
      'on, or the CLI lists the name among its OWN SECRETS and a family rule may therefore not',
      'settle it. Classify each one in scripts/claude-authority-classification.mjs. Deliberately',
      'a HARD FAILURE, so a CLI change cannot silently widen or narrow what a managed launch',
      'strips:',
      '',
      ...unclassified.map((n) => `  ${n}  (from ${sourcesFor.get(n).join(', ')})`),
    ].join('\n'),
  )
  process.exit(4)
}

const entries = allNames.map((name) => {
  const c = classified.get(name)
  return {
    name,
    kind: c.kind,
    settingsEnv: c.settingsEnv,
    ambient: c.ambient,
    reason: c.reason,
    sources: sourcesFor.get(name).sort(),
  }
})

const manifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  provenance: {
    cliVersion: cliVersion(),
    platform: `${process.platform}-${process.arch}`,
    binarySha256: sha256,
    binaryBytes: statSync(BINARY).size,
    extractedFrom: [
      {
        id: 'settings-env-filter',
        offset: settingsArrStart,
        what: 'the Set consulted as Ai.has(key.toUpperCase()) to OMIT keys from a settings `env` block (lodash omitBy via negate)',
      },
      {
        id: 'host-managed-suppression',
        offset: hostAt,
        what: 'the set + startsWith prefix rules behind the predicate used when CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is in force',
      },
      { id: 'host-flag-proxy', offset: proxyMatch.index, what: 'proxy names suppressed under the host flag' },
      { id: 'host-flag-tls', offset: tlsMatch.index, what: 'TLS/client-certificate names suppressed under the host flag' },
      {
        id: 'session-carrier',
        offset: carrierMatch.index,
        what: 'the Set of environment names the CLI carries across its own session/bridge boundary; where the account identity names live',
      },
      {
        id: 'cli-secret-list',
        offset: Math.min(...cliSecretAt),
        what: 'the lists the CLI itself designates as secret environment names; membership FORCES an exact ruling, so no family rule may settle one of them by pattern',
      },
      {
        id: 'census',
        offset: 0,
        what: 'the environment-shaped names this app cares about that are visible to five read forms: list runs (spread-tolerant), process.env reads, alias reads of any depth, typed env-schema object KEYS, and standalone quoted literals. Every name in a CLI-owned namespace becomes an entry, as does every AUTHORITY-SHAPED third-party name, and an unclassified one is a hard failure. NOT exhaustive: a name assembled at runtime from fragments is invisible to any literal scan; the prefixes such names are known to hide behind are recorded in census.fragments',
      },
      {
        id: 'repo-added',
        offset: Math.min(...repoAddedAt.values()),
        what: 'names AI Code Conductor classifies as authority that no CLI enumeration lists; each is asserted to occur in this binary as a read environment name',
      },
    ],
    prefixRules: hostPrefixes,
    // The CLI's own namespaces, as the generator used them. The runtime
    // validator refuses a manifest whose list is missing or narrower than its
    // floor, and the WP1 suite checks it against the classification module.
    cliOwnedNamespaces: [...CLI_OWNED_NAMESPACES],
    // The census, recorded rather than carried. `names` is everything it found;
    // `authorityShaped` and `cliOwned` are the two ways a name had to be ruled
    // on (the validator checks the second against the entries, so a manifest
    // cannot drop a CLI-owned ruling by hand); `fragments` are the run-time
    // prefixes; and the digest moves when a CLI version adds or removes ANY
    // name -- which is what turns "did we find every enumeration?" into a
    // question the tool answers.
    census: {
      names: census.length,
      authorityShaped: censusShaped.length,
      cliOwned: censusCliOwned.length,
      fragments: censusFragments,
      digest: censusDigest,
    },
    // The family rules, written once. An entry whose `reason` is one of these
    // ids was ruled by that rule rather than by name.
    familyRules: AUTHORITY_FAMILY_RULES.map((r) => ({ id: r.id, why: r.why })),
  },
  entries,
}
manifest.digest = canonicalManifestDigest(manifest)

const serialised = `${JSON.stringify(manifest, null, 2)}\n`

if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current === serialised) {
    console.log(`gen-claude-authority-manifest: checked-in manifest reproduces byte-for-byte from ${path.basename(BINARY)} (${manifest.provenance.cliVersion}).`)
    process.exit(0)
  }
  console.error('gen-claude-authority-manifest: the checked-in manifest does NOT reproduce from this binary.')
  console.error(`  checked-in bytes: ${current.length}, regenerated: ${serialised.length}`)
  console.error('  If the CLI moved, this means REVALIDATION IS REQUIRED -- not that the CLI is incompatible.')
  process.exit(1)
}

writeFileSync(OUT, serialised)
console.log(
  [
    `wrote ${path.relative(path.join(HERE, '..'), OUT)}`,
    `  cli       ${manifest.provenance.cliVersion} (${manifest.provenance.platform})`,
    `  sha256    ${sha256}`,
    `  entries   ${entries.length} (${entries.filter((e) => e.settingsEnv === 'strip').length} stripped from the settings copy, ${entries.filter((e) => e.ambient === 'strip').length} from the ambient env)`,
    `  digest    ${manifest.digest}`,
  ].join('\n'),
)
