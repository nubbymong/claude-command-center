#!/usr/bin/env node
// WP1 Gate 0 / merge gate: repository-wide legacy Codex manifest (WP1.67).
//
// Runs a fixed set of search predicates over every TRACKED file and emits an
// ordered, digest-bound list of matched paths with the predicate ids that hit.
// The disposition ledger (tests/wp1/legacy-codex-ledger.json) must carry one
// decided entry per matched path. `checkLedger` is the merge gate and is
// deliberately strict in both directions:
//   - every matched path needs a ledger entry (UNMATCHED);
//   - a ledger entry whose predicate hits changed needs re-dispositioning
//     (PREDICATE DRIFT), so an already-listed file cannot quietly acquire a
//     new legacy code path;
//   - the predicate SET, the exclusion list and the scope functions are
//     digest-bound together (PREDICATE SET CHANGED), so none of them can be
//     weakened and the affected rows dropped in the same commit;
//   - `delete` entries must be gone and relocated `move` entries must have
//     landed at their `newPath` once the candidate phase is declared
//     (NOT RETIRED / NOT MOVED / MOVE TARGET MISSING); files WP1 adds that
//     match the predicates need an `added` entry;
//   - a `replace` / in-place `move` / `defer` row whose path stops matching
//     is STALE unless it is marked `resolved: true` with `resolvedEvidence`
//     (the terminal state: the work landed and the file no longer names
//     Codex), so completing a disposition never erases its audit trail;
//   - evidence must name a WP1.* item and, for anything but `retain`, a
//     test or evidence path (VACUOUS EVIDENCE);
//   - a non-retain entry that says it adapts a test (`adaptsTests`) contradicts
//     a ledger that marks that test `retain` (CONTRADICTION);
//   - a `move` whose note announces a relocation needs a `newPath`
//     (RELOCATION WITHOUT NEWPATH);
//   - tracked files outside every predicate scope are listed, and any of them
//     that mentions codex fails the gate (UNSCOPED MENTION).
//
// Keyword manifests find what names Codex. A surface renamed away from the
// word (a hypothetical `oai:` channel) is not legacy Codex code and is outside
// this gate; the dependency-boundary tests, not this manifest, own that class.
//
// Usage:
//   node scripts/wp1/legacy-codex-manifest.mjs --write <out.json>          compact manifest (committed)
//   node scripts/wp1/legacy-codex-manifest.mjs --write-full <out.json>     with matched lines (CI artifact / review aid)
//   node scripts/wp1/legacy-codex-manifest.mjs --skeleton <ledger.json> [--allow-drop]
//   node scripts/wp1/legacy-codex-manifest.mjs --check <ledger.json> [--phase gate0|candidate]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Files that are the manifest machinery itself, historical records, or binary
// by extension (genuinely binary content is also skipped by a NUL check; text
// fixtures such as .jsonl/.txt are deliberately NOT excluded so the Codex
// fixtures stay inside the gate).
export const EXCLUDE_PATH = [
  /^scripts\/wp1\//, /^tests\/wp1\//, /^docs\/wp1\//,
  /^CHANGELOG\.md$/, /^CONTEXT\.d\//, /^architecture\/decisions\//,
  /^src\/renderer\/changelog\.ts$/,
  /\.(png|jpg|jpeg|gif|ico|icns|webp|svg|woff2?|ttf|otf|mp4|zip|asar|node|exe|dll|dylib|so|pdf)$/i,
  /^package-lock\.json$/,
]

// Scope buckets decide which predicates run on a file. A tracked file outside
// every bucket is reported as `unscoped` and must not mention codex at all.
const isCode = (p) => /^(src|scripts|tests|resources|build|\.github|electron\.vite\.config\.ts|electron-builder|package\.json|playwright\.config\.ts|vitest[\w.-]*\.config\.ts|tsconfig[\w.-]*\.json|commitlint\.config\.js)/.test(p)
const isDoc = (p) => /^(README\.md|PRIVACY\.md|SECURITY\.md|CONTRIBUTING\.md|AGENTS\.md|CLAUDE\.md|CODE_OF_CONDUCT\.md|docs\/.*\.md|\.github\/.*\.md|src\/shared\/app-knowledge\.ts|src\/renderer\/tips-library\.ts)$/.test(p)
const isTest = (p) => /^tests\//.test(p)
const isRenderer = (p) => /^src\/renderer\//.test(p)
const isScoped = (p) => isCode(p) || isDoc(p) || isTest(p) || isRenderer(p)

// Each predicate: id, kind ('path' | 'line'), description, scope filter, regex.
export const PREDICATES = [
  { id: 'P01', kind: 'path', desc: 'file path names codex', scope: isCode, re: /codex/i },
  { id: 'P02', kind: 'line', desc: 'Codex IPC channel identifiers', scope: isCode,
    re: /\bIPC\.CODEX_\w+|['"]codex:(status|login|logout|testConnection)['"]|codex-review:usage/ },
  { id: 'P03', kind: 'line', desc: 'singleton Codex account store', scope: isCode, re: /useCodexAccountStore|codexAccountStore/ },
  { id: 'P04', kind: 'line', desc: 'implicit/global Codex home resolver', scope: isCode, re: /getCodexHome|CODEX_HOME|\.codex\b/ },
  { id: 'P05', kind: 'line', desc: 'provider-name conditional or codexEnabled gate', scope: isCode,
    re: /(provider|providerId|p\.id|family|source|kind|agent|typeKind)\s*[!=]==?\s*['"](codex|claude)['"]|['"](codex|claude)['"]\s*[!=]==?\s*(provider|providerId|p\.id|family|source|kind|agent)|\)\s*[!=]==?\s*['"](codex|claude)['"]|case\s+['"]codex['"]|codexEnabled|isCodex\b/ },
  { id: 'P06', kind: 'line', desc: 'Codex auth/account symbols', scope: isCode,
    re: /readCodexAuthStatus|codexLoginWithApiKey|codexLoginChatgpt|codexLoginDeviceAuth|codexLogout|codexTestConnection|runCodexProcess|runCodexStreaming|parseChatgptPlanFromJwt|readCodexAccountEmail|captureCodexSpawnIdentity|clearCodexSpawnIdentity|getCodexSpawnIdentityMap|CodexAuthStatus/ },
  { id: 'P07', kind: 'line', desc: 'Codex launch/spawn symbols', scope: isCode,
    re: /resolveCodexBinary|buildCodexSpawn|CodexProvider\b|codexOptions|CodexOptions|resolveNodeExe|getCodexResumePickerPath|deployCodexResumePickerScript|detectCodexUi|watchAndClaimRollout|removeConductorVisionFromCodexConfig/ },
  { id: 'P08', kind: 'line', desc: 'preload/renderer Codex API surface', scope: isCode,
    re: /electronAPI\.codex\b|electronAPI\.codexReview\b|^\s*codex:\s*\{|^\s*codexReview:\s*\{/ },
  { id: 'P09', kind: 'line', desc: 'ambient OpenAI credential handling', scope: isCode, re: /OPENAI_API_KEY|hasOpenAiApiKeyEnv/ },
  { id: 'P10', kind: 'line', desc: 'Codex onboarding steps', scope: isCode,
    re: /CodexStep\b|CodexSignInStep\b|['"]codexSignIn['"]|id:\s*['"]codex(SignIn)?['"]/ },
  { id: 'P11', kind: 'line', desc: 'any mention of codex in renderer source (copy, labels, tokens, conditionals; catch-all)', scope: isRenderer, re: /codex/i },
  { id: 'P12', kind: 'line', desc: 'documentation claims about Codex', scope: isDoc, re: /codex/i },
  { id: 'P13', kind: 'line', desc: 'tests exercising Codex behaviour', scope: isTest, re: /codex/i },
  { id: 'P14', kind: 'line', desc: 'any other mention of codex in main/preload/shared/scripts/resources/config source (catch-all, incl. comments)',
    scope: (p) => isCode(p) && !isRenderer(p) && !isTest(p), re: /codex/i },
]

const LINE_CAP = 400
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/** Digest of everything that decides what the manifest sees: predicates,
 *  exclusion list and scope functions. */
export function predicateDigest() {
  const preds = PREDICATES.map((p) => `${p.id}|${p.kind}|${p.re.source}|${p.re.flags}|${p.scope.toString()}`)
  const excl = EXCLUDE_PATH.map((r) => `X|${r.source}|${r.flags}`)
  const scopes = [isCode, isDoc, isTest, isRenderer, isScoped].map((f) => `S|${f.toString()}`)
  return sha256([...preds, ...excl, ...scopes].join('\n'))
}

export function trackedFiles() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
  return out.split('\0').filter(Boolean).sort()
}

export function runManifest({ full = false } = {}) {
  const all = trackedFiles()
  const excluded = all.filter((p) => EXCLUDE_PATH.some((re) => re.test(p)))
  const files = all.filter((p) => !EXCLUDE_PATH.some((re) => re.test(p)))
  const unscoped = files.filter((p) => !isScoped(p))
  const unscopedMentions = []
  const unreadable = []
  const matches = new Map() // path -> { predicates:Set, lineCount, lines:[] }
  for (const p of files) {
    const linePreds = PREDICATES.filter((pr) => pr.kind === 'line' && pr.scope(p))
    const pathPreds = PREDICATES.filter((pr) => pr.kind === 'path' && pr.scope(p) && pr.re.test(p))
    let entry = null
    const add = () => (entry ??= { predicates: new Set(), lineCount: 0, lines: [] })
    for (const pr of pathPreds) add().predicates.add(pr.id)
    let text = null
    try { text = readFileSync(resolve(ROOT, p), 'utf8') } catch { unreadable.push(p) }
    if (text !== null && !text.includes('\0')) {
      const lines = text.split(/\r?\n/)
      if (!isScoped(p)) {
        if (/codex/i.test(text)) unscopedMentions.push(p)
      } else {
        for (let i = 0; i < lines.length; i++) {
          for (const pr of linePreds) {
            if (pr.re.test(lines[i])) {
              add().predicates.add(pr.id)
              entry.lineCount++
              if (entry.lines.length < LINE_CAP) entry.lines.push({ n: i + 1, p: pr.id, t: lines[i].trim().slice(0, 160) })
            }
          }
        }
      }
    }
    if (entry) matches.set(p, entry)
  }
  const paths = [...matches.keys()].sort()
  const entries = paths.map((p) => {
    const m = matches.get(p)
    const e = { path: p, predicates: [...m.predicates].sort(), lineCount: m.lineCount }
    if (m.lineCount > LINE_CAP) e.truncated = true
    if (full) e.lines = m.lines
    return e
  })
  const pathDigest = sha256(entries.map((e) => `${e.path}\t${e.predicates.join(',')}`).join('\n'))
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  return {
    schema: 'wp1-legacy-codex-manifest/3',
    generatedAt: new Date().toISOString(),
    head, tree,
    predicateDigest: predicateDigest(),
    predicates: PREDICATES.map(({ id, kind, desc, re }) => ({ id, kind, desc, re: re.source, flags: re.flags })),
    excludePath: EXCLUDE_PATH.map((r) => r.source),
    trackedFileCount: all.length,
    excludedFileCount: excluded.length,
    scannedFileCount: files.length,
    unscopedFileCount: unscoped.length,
    unscoped,
    unscopedMentions,
    unreadable,
    matchedPathCount: paths.length,
    pathDigest,
    entries,
  }
}

export const DISPOSITIONS = new Set(['retain', 'move', 'replace', 'delete', 'defer', 'added'])
const PATH_TOKEN = /(tests|docs\/wp1|scripts\/wp1)\/[\w./-]+/
const RELOCATION_WORDS = /\bmoves?\s+(to|under|into)\b|\brelocat/i

export function checkLedger(manifest, ledger, { phase = 'gate0' } = {}) {
  const problems = []
  const candidate = phase === 'candidate'
  if (ledger.predicateDigest !== manifest.predicateDigest) problems.push(`PREDICATE SET CHANGED: ledger ${ledger.predicateDigest} vs current ${manifest.predicateDigest} (re-run --skeleton and re-disposition)`)
  if (ledger.manifestPathDigest !== manifest.pathDigest) problems.push(`MANIFEST DRIFT: ledger bound to ${ledger.manifestPathDigest}, tree yields ${manifest.pathDigest} (re-run --skeleton and reconcile)`)
  for (const p of manifest.unreadable) problems.push(`UNREADABLE tracked file: ${p}`)
  for (const p of manifest.unscopedMentions) problems.push(`UNSCOPED MENTION: ${p} mentions codex but no predicate scope covers it`)
  const entries = ledger.entries ?? []
  const seen = new Set()
  for (const e of entries) { if (seen.has(e.path)) problems.push(`DUPLICATE ledger path: ${e.path}`); seen.add(e.path) }
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const claudeChanges = new Map((ledger.claudeTestChanges ?? []).map((e) => [e.path, e]))
  const byNewPath = new Map(entries.filter((e) => e.newPath).map((e) => [e.newPath, e]))
  const current = new Map(manifest.entries.map((e) => [e.path, e]))

  for (const l of entries) {
    const tag = `${l.path} (${l.disposition})`
    if (!DISPOSITIONS.has(l.disposition)) { problems.push(`UNDECIDED: ${tag}`); continue }
    const ev = String(l.evidence ?? '').trim()
    const note = String(l.note ?? '')
    if (ev.length < 20 || !/WP1\.\d+/.test(ev)) problems.push(`VACUOUS EVIDENCE (needs >=20 chars and a WP1.* id): ${tag}`)
    if (l.disposition !== 'retain' && l.disposition !== 'defer' && !PATH_TOKEN.test(ev + ' ' + note)) problems.push(`VACUOUS EVIDENCE (non-retain needs a tests/ or docs/wp1/ path): ${tag}`)
    if (l.disposition === 'move' && !l.newPath && RELOCATION_WORDS.test(note + ' ' + ev)) problems.push(`RELOCATION WITHOUT NEWPATH: ${tag} announces a relocation but has no newPath`)
    if (l.resolved) {
      const rev = String(l.resolvedEvidence ?? '').trim()
      if (rev.length < 20 || !/WP1\.\d+/.test(rev) || !PATH_TOKEN.test(rev)) problems.push(`VACUOUS RESOLUTION (resolvedEvidence needs >=20 chars, a WP1.* id and a tests/ or docs/wp1/ path): ${tag}`)
      if (!['replace', 'move', 'defer'].includes(l.disposition) || (l.disposition === 'move' && l.newPath)) problems.push(`RESOLVED ON WRONG DISPOSITION: ${tag} (only replace, in-place move and defer have a resolved terminal state)`)
    }
    // At the candidate every tests/ or docs/wp1/ path a non-retain row cites
    // must exist: a `replace` whose replacement coverage was never written is
    // otherwise invisible to the ledger side of the gate.
    if (candidate && l.disposition !== 'retain') {
      for (const cited of (ev + ' ' + note + ' ' + String(l.resolvedEvidence ?? '')).match(new RegExp(PATH_TOKEN.source, 'g')) ?? []) {
        if (!existsSync(resolve(ROOT, cited))) problems.push(`EVIDENCE PATH MISSING: ${tag} cites ${cited}`)
      }
    }
    for (const t of l.adaptsTests ?? []) {
      const te = byPath.get(t) ?? claudeChanges.get(t)
      if (!te) problems.push(`ADAPTED TEST NOT IN LEDGER: ${tag} adapts ${t}`)
      else if (te.disposition === 'retain') problems.push(`CONTRADICTION: ${tag} adapts ${t} but the ledger marks it retain`)
    }
    const cur = current.get(l.path)
    const samePreds = cur && JSON.stringify(cur.predicates) === JSON.stringify(l.predicates ?? [])
    const inPlace = (what) => {
      if (!cur) { if (!l.resolved) problems.push(`STALE (path no longer matches; mark resolved with resolvedEvidence if the ${what} landed): ${tag}`) }
      else if (l.resolved) problems.push(`RESOLVED BUT STILL MATCHES: ${tag}`)
      else if (!samePreds) problems.push(`PREDICATE DRIFT (re-disposition required): ${tag} ledger=[${(l.predicates ?? []).join(',')}] now=[${cur.predicates.join(',')}]`)
    }
    switch (l.disposition) {
      case 'retain': case 'added':
        if (!cur) problems.push(`STALE (path no longer matches): ${tag}`)
        else if (!samePreds) problems.push(`PREDICATE DRIFT (re-disposition required): ${tag} ledger=[${(l.predicates ?? []).join(',')}] now=[${cur.predicates.join(',')}]`)
        break
      case 'replace': inPlace('replacement'); break
      case 'defer': inPlace('deferred change'); break
      case 'delete':
        if (candidate) { if (cur) problems.push(`NOT RETIRED: ${tag} still matches at the candidate`) }
        else if (!cur) problems.push(`STALE (path no longer matches): ${tag}`)
        else if (!samePreds) problems.push(`PREDICATE DRIFT (re-disposition required): ${tag}`)
        break
      case 'move':
        if (l.newPath) {
          if (candidate) {
            if (cur) problems.push(`NOT MOVED: ${tag} still matches at the candidate (expected at ${l.newPath})`)
            if (!current.get(l.newPath)) problems.push(`MOVE TARGET MISSING: ${tag} -> ${l.newPath} does not match the predicates`)
          } else if (!cur) problems.push(`STALE (path no longer matches): ${tag}`)
        } else inPlace('adaptation')
        break
    }
  }
  for (const e of manifest.entries) {
    if (!byPath.has(e.path) && !byNewPath.has(e.path)) problems.push(`UNMATCHED (no ledger entry): ${e.path} [${e.predicates.join(',')}]`)
  }
  return problems
}

function usage(code) {
  console.error('usage: legacy-codex-manifest.mjs (--write|--write-full|--skeleton|--check) <file> [--phase gate0|candidate] [--allow-drop]')
  process.exit(code)
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  const [, , mode, arg, ...rest] = process.argv
  if (!arg) usage(2)
  const phaseIdx = rest.indexOf('--phase')
  const phase = phaseIdx >= 0 ? rest[phaseIdx + 1] : 'gate0'
  const allowDrop = rest.includes('--allow-drop')
  if (mode === '--write' || mode === '--write-full') {
    const m = runManifest({ full: mode === '--write-full' })
    writeFileSync(arg, JSON.stringify(m, null, 2) + '\n')
    console.log(`manifest: ${m.matchedPathCount} paths matched of ${m.scannedFileCount} scanned (${m.trackedFileCount} tracked, ${m.excludedFileCount} excluded, ${m.unscopedFileCount} unscoped, ${m.unscopedMentions.length} unscoped mentions); pathDigest ${m.pathDigest}; predicateDigest ${m.predicateDigest}`)
  } else if (mode === '--skeleton') {
    const m = runManifest()
    const existing = existsSync(arg) ? JSON.parse(readFileSync(arg, 'utf8')) : { schema: 'wp1-legacy-codex-ledger/2', entries: [] }
    const byPath = new Map(existing.entries.map((e) => [e.path, e]))
    const stillMatches = (e) => m.entries.some((x) => x.path === e.path)
    const keepAnyway = (e) => e.disposition === 'delete' || e.resolved || (e.disposition === 'move' && e.newPath)
    const dropped = existing.entries.filter((e) => !stillMatches(e) && !keepAnyway(e))
    if (dropped.length && !allowDrop) {
      console.error(`refusing to drop ${dropped.length} ledger row(s) whose path no longer matches (mark them resolved, or pass --allow-drop):`)
      dropped.forEach((e) => console.error(`  - ${e.path} (${e.disposition})`))
      process.exit(1)
    }
    const kept = existing.entries.filter((e) => stillMatches(e) || keepAnyway(e))
    const added = m.entries.filter((e) => !byPath.has(e.path)).map((e) => ({ path: e.path, predicates: e.predicates, category: 'TODO', disposition: 'UNDECIDED', evidence: '', note: '' }))
    for (const e of kept) { const cur = m.entries.find((x) => x.path === e.path); if (cur) e.predicates = cur.predicates }
    const entries = [...kept, ...added].sort((a, b) => a.path.localeCompare(b.path))
    writeFileSync(arg, JSON.stringify({ ...existing, schema: 'wp1-legacy-codex-ledger/2', predicateDigest: m.predicateDigest, manifestPathDigest: m.pathDigest, manifestHead: m.head, entries }, null, 2) + '\n')
    dropped.forEach((e) => console.log(`dropped: ${e.path} (${e.disposition})`))
    console.log(`skeleton: ${entries.length} entries (${entries.filter((e) => e.disposition === 'UNDECIDED').length} undecided, ${added.length} new, ${dropped.length} dropped)`)
  } else if (mode === '--check') {
    const m = runManifest()
    const ledger = JSON.parse(readFileSync(arg, 'utf8'))
    const problems = checkLedger(m, ledger, { phase })
    if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} problem(s); phase ${phase}; pathDigest ${m.pathDigest}`); process.exit(1) }
    console.log(`ledger complete: ${m.matchedPathCount} matched paths all dispositioned; phase ${phase}; pathDigest ${m.pathDigest}`)
  } else usage(2)
}
