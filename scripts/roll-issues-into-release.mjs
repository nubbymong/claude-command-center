#!/usr/bin/env node
// Roll a release candidate's issues one lifecycle step forward:
// `in-beta` -> `in-release` (CONTRIBUTING.md -> "Issue lifecycle").
//
// When an rc is cut, the open `in-beta` issues on its milestone are no longer
// merely "on beta, in testing" — their fixes are in a cut release candidate.
// This script swaps the label on exactly those issues so the lifecycle state
// stays readable off the label, and leaves a comment naming the rc. Promotion
// to stable then closes them (scripts/close-in-beta-issues.js handles both
// labels).
//
// It runs automatically as the `roll-rc` job of .github/workflows/release.yml
// on every successful `-rc.N` publish. Manual/local use:
//
//   node scripts/roll-issues-into-release.mjs --version 2.1.0-rc.1 --dry-run
//   node scripts/roll-issues-into-release.mjs --version 2.1.0-rc.1
//
// Flags:
//   --version <v>   The rc version = the milestone title (REQUIRED — this
//                   script must never guess which release it is rolling).
//   --repo <o/n>    Target repo. Defaults to $GITHUB_REPOSITORY, else
//                   package.json's repository, else the origin remote.
//   --dry-run       Print the plan; touch nothing. Also honoured via DRY_RUN=1.
//
// Scope: the milestone's open `in-beta` issues — the same set the release gate
// certified as "shipping in this release" when it allowed the cut. An in-beta
// issue that never made the milestone was never gate-checked and is NOT rolled;
// the run log cannot list what it cannot see, which is why milestone hygiene
// is part of the cut checklist.
//
// Fail-safe like the close script: the filter, not the harvest, is the guard.
// Only an OPEN, non-PR issue carrying `in-beta` (and not already `in-release`)
// is touched. A missing milestone is a loud failure, not a quiet no-op — after
// a real rc cut the gate has already proven the milestone exists, so its
// absence here means the version argument is wrong.
//
// Exit codes: 0 = done (including nothing to roll); 1 = a mutation failed;
// 2 = could not evaluate (bad args, missing milestone, API/auth trouble).
//
// Plain ESM, no dependencies — runs on a bare CI runner before `npm ci`.
// Labels and GitHub plumbing are imported from release-gate.mjs so the two
// stay single-sourced.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  EXCLUDED_LABEL,
  IN_BETA_LABEL,
  IN_RELEASE_LABEL,
  githubListAll,
  resolveToken,
  repoFromPackageJson,
  repoFromGitRemote,
} from './release-gate.mjs'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_CANNOT_EVALUATE = 2

// ── pure helpers (unit-tested) ──────────────────────────────────────

/** Label names from the REST `labels` shape ([{name}] or [string]). */
export function labelNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
}

/**
 * Decide what to do with one milestone issue. The single place the fail-safe
 * rules live, so they are testable without any network.
 */
export function classifyIssue(item, { inBetaLabel = IN_BETA_LABEL, inReleaseLabel = IN_RELEASE_LABEL, excludedLabel = EXCLUDED_LABEL } = {}) {
  if (!item) return { action: 'skip', reason: 'not found' }
  if (item.pull_request) return { action: 'skip', reason: 'is a pull request' }
  if (item.state && item.state !== 'open') return { action: 'skip', reason: `already ${item.state}` }
  const labels = labelNames(item.labels)
  if (labels.includes(inReleaseLabel)) return { action: 'skip', reason: `already labeled ${inReleaseLabel}` }
  // An excluded issue is the owner's business, not this script's — and it WINS
  // over in-beta, matching the gate's precedence (evaluateMilestone buckets an
  // excluded+in-beta issue as excluded): an issue the owner excluded must
  // never be commented as "rolled". Distinct reason so the run log reads as
  // "deliberately left", not "missed".
  if (labels.includes(excludedLabel)) return { action: 'skip', reason: `labeled ${excludedLabel} (owner-excluded)` }
  if (!labels.includes(inBetaLabel)) return { action: 'skip', reason: `not labeled ${inBetaLabel}` }
  return { action: 'roll' }
}

/** Split the milestone's issues into a roll list and an annotated skip list. */
export function planRoll(items, opts) {
  const toRoll = []
  const skipped = []
  for (const item of items || []) {
    const verdict = classifyIssue(item, opts)
    if (verdict.action === 'roll') toRoll.push(item)
    else skipped.push({ number: item && item.number, reason: verdict.reason })
  }
  toRoll.sort((a, b) => a.number - b.number)
  return { toRoll, skipped }
}

/**
 * The issue's full label set after the roll: `in-beta` out, `in-release` in,
 * everything else untouched. Computed client-side because the REST replace
 * (PUT /issues/{n}/labels) is the one-call atomic way to swap.
 */
export function rolledLabels(labels, { inBetaLabel = IN_BETA_LABEL, inReleaseLabel = IN_RELEASE_LABEL } = {}) {
  const names = labelNames(labels).filter((l) => l !== inBetaLabel)
  if (!names.includes(inReleaseLabel)) names.push(inReleaseLabel)
  return names
}

/** Comment left on each issue as it rolls. */
export function rollCommentBody({ version }) {
  return [
    `Rolled into **v${version}** (release candidate).`,
    '',
    `The fix is in a cut rc, no longer only on \`beta\` — relabeled \`${IN_BETA_LABEL}\` → \`${IN_RELEASE_LABEL}\`.`,
    'It closes automatically when the release promotes to stable.',
  ].join('\n')
}

export function parseArgv(argv) {
  const out = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--version') out.version = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
  }
  return out
}

// ── GitHub mutations ────────────────────────────────────────────────

async function githubRequest(method, pathAndQuery, body, { token, fetchImpl = globalThis.fetch } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ccc-roll-issues-into-release',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetchImpl(`https://api.github.com${pathAndQuery}`, { method, headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${method} ${pathAndQuery}`)
  return res.json()
}

// ── main ────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgv(argv)
  const dryRun = args.dryRun || env.DRY_RUN === '1'

  if (!args.version) {
    console.error('roll-issues-into-release: --version is required (the rc version, e.g. 2.1.0-rc.1) — refusing to guess.')
    return EXIT_CANNOT_EVALUATE
  }
  const version = String(args.version).trim()
  if (!/-rc\.\d+/.test(version)) {
    // Loud, not fatal: the workflow only dispatches this for -rc.N tags, so a
    // non-rc version here is a hand-run — flag it and carry on, because the
    // caller may be repairing labels after the fact.
    console.error(`roll-issues-into-release: "${version}" does not look like an rc version (no -rc.N) — rolling anyway, check the argument.`)
  }

  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) } catch { /* repo fallbacks below */ }
  const repo = args.repo || env.GITHUB_REPOSITORY || repoFromPackageJson(pkg) || repoFromGitRemote()
  if (!repo) {
    console.error('roll-issues-into-release: cannot determine the GitHub repo (set GITHUB_REPOSITORY, pass --repo, or run from a clone).')
    return EXIT_CANNOT_EVALUATE
  }

  const token = resolveToken(env)
  if (!token) console.error('roll-issues-into-release: no GITHUB_TOKEN/GH_TOKEN and `gh auth token` gave nothing — mutations will fail on a private repo.')

  console.log(`Repo:      ${repo}`)
  console.log(`Milestone: ${version}${dryRun ? '   [DRY RUN]' : ''}`)

  let toRoll, skipped
  try {
    const milestones = await githubListAll(`/repos/${repo}/milestones?state=all`, { token })
    const ms = milestones.find((m) => m && String(m.title).trim() === version)
    if (!ms) {
      console.error(`roll-issues-into-release: no milestone titled "${version}". The gate proved it existed at cut time, so this argument is wrong — nothing changed.`)
      return EXIT_CANNOT_EVALUATE
    }
    const issues = await githubListAll(`/repos/${repo}/issues?milestone=${ms.number}&state=open`, { token })
    ;({ toRoll, skipped } = planRoll(issues))
  } catch (err) {
    console.error(`roll-issues-into-release: could not read the milestone from GitHub: ${err && err.message ? err.message : err}`)
    return EXIT_CANNOT_EVALUATE
  }

  if (skipped.length) {
    console.log('\nSkipped:')
    for (const s of skipped) console.log(`  #${s.number} — ${s.reason}`)
  }

  if (!toRoll.length) {
    console.log(`\nNo open \`${IN_BETA_LABEL}\` issues on milestone "${version}". Done.`)
    // Zero rolled AND zero already-rolled on a live run smells like an empty rc
    // milestone — the roll's scope is the milestone, so an in-beta issue that
    // never made it onto the milestone is silently left behind. A rolling
    // re-release (everything already in-release) is fine and stays quiet.
    const alreadyRolled = skipped.some((s) => s.reason === `already labeled ${IN_RELEASE_LABEL}`)
    if (!dryRun && !alreadyRolled) {
      console.log(`::warning::Zero issues rolled for ${version}. If this rc ships real fixes, check that its milestone actually lists them (milestone hygiene is part of the cut checklist).`)
    }
    return EXIT_OK
  }

  console.log(`\n${dryRun ? 'Would roll' : 'Rolling'} ${toRoll.length} issue(s) ${IN_BETA_LABEL} → ${IN_RELEASE_LABEL}:`)
  let failed = 0
  for (const issue of toRoll) {
    console.log(`  #${issue.number}  ${issue.title}`)
    if (dryRun) continue
    try {
      // Comment first: if the relabel fails, the issue still carries the
      // explanation rather than being silently half-processed.
      await githubRequest('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body: rollCommentBody({ version }) }, { token })
      // PUT replaces the whole label set with one computed from the LIST-TIME
      // snapshot: the swap itself cannot half-apply, but a label someone adds
      // by hand between the list and this call is lost. Accepted for the
      // seconds-wide window of a release job.
      await githubRequest('PUT', `/repos/${repo}/issues/${issue.number}/labels`, { labels: rolledLabels(issue.labels) }, { token })
    } catch (err) {
      failed++
      console.error(`  #${issue.number} FAILED: ${err && err.message ? err.message : err}`)
    }
  }

  if (failed) {
    console.error(`\n${failed} issue(s) failed to roll — re-run this script or fix the labels by hand. Already-rolled issues are skipped on a re-run; an issue whose RELABEL failed (comment landed, label did not) is re-attempted and will carry a duplicate roll comment.`)
    return EXIT_FAILED
  }
  console.log(dryRun ? '\nDry run — nothing was changed.' : '\nDone.')
  return EXIT_OK
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  // exitCode, not process.exit(): same libuv-assert reasoning as release-gate.mjs.
  main().then(
    (code) => { process.exitCode = code },
    (err) => { console.error(`roll-issues-into-release failed: ${err && err.stack ? err.stack : err}`); process.exitCode = EXIT_FAILED },
  )
}
