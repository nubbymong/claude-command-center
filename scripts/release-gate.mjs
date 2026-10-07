#!/usr/bin/env node
// Release gate (#375, #385): refuse to cut a release while its milestone still
// has open issues, or while the model registry disagrees with Anthropic's
// published Claude Code model configuration.
//
// Why: 2.1.0-beta.16 was cut with book-of-work items still open after an agent
// answered "no pending work on my side". The owner's rule is that no beta is
// cut with anything outstanding except what the owner has EXPLICITLY excluded,
// and that the models the app offers follow Anthropic's support article. Both
// are now machine-checked, and the check runs where a release is actually made:
//   - scripts/release.js, before anything is written or pushed, and
//   - .github/workflows/release.yml, as the first job of every dispatch, so the
//     workflow-dispatch path (where release.js never runs) is gated too.
//
// Checks
//   1. MILESTONE  The GitHub milestone titled exactly <version> (e.g.
//      "2.1.0-beta.17") must exist and have no open issue without the
//      `excluded`, `in-beta`, or `in-release` label (an open in-beta or
//      in-release issue is done for this release — the lifecycle keeps it
//      open until promotion auto-closes it).
//      Pull requests on the milestone are ignored (they are
//      not book-of-work items). A MISSING milestone fails closed: the gate
//      cannot tell "nothing outstanding" from "nobody made the list".
//   2. MODELS  Every id in the support article's "Supported models" table
//      (resources/claude-code-model-configuration.json, refreshed by hand — the
//      fixture says how) must be covered by resources/model-registry.json. The
//      same comparison runs at runtime as a Sentinel check over the same file
//      (src/main/sentinel/sentinel-models.ts, #385); tests/unit/model-coverage-
//      parity.test.ts holds the two implementations to identical verdicts.
//      A registry id covers an article id when it is equal, or when the article
//      id is that id plus a `-YYYYMMDD` date suffix (the app resolves dated ids
//      to the undated entry by prefix; the CLI accepts both). Missing = FAIL,
//      printed as a diff. A registry Claude model the article no longer lists
//      is a WARNING (flagged, not fatal): the owner decides whether it retired.
//   3. CODEX MODELS  (P3.8, row 39) Every id in the list the supported Codex
//      CLI offers in its own model picker (resources/codex-model-catalogue.json,
//      read from the CLI's bundled catalogue; the file says how) must be a
//      pickable model of the registry's codex family, by exact id (Codex ids
//      carry no date suffix). The Sentinel Codex model check runs the same
//      comparison over the same file (evaluateCodexModelCoverage in
//      src/shared/model-registry.ts); tests/unit/model-coverage-parity.test.ts
//      holds the two to identical verdicts. Missing = FAIL, printed as a diff;
//      a pickable Codex model the list no longer names = WARNING; an empty or
//      missing list fails closed. Only an id the Codex picker offers covers
//      one, and an id the registry lists twice covers nothing and FAILs.
//   4. MACOS FLOOR  The Electron the build installs (the exact version
//      package-lock.json resolves, never package.json's range) decides the
//      oldest macOS the build opens on (Electron 44 needs macOS 13). The tag
//      being cut must carry at least that floor in
//      resources/macos-release-floors.json, which the updater reads: otherwise
//      it would offer the release to Macs that cannot open it (a rolling
//      re-release of an earlier tag, or a version below the table's first
//      entry). A tag no updater offers (a dev cut) is not held to it. A
//      missing or empty table, an entry it cannot read, or an Electron version
//      that is not an exact one, FAILs (fail closed).
//
// Usage
//   node scripts/release-gate.mjs                      # version from package.json
//   node scripts/release-gate.mjs --version 2.1.0-beta.17
//   node scripts/release-gate.mjs --repo owner/name    # default: $GITHUB_REPOSITORY, else package.json repository, else the origin remote
//   node scripts/release-gate.mjs --registry <path> --expected <path> --codex-expected <path>
//
// Auth: GITHUB_TOKEN or GH_TOKEN (read access is enough), else `gh auth token`.
//
// Exit codes: 0 = pass; 1 = REFUSED (a check failed); 2 = could not evaluate
// (network/auth/config) — also refuses, because an unevaluated gate is not a
// passed gate.
//
// Plain ESM, no dependencies: it runs on a bare CI runner before `npm ci`.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_CANNOT_EVALUATE = 2

export const EXCLUDED_LABEL = 'excluded'
/**
 * The issue-lifecycle labels (CONTRIBUTING.md): `in-beta` is applied when an
 * issue's fix MERGES TO BETA; `in-release` replaces it when an rc cut rolls
 * the issue into a release candidate (scripts/roll-issues-into-release.mjs).
 * Either way the issue stays open until promotion to main auto-closes it.
 * The gate TRUSTS these labels here: an open `in-beta`/`in-release` issue is
 * treated as done for the release being cut, because refusing on it would
 * make the gate and the lifecycle jointly forbid every cut. `in-beta` is
 * applied by hand on the beta merge, so this is a trust in the lifecycle
 * being followed, not a verification that a fix merged — the same trust
 * `excluded` already extends. Counted separately so the output still says
 * what is riding along.
 */
export const IN_BETA_LABEL = 'in-beta'
export const IN_RELEASE_LABEL = 'in-release'
export const DEFAULT_REGISTRY_PATH = path.join(ROOT, 'resources', 'model-registry.json')
// Lives under resources/ (not scripts/fixtures/) so the packaged app can read
// the SAME snapshot: the Sentinel model check imports it at runtime (#385).
export const DEFAULT_EXPECTED_PATH = path.join(ROOT, 'resources', 'claude-code-model-configuration.json')
// The Codex half's list (P3.8, row 39); the Sentinel Codex model check imports
// the same file.
export const DEFAULT_CODEX_EXPECTED_PATH = path.join(ROOT, 'resources', 'codex-model-catalogue.json')
// The macOS floor table (check 4); the updater imports the same file.
export const DEFAULT_MACOS_FLOORS_PATH = path.join(ROOT, 'resources', 'macos-release-floors.json')
// The lock file, which names the exact Electron version the build installs
// (check 4); it is tracked, so it is there before `npm ci`.
export const DEFAULT_LOCK_PATH = path.join(ROOT, 'package-lock.json')
/** The registry family whose models Codex sessions run (familyProvider in
 *  src/shared/model-registry.ts). */
export const CODEX_FAMILY = 'codex'
/** A Codex model id the picker offers and a launch takes (isCodexModelId in
 *  src/shared/model-registry.ts; the parity test holds the two together). */
export const CODEX_MODEL_ID_MAX = 64
export const CODEX_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/
export function isCodexModelId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= CODEX_MODEL_ID_MAX && CODEX_MODEL_ID_RE.test(v)
}

// ── pure helpers (unit-tested) ──────────────────────────────────────

/** Label names from the REST `labels` shape ([{name}] or [string]). */
function labelNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
}

/** @typedef {{ ok: boolean, reason: string|null, milestone: {number:number,title:string,state?:string}|null, blocking: Array<{number:number,title:string,labels:string[]}>, excluded: Array<{number:number,title:string}>, shipped: Array<{number:number,title:string}> }} MilestoneVerdict */
/** @typedef {{ ok: boolean, reason: string|null, missing: Array<{id:string,label?:string}>, extra: Array<{id:string,label?:string}>, covered: Array<{id:string,by:string}>, duplicates?: string[] }} ModelsVerdict */
/** @typedef {{ ok: boolean, reason: string|null, tag: string, offered: boolean, electronMajor: number|null, needed: number|null, floor: number|null }} MacosVerdict */

/**
 * Milestone verdict for one version.
 *
 * @param {object} input
 * @param {string} input.version          e.g. "2.1.0-beta.17" — must equal the milestone title
 * @param {Array<{number:number,title:string,state?:string}>|null} input.milestones
 * @param {Array<{number:number,title:string,labels?:any[],pull_request?:object,state?:string}>} input.issues
 *        open issues ON that milestone (already filtered by the API; re-filtered here defensively)
 * @param {string} [input.excludedLabel]
 * @param {string} [input.inBetaLabel]
 * @param {string} [input.inReleaseLabel]
 * @returns {MilestoneVerdict}
 */
export function evaluateMilestone({ version, milestones, issues, excludedLabel = EXCLUDED_LABEL, inBetaLabel = IN_BETA_LABEL, inReleaseLabel = IN_RELEASE_LABEL }) {
  const title = String(version || '').trim()
  const milestone = (milestones || []).find((m) => m && String(m.title).trim() === title) || null
  if (!milestone) {
    return {
      ok: false,
      reason: `no GitHub milestone titled "${title}" — create it (and put the release's issues on it) before cutting; the gate fails closed on a missing milestone`,
      milestone: null, blocking: [], excluded: [], shipped: [],
    }
  }
  const blocking = []
  const excluded = []
  const shipped = []
  for (const it of issues || []) {
    if (!it || it.pull_request) continue          // PRs are not book-of-work items
    if (it.state && it.state !== 'open') continue
    const labels = labelNames(it.labels)
    if (labels.includes(excludedLabel)) excluded.push({ number: it.number, title: it.title })
    // The lifecycle keeps a DONE issue open until promotion, marked `in-beta`
    // when its fix merged to beta and `in-release` once an rc cut rolled it
    // in. Either way it is the release being cut — shipping work, not
    // outstanding work.
    else if (labels.includes(inBetaLabel) || labels.includes(inReleaseLabel)) shipped.push({ number: it.number, title: it.title })
    else blocking.push({ number: it.number, title: it.title, labels })
  }
  blocking.sort((a, b) => a.number - b.number)
  excluded.sort((a, b) => a.number - b.number)
  shipped.sort((a, b) => a.number - b.number)
  return {
    ok: blocking.length === 0,
    reason: blocking.length === 0 ? null : `${blocking.length} open issue(s) on milestone "${title}" without the "${excludedLabel}", "${inBetaLabel}", or "${inReleaseLabel}" label`,
    milestone, blocking, excluded, shipped,
  }
}

/** An article id is covered by a registry id when equal, or equal minus a -YYYYMMDD suffix. */
export function registryIdCovers(registryId, expectedId) {
  if (registryId === expectedId) return true
  const m = /^(.*)-(\d{8})$/.exec(expectedId)
  return !!m && m[1] === registryId
}

/**
 * Model-registry verdict.
 *
 * @param {object} input
 * @param {{models:Array<{id:string,family?:string,label?:string}>}} input.registry   resources/model-registry.json
 * @param {{models?:Array<{id:string,label?:string}>,source?:string,fetchedAt?:string}|null|undefined} input.expected   the fixture (missing or empty fails closed)
 * @returns {ModelsVerdict}
 */
export function evaluateModels({ registry, expected }) {
  const registryModels = (registry && registry.models) || []
  const expectedModels = (expected && expected.models) || []
  // Fail closed: an empty or missing expected-models fixture (a truncated file
  // from a bad merge, say) must NOT vacuously pass -- with nothing to check the
  // loop below would leave `missing` empty and report ok. A safety gate that
  // passes because it had nothing to compare is worse than no gate.
  if (expectedModels.length === 0) {
    return {
      ok: false,
      reason: 'the expected-models fixture is empty or missing — cannot verify the registry (fail closed)',
      missing: [], extra: [], covered: [],
    }
  }
  const missing = []
  const covered = []
  const usedRegistryIds = new Set()
  for (const exp of expectedModels) {
    const hit = registryModels.find((m) => registryIdCovers(m.id, exp.id))
    if (hit) { covered.push({ id: exp.id, by: hit.id }); usedRegistryIds.add(hit.id) }
    else missing.push({ id: exp.id, label: exp.label })
  }
  // Claude models we carry that the article no longer names — flagged, not fatal.
  // Excluded: non-Claude entries (the codex family, not the article's business),
  // `articleExempt` entries (carried deliberately), and overlay entries carrying
  // `provenance` (Sentinel/user additions, necessarily absent from a snapshot
  // frozen before them). Mirrors evaluateModelCoverage in
  // src/shared/model-registry.ts — tests/unit/model-coverage-parity.test.ts
  // holds the two to identical verdicts (#385).
  const extra = registryModels
    .filter((m) => typeof m.id === 'string' && m.id.startsWith('claude-')
      && !usedRegistryIds.has(m.id) && m.articleExempt !== true && !m.provenance)
    .map((m) => ({ id: m.id, label: m.label }))
  return {
    ok: missing.length === 0,
    reason: missing.length === 0 ? null : `${missing.length} model(s) from the Claude Code model configuration article are not in the registry`,
    missing, extra, covered,
  }
}

/**
 * The Codex half's verdict (P3.8, row 39): the registry's pickable codex-family
 * models against the list the supported Codex CLI offers. A copy of
 * evaluateCodexModelCoverage in src/shared/model-registry.ts (this script runs
 * before `npm ci` and cannot import it); tests/unit/model-coverage-parity.test.ts
 * holds the two to identical verdicts.
 *
 * @param {object} input
 * @param {{models:Array<{id:string,family?:string,label?:string,pickable?:boolean,provenance?:object}>}} input.registry
 * @param {{models:Array<{id:string,label?:string}>,cliVersions?:string[],fetchedAt?:string}|null|undefined} input.expected
 * @returns {ModelsVerdict}
 */
export function evaluateCodexModels({ registry, expected }) {
  const usable = (m) => !!m && typeof m.id === 'string' && m.id.length > 0
  // Round 2 (GS): a file whose `models` is not a list reads as empty (fail
  // closed); an id listed twice covers nothing (the pickers would disagree
  // about it); only an id the Codex picker offers covers one.
  const entries = (registry && Array.isArray(registry.models) ? registry.models : []).filter(usable)
  const count = new Map()
  for (const m of entries) count.set(m.id, (count.get(m.id) || 0) + 1)
  const expectedModels = (expected && Array.isArray(expected.models) ? expected.models : []).filter(usable)
  const listed = new Set(expectedModels.map((m) => m.id))
  const duplicates = [...count].filter(([id, n]) => n > 1
    && (listed.has(id) || entries.some((m) => m.id === id && m.family === CODEX_FAMILY))).map(([id]) => id)
  const codexModels = entries.filter((m) => m.family === CODEX_FAMILY && m.pickable !== false
    && isCodexModelId(m.id) && count.get(m.id) === 1)
  // Fail closed, as the Claude half: a list with nothing in it must not pass.
  if (expectedModels.length === 0) {
    return {
      ok: false,
      reason: 'the expected Codex models list is empty or missing, so the registry cannot be verified (fail closed)',
      missing: [], extra: [], covered: [],
    }
  }
  const missing = []
  const covered = []
  for (const exp of expectedModels) {
    const hit = codexModels.find((m) => m.id === exp.id)
    if (hit) covered.push({ id: exp.id, by: hit.id })
    else missing.push({ id: exp.id, label: exp.label })
  }
  // A pickable Codex model the list no longer names -- flagged, not fatal.
  // Overlay entries (they carry `provenance`) are never flagged: a model the
  // overlay just added is necessarily absent from a list read before it.
  const extra = codexModels
    .filter((m) => !listed.has(m.id) && !m.provenance)
    .map((m) => ({ id: m.id, label: m.label }))
  return {
    ok: missing.length === 0 && duplicates.length === 0,
    reason: missing.length > 0 ? `${missing.length} model(s) the Codex CLI lists are not in the registry`
      : duplicates.length > 0 ? `${duplicates.length} Codex model id(s) are listed more than once in the registry` : null,
    missing, extra, covered, duplicates,
  }
}

// -- the macOS floor (check 4) --

/** A release tag's ordering parts; a copy of parseTag in src/main/github-update.ts. */
function parseReleaseTag(tag) {
  const m = String(tag).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)(?:\.(\d+))?)?$/)
  if (!m) return null
  const [, maj, min, pat, pre, preN] = m
  const rank = pre === 'beta' ? 2 : pre === 'rc' ? 3 : Number.POSITIVE_INFINITY
  return [parseInt(maj, 10), parseInt(min, 10), parseInt(pat, 10), rank, pre && preN ? parseInt(preN, 10) : 0]
}

/** Tag order; a copy of compareTags in src/main/github-update.ts (an unparsable tag sorts first). */
function compareReleaseTags(a, b) {
  const x = parseReleaseTag(a)
  const y = parseReleaseTag(b)
  if (!x && !y) return 0
  if (!x) return -1
  if (!y) return 1
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * The macOS major the release `tag` needs under `floors` (the `floors` of
 * resources/macos-release-floors.json); 0 for none. A copy of macosFloorForTag
 * in src/main/github-update.ts (this script runs before `npm ci`);
 * tests/unit/main/update-macos-floor.test.ts holds the two to the same answer
 * for every tag. A bare `-beta` tag also carries its final version's floor:
 * release.yml cuts it from that version on the beta channel.
 */
export function macosFloorForTag(tag, floors) {
  const bare = /^v(\d+\.\d+\.\d+)-beta$/.exec(String(tag))
  const tags = bare ? [String(tag), `v${bare[1]}`] : [String(tag)]
  let floor = 0
  for (const t of tags) {
    for (const f of floors || []) {
      if (compareReleaseTags(t, f.fromTag) >= 0 && f.macosMajor > floor) floor = f.macosMajor
    }
  }
  return floor
}

/**
 * The Electron version the build installs: package-lock.json's resolved
 * `packages["node_modules/electron"].version`, an exact version, never the
 * range package.json allows. Undefined when the lock names none.
 *
 * @param {{packages?: Record<string, any>}|null|undefined} lock   package-lock.json
 * @returns {string|undefined}
 */
export function electronVersionOf(lock) {
  const entry = lock && lock.packages && lock.packages['node_modules/electron']
  return entry && typeof entry.version === 'string' ? entry.version : undefined
}

/**
 * The Electron version main hands check 4: read from the lock file at
 * `lockPath` (electronVersionOf); undefined when it cannot be read, which the
 * check refuses (fail closed).
 *
 * @param {string} [lockPath]
 * @returns {string|undefined}
 */
export function readElectronVersion(lockPath = DEFAULT_LOCK_PATH) {
  try { return electronVersionOf(JSON.parse(fs.readFileSync(lockPath, 'utf-8'))) } catch { return undefined }
}

/** An exact version (`44.5.1`, `45.0.0-beta.3`), never a range; group 1 is its major. */
const EXACT_VERSION = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * The macOS floor verdict for cutting `version` (the tag without its `v`) with
 * `electronVersion` (the exact version package-lock.json resolves): the floor
 * its Electron needs (the highest `macosMajor` of the entries at or below its
 * major) against the floor the updater gives the tag. Only a stable, beta or
 * rc tag is offered by an updater; any other is not held to a floor. Every
 * entry of `floors` must be readable (a release tag, an Electron major and a
 * macOS major) and the version must be exact; anything else is refused (fail
 * closed).
 *
 * @param {object} input
 * @param {string} input.version
 * @param {string|null} [input.electronVersion]
 * @param {unknown} [input.floors]   resources/macos-release-floors.json
 * @returns {MacosVerdict}
 */
export function evaluateMacosFloor({ version, electronVersion, floors }) {
  const tag = `v${version}`
  const list = floors && typeof floors === 'object' && Array.isArray(floors.floors) ? floors.floors : []
  const base = { tag, offered: true, electronMajor: null, needed: null, floor: null }
  if (list.length === 0) {
    return { ...base, ok: false, reason: 'resources/macos-release-floors.json lists no floors, so the release cannot be checked (fail closed)' }
  }
  const bad = list.findIndex((f) => !(f && typeof f.fromTag === 'string' && parseReleaseTag(f.fromTag)
    && Number.isInteger(f.electronMajor) && f.electronMajor > 0 && Number.isInteger(f.macosMajor) && f.macosMajor > 0))
  if (bad >= 0) {
    return { ...base, ok: false, reason: `resources/macos-release-floors.json entry ${bad + 1} cannot be read (${JSON.stringify(list[bad] ?? null)}), so the release cannot be checked (fail closed)` }
  }
  const m = EXACT_VERSION.exec(String(electronVersion ?? ''))
  if (!m) {
    return { ...base, ok: false, reason: `cannot read the Electron version package-lock.json resolves (${JSON.stringify(electronVersion ?? null)}), so the release cannot be checked (fail closed)` }
  }
  const electronMajor = parseInt(m[1], 10)
  const needed = Math.max(0, ...list.filter((f) => f.electronMajor <= electronMajor).map((f) => f.macosMajor))
  if (!/^v\d+\.\d+\.\d+(?:-(?:beta|rc)(?:\.\d+)?)?$/.test(tag)) {
    return { ...base, ok: true, reason: null, offered: false, electronMajor, needed, floor: null }
  }
  const floor = macosFloorForTag(tag, list)
  const ok = floor >= needed
  return {
    ...base, ok, electronMajor, needed, floor,
    reason: ok ? null : `Electron ${electronMajor} needs macOS ${needed}, but ${tag} has ${floor ? `a macOS floor of ${floor}` : 'no macOS floor'} in resources/macos-release-floors.json`,
  }
}

/**
 * Render the verdicts as the lines the gate prints; a verdict left out prints nothing.
 *
 * @param {object} input
 * @param {string} input.version
 * @param {string|null} [input.repo]
 * @param {MilestoneVerdict|null} [input.milestoneResult]
 * @param {ModelsVerdict|null} [input.modelsResult]
 * @param {{source?:string,fetchedAt?:string}|null} [input.expectedMeta]
 * @param {ModelsVerdict|null} [input.codexResult]
 * @param {{cliVersions?:string[],fetchedAt?:string}|null} [input.codexMeta]
 * @param {MacosVerdict|null} [input.macosResult]
 * @returns {string[]}
 */
export function formatReport({ version, repo, milestoneResult, modelsResult, expectedMeta, codexResult, codexMeta, macosResult }) {
  const out = []
  out.push(`Release gate for v${version}${repo ? ` (${repo})` : ''}`)
  out.push('')
  // ── milestone
  if (milestoneResult) {
    const mr = milestoneResult
    if (mr.ok) {
      out.push(`  OK    milestone "${version}" (#${mr.milestone.number}) has no outstanding issues` +
        ((mr.shipped || []).length ? ` (${mr.shipped.length} shipping in this release: ${mr.shipped.map((i) => `#${i.number}`).join(' ')})` : '') +
        (mr.excluded.length ? ` (${mr.excluded.length} excluded by the owner: ${mr.excluded.map((i) => `#${i.number}`).join(' ')})` : ''))
    } else {
      out.push(`  FAIL  milestone: ${mr.reason}`)
      for (const i of mr.blocking) out.push(`          #${i.number}  ${i.title}${i.labels.length ? `  [${i.labels.join(', ')}]` : ''}`)
      if ((mr.shipped || []).length) out.push(`          (in-beta/in-release, shipping in this release: ${mr.shipped.map((i) => `#${i.number}`).join(' ')})`)
      if (mr.excluded.length) out.push(`          (excluded, not counted: ${mr.excluded.map((i) => `#${i.number}`).join(' ')})`)
      if (mr.milestone) out.push(`          Merge their fixes (label "${IN_BETA_LABEL}"), close them, move them to a later milestone, or have the owner label them "${EXCLUDED_LABEL}".`)
    }
  }
  // ── models
  if (modelsResult) {
    const r = modelsResult
    const src = expectedMeta && expectedMeta.source ? ` per ${expectedMeta.source}` : ''
    const at = expectedMeta && expectedMeta.fetchedAt ? ` (fixture fetched ${expectedMeta.fetchedAt})` : ''
    if (r.ok) out.push(`  OK    model registry covers all ${r.covered.length} supported Claude Code models${at}`)
    else {
      out.push(`  FAIL  model registry: ${r.reason}${src}${at}`)
      for (const m of r.missing) out.push(`          - ${m.id}${m.label ? `  (${m.label})` : ''}   article lists it, resources/model-registry.json does not`)
      out.push('          Add the missing entries to resources/model-registry.json `models` (the pinned picker rows are derived')
      out.push('          from it, so no `dropdown` edit is needed) or refresh resources/claude-code-model-configuration.json')
      out.push('          if the article changed — that file says how.')
    }
    for (const m of r.extra) out.push(`  WARN  ${m.id}${m.label ? ` (${m.label})` : ''} is in the registry but the article no longer lists it — retired? (not fatal)`)
  }
  // -- Codex models (P3.8, row 39)
  if (codexResult) {
    const r = codexResult
    const versions = codexMeta && Array.isArray(codexMeta.cliVersions) && codexMeta.cliVersions.length
      ? ` Codex ${codexMeta.cliVersions.join(' and ')}` : ' the Codex CLI'
    const at = codexMeta && codexMeta.fetchedAt ? ` (list read ${codexMeta.fetchedAt})` : ''
    if (r.ok) out.push(`  OK    Codex models: the registry covers all ${r.covered.length} models${versions} lists${at}`)
    else {
      out.push(`  FAIL  Codex models: ${r.reason}${at}`)
      for (const m of r.missing) out.push(`          - ${m.id}${m.label ? `  (${m.label})` : ''}   the Codex list names it, resources/model-registry.json has no pickable codex-family entry for it`)
      out.push('          Add the missing entries to resources/model-registry.json `models` (family "codex", with the model\'s')
      out.push('          reasoning levels as `efforts`) or refresh resources/codex-model-catalogue.json if the CLI changed;')
      out.push('          that file says how.')
    }
    for (const id of r.duplicates || []) out.push(`          ${id} is listed more than once in resources/model-registry.json: keep one entry, in the codex family`)
    for (const m of r.extra) out.push(`  WARN  ${m.id}${m.label ? ` (${m.label})` : ''} is a Codex model in the registry but the Codex list no longer names it: retired? (not fatal)`)
  }
  // -- the macOS floor (check 4)
  if (macosResult) {
    const r = macosResult
    if (!r.ok) {
      out.push(`  FAIL  macOS floor: ${r.reason}`)
      out.push('          The updater would offer this release to Macs that cannot open it. Cut it under a version at or')
      out.push('          after the entry for this Electron in resources/macos-release-floors.json, or add the entry.')
    } else if (!r.offered) out.push(`  OK    macOS floor: ${r.tag} is not a tag the updater offers`)
    else if (r.needed > 0) out.push(`  OK    macOS floor: ${r.tag} needs macOS ${r.floor} or later, as Electron ${r.electronMajor} does`)
    else out.push(`  OK    macOS floor: Electron ${r.electronMajor} needs no macOS floor`)
  }
  return out
}

// ── GitHub access ───────────────────────────────────────────────────

export function resolveToken(env = process.env, runGh = (args) => execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN
  if (fromEnv) return fromEnv
  try { return String(runGh(['auth', 'token'])).trim() || null } catch { return null }
}

/**
 * Minimal paginated GET against api.github.com. Throws on non-2xx.
 *
 * @param {string} pathAndQuery
 * @param {{ token?: string|null, fetchImpl?: typeof fetch, perPage?: number, maxPages?: number }} [options]
 * @returns {Promise<any[]>}
 */
export async function githubListAll(pathAndQuery, { token, fetchImpl = globalThis.fetch, perPage = 100, maxPages = 20 } = {}) {
  const all = []
  for (let page = 1; page <= maxPages; page++) {
    const sep = pathAndQuery.includes('?') ? '&' : '?'
    const url = `https://api.github.com${pathAndQuery}${sep}per_page=${perPage}&page=${page}`
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ccc-release-gate', 'X-GitHub-Api-Version': '2022-11-28' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetchImpl(url, { headers })
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${pathAndQuery}`)
    const chunk = await res.json()
    if (!Array.isArray(chunk)) throw new Error(`GitHub API returned a non-array for ${pathAndQuery}`)
    all.push(...chunk)
    if (chunk.length < perPage) break
  }
  return all
}

/** `owner/name` from a GitHub URL (https, ssh, or git+https), else null. */
export function repoFromUrl(url) {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s.]+?)(?:\.git)?(?:\/|$)/.exec(String(url || '').trim())
  return m ? `${m[1]}/${m[2]}` : null
}

export function repoFromPackageJson(pkg) {
  const r = pkg && pkg.repository
  return repoFromUrl(typeof r === 'string' ? r : r && r.url)
}

/** Local fallback: the checkout's origin remote (release.js runs from a clone; CI has $GITHUB_REPOSITORY). */
export function repoFromGitRemote(runGit = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  try { return repoFromUrl(runGit(['remote', 'get-url', 'origin'])) } catch { return null }
}

// ── the gate ────────────────────────────────────────────────────────

/**
 * Run the checks. Everything external is injectable so the verdict logic is
 * testable with no network: `listAll(path)` must return the parsed JSON array
 * for a GitHub REST list endpoint. `codexExpected` is the Codex half's list
 * (resources/codex-model-catalogue.json); a caller that leaves it out is
 * refused, as an empty list is (fail closed). `electronVersion` (the exact
 * version package-lock.json resolves) and `macosFloors`
 * (resources/macos-release-floors.json) feed the macOS floor check; a caller
 * that leaves either out is refused too.
 *
 * @param {object} [input]
 * @param {string} [input.version]          the milestone title, e.g. "2.1.0-beta.17"
 * @param {string|null} [input.repo]        `owner/name`
 * @param {(path: string) => Promise<any[]>} [input.listAll]   a GitHub REST list call
 * @param {object|null} [input.registry]    resources/model-registry.json
 * @param {object|null} [input.expected]    resources/claude-code-model-configuration.json
 * @param {object|null} [input.codexExpected]   resources/codex-model-catalogue.json
 * @param {string} [input.electronVersion]
 * @param {unknown} [input.macosFloors]     resources/macos-release-floors.json
 * @param {(line: string) => void} [input.log]
 * @returns {Promise<{ exitCode: number, lines: string[], milestoneResult: MilestoneVerdict|null, modelsResult: ModelsVerdict|null, codexResult: ModelsVerdict|null, macosResult: MacosVerdict|null }>}
 */
export async function runGate({
  version,
  repo,
  listAll,
  registry,
  expected,
  codexExpected,
  electronVersion,
  macosFloors,
  log = (s) => console.log(s),
} = {}) {
  const lines = []
  let milestoneResult = null
  let modelsResult = null
  let codexResult = null
  let macosResult = null
  let cannotEvaluate = null

  if (!version) cannotEvaluate = 'no version given and none readable from package.json'
  else if (!repo) cannotEvaluate = 'cannot determine the GitHub repo (set GITHUB_REPOSITORY, pass --repo, or run from a clone with an origin remote)'

  if (!cannotEvaluate) {
    try {
      const milestones = await listAll(`/repos/${repo}/milestones?state=all`)
      const ms = milestones.find((m) => m && String(m.title).trim() === String(version).trim())
      const issues = ms ? await listAll(`/repos/${repo}/issues?milestone=${ms.number}&state=open`) : []
      milestoneResult = evaluateMilestone({ version, milestones, issues })
    } catch (err) {
      cannotEvaluate = `could not read the milestone from GitHub: ${err && err.message ? err.message : err}`
    }
  }

  if (!cannotEvaluate) {
    try {
      modelsResult = evaluateModels({ registry, expected })
      codexResult = evaluateCodexModels({ registry, expected: codexExpected })
      macosResult = evaluateMacosFloor({ version, electronVersion, floors: macosFloors })
    } catch (err) {
      cannotEvaluate = `could not evaluate the model registry or the macOS floor: ${err && err.message ? err.message : err}`
    }
  }

  if (cannotEvaluate) {
    lines.push(`Release gate for v${version || '?'}: CANNOT EVALUATE — ${cannotEvaluate}`)
    lines.push('An unevaluated gate is a refused gate. Fix the cause and re-run.')
    for (const l of lines) log(l)
    return { exitCode: EXIT_CANNOT_EVALUATE, lines, milestoneResult, modelsResult, codexResult, macosResult }
  }

  lines.push(...formatReport({ version, repo, milestoneResult, modelsResult, expectedMeta: expected, codexResult, codexMeta: codexExpected, macosResult }))
  const ok = milestoneResult.ok && modelsResult.ok && codexResult.ok && macosResult.ok
  lines.push('')
  lines.push(ok ? `PASS  v${version} may be cut.` : `REFUSED  v${version} must not be cut until the FAIL lines above are cleared.`)
  for (const l of lines) log(l)
  return { exitCode: ok ? EXIT_OK : EXIT_REFUSED, lines, milestoneResult, modelsResult, codexResult, macosResult }
}

// ── CLI ─────────────────────────────────────────────────────────────

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')) }

export async function main(argv = process.argv.slice(2), env = process.env) {
  const pkg = readJson(path.join(ROOT, 'package.json'))
  const version = argValue(argv, '--version') || pkg.version
  const repo = argValue(argv, '--repo') || env.GITHUB_REPOSITORY || repoFromPackageJson(pkg) || repoFromGitRemote()
  const registryPath = argValue(argv, '--registry') || DEFAULT_REGISTRY_PATH
  const expectedPath = argValue(argv, '--expected') || DEFAULT_EXPECTED_PATH
  const codexExpectedPath = argValue(argv, '--codex-expected') || DEFAULT_CODEX_EXPECTED_PATH

  let registry, expected, codexExpected, macosFloors
  try {
    registry = readJson(registryPath)
    expected = readJson(expectedPath)
    codexExpected = readJson(codexExpectedPath)
    macosFloors = readJson(DEFAULT_MACOS_FLOORS_PATH)
  } catch (err) {
    console.error(`Release gate: CANNOT EVALUATE — ${err.message}`)
    return EXIT_CANNOT_EVALUATE
  }

  const token = resolveToken(env)
  if (!token) console.error('Release gate: no GITHUB_TOKEN/GH_TOKEN and `gh auth token` gave nothing — trying unauthenticated (public repo, rate-limited)')
  const listAll = (p) => githubListAll(p, { token })
  const { exitCode } = await runGate({ version, repo, listAll, registry, expected, codexExpected, electronVersion: readElectronVersion(), macosFloors })
  return exitCode
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  // exitCode, not process.exit(): a hard exit while undici's keep-alive handle is
  // still closing trips a libuv assertion on Windows (exit 127, noisy, and it
  // hides the real code). Nothing else keeps the loop alive, so draining is safe.
  main().then(
    (code) => { process.exitCode = code },
    (err) => { console.error(`Release gate: CANNOT EVALUATE — ${err && err.stack ? err.stack : err}`); process.exitCode = EXIT_CANNOT_EVALUATE },
  )
}
