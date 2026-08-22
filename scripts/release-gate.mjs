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
//      `excluded` label. Pull requests on the milestone are ignored (they are
//      not book-of-work items). A MISSING milestone fails closed: the gate
//      cannot tell "nothing outstanding" from "nobody made the list".
//   2. MODELS  Every id in the support article's "Supported models" table
//      (scripts/fixtures/claude-code-model-configuration.json, refreshed by
//      hand — the fixture says how) must be covered by resources/model-registry.json.
//      A registry id covers an article id when it is equal, or when the article
//      id is that id plus a `-YYYYMMDD` date suffix (the app resolves dated ids
//      to the undated entry by prefix; the CLI accepts both). Missing = FAIL,
//      printed as a diff. A registry Claude model the article no longer lists
//      is a WARNING (flagged, not fatal): the owner decides whether it retired.
//
// Usage
//   node scripts/release-gate.mjs                      # version from package.json
//   node scripts/release-gate.mjs --version 2.1.0-beta.17
//   node scripts/release-gate.mjs --repo owner/name    # default: $GITHUB_REPOSITORY, else package.json repository, else the origin remote
//   node scripts/release-gate.mjs --registry <path> --expected <path>
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
export const DEFAULT_REGISTRY_PATH = path.join(ROOT, 'resources', 'model-registry.json')
export const DEFAULT_EXPECTED_PATH = path.join(ROOT, 'scripts', 'fixtures', 'claude-code-model-configuration.json')

// ── pure helpers (unit-tested) ──────────────────────────────────────

/** Label names from the REST `labels` shape ([{name}] or [string]). */
function labelNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
}

/**
 * Milestone verdict for one version.
 *
 * @param {object} input
 * @param {string} input.version          e.g. "2.1.0-beta.17" — must equal the milestone title
 * @param {Array<{number:number,title:string,state?:string}>|null} input.milestones
 * @param {Array<{number:number,title:string,labels?:any[],pull_request?:object,state?:string}>} input.issues
 *        open issues ON that milestone (already filtered by the API; re-filtered here defensively)
 * @param {string} [input.excludedLabel]
 * @returns {{ ok: boolean, reason: string|null, milestone: object|null, blocking: Array<{number:number,title:string,labels:string[]}>, excluded: Array<{number:number,title:string}> }}
 */
export function evaluateMilestone({ version, milestones, issues, excludedLabel = EXCLUDED_LABEL }) {
  const title = String(version || '').trim()
  const milestone = (milestones || []).find((m) => m && String(m.title).trim() === title) || null
  if (!milestone) {
    return {
      ok: false,
      reason: `no GitHub milestone titled "${title}" — create it (and put the release's issues on it) before cutting; the gate fails closed on a missing milestone`,
      milestone: null, blocking: [], excluded: [],
    }
  }
  const blocking = []
  const excluded = []
  for (const it of issues || []) {
    if (!it || it.pull_request) continue          // PRs are not book-of-work items
    if (it.state && it.state !== 'open') continue
    const labels = labelNames(it.labels)
    if (labels.includes(excludedLabel)) excluded.push({ number: it.number, title: it.title })
    else blocking.push({ number: it.number, title: it.title, labels })
  }
  blocking.sort((a, b) => a.number - b.number)
  excluded.sort((a, b) => a.number - b.number)
  return {
    ok: blocking.length === 0,
    reason: blocking.length === 0 ? null : `${blocking.length} open issue(s) on milestone "${title}" without the "${excludedLabel}" label`,
    milestone, blocking, excluded,
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
 * @param {{models:Array<{id:string,label?:string}>,source?:string,fetchedAt?:string}} input.expected   the fixture
 * @returns {{ ok: boolean, reason: string|null, missing: Array<{id:string,label?:string}>, extra: Array<{id:string,label?:string}>, covered: Array<{id:string,by:string}> }}
 */
export function evaluateModels({ registry, expected }) {
  const registryModels = (registry && registry.models) || []
  const expectedModels = (expected && expected.models) || []
  const missing = []
  const covered = []
  const usedRegistryIds = new Set()
  for (const exp of expectedModels) {
    const hit = registryModels.find((m) => registryIdCovers(m.id, exp.id))
    if (hit) { covered.push({ id: exp.id, by: hit.id }); usedRegistryIds.add(hit.id) }
    else missing.push({ id: exp.id, label: exp.label })
  }
  // Claude models we carry that the article no longer names — flagged, not fatal.
  // Non-Claude entries (the codex family) are not the article's business.
  const extra = registryModels
    .filter((m) => typeof m.id === 'string' && m.id.startsWith('claude-') && !usedRegistryIds.has(m.id))
    .map((m) => ({ id: m.id, label: m.label }))
  return {
    ok: missing.length === 0,
    reason: missing.length === 0 ? null : `${missing.length} model(s) from the Claude Code model configuration article are not in the registry`,
    missing, extra, covered,
  }
}

/** Render both verdicts as the lines the gate prints. */
export function formatReport({ version, repo, milestoneResult, modelsResult, expectedMeta }) {
  const out = []
  out.push(`Release gate for v${version}${repo ? ` (${repo})` : ''}`)
  out.push('')
  // ── milestone
  if (milestoneResult) {
    const mr = milestoneResult
    if (mr.ok) {
      out.push(`  OK    milestone "${version}" (#${mr.milestone.number}) has no open issues left` +
        (mr.excluded.length ? ` (${mr.excluded.length} excluded by the owner: ${mr.excluded.map((i) => `#${i.number}`).join(' ')})` : ''))
    } else {
      out.push(`  FAIL  milestone: ${mr.reason}`)
      for (const i of mr.blocking) out.push(`          #${i.number}  ${i.title}${i.labels.length ? `  [${i.labels.join(', ')}]` : ''}`)
      if (mr.excluded.length) out.push(`          (excluded, not counted: ${mr.excluded.map((i) => `#${i.number}`).join(' ')})`)
      if (mr.milestone) out.push(`          Close them, move them to a later milestone, or have the owner label them "${EXCLUDED_LABEL}".`)
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
      out.push('          Add the missing entries to resources/model-registry.json (models + dropdown) or refresh the fixture if the article changed.')
    }
    for (const m of r.extra) out.push(`  WARN  ${m.id}${m.label ? ` (${m.label})` : ''} is in the registry but the article no longer lists it — retired? (not fatal)`)
  }
  return out
}

// ── GitHub access ───────────────────────────────────────────────────

export function resolveToken(env = process.env, runGh = (args) => execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN
  if (fromEnv) return fromEnv
  try { return String(runGh(['auth', 'token'])).trim() || null } catch { return null }
}

/** Minimal paginated GET against api.github.com. Throws on non-2xx. */
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
 * Run both checks. Everything external is injectable so the verdict logic is
 * testable with no network: `listAll(path)` must return the parsed JSON array
 * for a GitHub REST list endpoint.
 *
 * @returns {Promise<{ exitCode: number, lines: string[], milestoneResult: object|null, modelsResult: object|null }>}
 */
export async function runGate({
  version,
  repo,
  listAll,
  registry,
  expected,
  log = (s) => console.log(s),
} = {}) {
  const lines = []
  let milestoneResult = null
  let modelsResult = null
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
    } catch (err) {
      cannotEvaluate = `could not evaluate the model registry: ${err && err.message ? err.message : err}`
    }
  }

  if (cannotEvaluate) {
    lines.push(`Release gate for v${version || '?'}: CANNOT EVALUATE — ${cannotEvaluate}`)
    lines.push('An unevaluated gate is a refused gate. Fix the cause and re-run.')
    for (const l of lines) log(l)
    return { exitCode: EXIT_CANNOT_EVALUATE, lines, milestoneResult, modelsResult }
  }

  lines.push(...formatReport({ version, repo, milestoneResult, modelsResult, expectedMeta: expected }))
  const ok = milestoneResult.ok && modelsResult.ok
  lines.push('')
  lines.push(ok ? `PASS  v${version} may be cut.` : `REFUSED  v${version} must not be cut until the FAIL lines above are cleared.`)
  for (const l of lines) log(l)
  return { exitCode: ok ? EXIT_OK : EXIT_REFUSED, lines, milestoneResult, modelsResult }
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

  let registry, expected
  try {
    registry = readJson(registryPath)
    expected = readJson(expectedPath)
  } catch (err) {
    console.error(`Release gate: CANNOT EVALUATE — ${err.message}`)
    return EXIT_CANNOT_EVALUATE
  }

  const token = resolveToken(env)
  if (!token) console.error('Release gate: no GITHUB_TOKEN/GH_TOKEN and `gh auth token` gave nothing — trying unauthenticated (public repo, rate-limited)')
  const listAll = (p) => githubListAll(p, { token })
  const { exitCode } = await runGate({ version, repo, listAll, registry, expected })
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
