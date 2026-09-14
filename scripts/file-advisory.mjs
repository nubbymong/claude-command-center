// file-advisory.mjs -- file a PRIVATE security advisory report (PVR) correctly.
//
// NO SHEBANG, deliberately. This module is imported by
// tests/unit/file-advisory-payload.test.ts, and Vite strips a shebang by rewriting
// the first line -- which under CRLF leaves a stray \r and the file fails to parse
// with "SyntaxError: Invalid or unexpected token". It cost a red CI run on #207 and
// reproduces exactly: LF parses, CRLF does not, and the non-ASCII in this file is
// innocent. `scripts/*.mjs` is now pinned to LF in .gitattributes as well, so this
// is belt and braces. Run it as `node scripts/file-advisory.mjs`.
//
// This is the ONLY sanctioned way to file an advisory in this repository. It
// exists because hand-building the payload wasted five API calls and a wrong
// diagnosis (#207): the reports endpoint answers a payload missing
// `vulnerabilities[]` or `cvss_vector_string` with
//
//     500 Internal Server Error, Content-Length: 0
//
// NOT a 422 naming the field. A 500 from that endpoint is therefore evidence about
// YOUR PAYLOAD, not about GitHub's health — and reading it as an outage is exactly
// the detour this script prevents. Every required field is filled in or the request
// is never sent.
//
// Usage:
//   node scripts/file-advisory.mjs --summary "<one line>" --desc <path outside the repo> \
//        [--cwe CWE-22] [--cvss "CVSS:3.1/..."] [--range "<= 2.1.0-beta.5"] \
//        [--functions fnA,fnB] [--no-fork] [--dry-run]
//
//   --dry-run   print the payload and exit WITHOUT filing. Do this first.
//
// See docs/security-embargo-runbook.md for the surrounding procedure: what goes in
// a private advisory versus a PR verdict, where the fix is developed, and when the
// public record is written.

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { resolve, relative, isAbsolute, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

const REPO = 'nubbymong/claude-command-center'
const DEFAULT_CVSS = 'CVSS:3.1/AV:L/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N'
const MAX_SUMMARY = 1024

// ── argv ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { fork: true, dryRun: false, functions: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) fail(`${a} needs a value`)
      return v
    }
    if (a === '--summary') out.summary = next()
    else if (a === '--desc') out.desc = next()
    else if (a === '--cwe') out.cwe = next()
    else if (a === '--cvss') out.cvss = next()
    else if (a === '--range') out.range = next()
    else if (a === '--functions') out.functions = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--no-fork') out.fork = false
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') usage(0)
    else fail(`unknown argument: ${a}`)
  }
  return out
}

function usage(code) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(19, 32).join('\n').replace(/^\/\/ ?/gm, ''))
  process.exit(code)
}

function fail(message) {
  console.error(`\n  advisory NOT filed: ${message}\n`)
  process.exit(1)
}

// ── validation (pure, unit-tested in tests/unit/file-advisory-payload.test.ts) ──

/**
 * Every field the reports endpoint needs. Missing any of these produces a 500
 * with an empty body, which is unreadable as a diagnosis — so they are checked
 * here, by name, before a request exists.
 */
export const REQUIRED_FIELDS = [
  'summary',
  'description',
  'cvss_vector_string',
  'cwe_ids',
  'vulnerabilities',
  'start_private_fork'
]

export function buildPayload({ summary, description, cvss, cwe, range, functions, fork }) {
  return {
    summary,
    description,
    cvss_vector_string: cvss || DEFAULT_CVSS,
    cwe_ids: [cwe || 'CWE-noinfo'],
    vulnerabilities: [
      {
        // 'other' is correct: this app is not published to a package registry.
        package: { ecosystem: 'other', name: 'claude-command-center' },
        vulnerable_version_range: range || '<= 2.1.0-beta.5',
        vulnerable_functions: functions && functions.length > 0 ? functions : undefined
      }
    ],
    start_private_fork: fork !== false
  }
}

/** Returns an array of human-readable problems. Empty array means send it. */
export function validatePayload(payload) {
  const problems = []
  for (const field of REQUIRED_FIELDS) {
    const value = payload?.[field]
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0)
    if (empty) {
      problems.push(`missing "${field}" — the endpoint answers this with a 500 and an empty body, not a 422`)
    }
  }
  if (typeof payload?.summary === 'string' && payload.summary.length > MAX_SUMMARY) {
    problems.push(`summary is ${payload.summary.length} chars, max ${MAX_SUMMARY}`)
  }
  if (typeof payload?.cvss_vector_string === 'string' && !/^CVSS:3\.[01]\//.test(payload.cvss_vector_string)) {
    problems.push(`cvss_vector_string must start with "CVSS:3.1/" or "CVSS:3.0/", got "${payload.cvss_vector_string}"`)
  }
  for (const id of payload?.cwe_ids ?? []) {
    if (!/^CWE-(\d+|noinfo)$/.test(id)) problems.push(`cwe_ids entry "${id}" is not a CWE id`)
  }
  const vuln = payload?.vulnerabilities?.[0]
  if (vuln && !vuln.package?.name) problems.push('vulnerabilities[0].package.name is required')
  if (vuln && !vuln.vulnerable_version_range) problems.push('vulnerabilities[0].vulnerable_version_range is required')
  return problems
}

/**
 * The embargo, enforced instead of merely documented: the description must NOT
 * live inside the repository working tree. `CONTEXT.d/` feels like a scratch
 * notebook and is a tracked file, so a repro written there is a disclosure with
 * reproduction steps attached. A path check turns that rule into a guard.
 */
export function describeDescriptionPathProblem(descPath, repoRoot) {
  const abs = isAbsolute(descPath) ? descPath : resolve(process.cwd(), descPath)
  const rel = relative(resolve(repoRoot), abs)
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  if (!inside) return null
  return (
    `the description file is INSIDE the repository (${rel}). This repository is public and ` +
    'anything pushed is publication — write it somewhere untracked (e.g. your home dir) ' +
    'and pass that path. See docs/security-embargo-runbook.md ("Embargo").'
  )
}

// ── main ─────────────────────────────────────────────────────────────────────

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.summary) fail('--summary is required')
  if (!args.desc) fail('--desc <path> is required (a file OUTSIDE the repo)')

  const pathProblem = describeDescriptionPathProblem(args.desc, repoRoot())
  if (pathProblem) fail(pathProblem)
  if (!existsSync(args.desc)) fail(`--desc file not found: ${args.desc}`)

  const description = readFileSync(args.desc, 'utf8')
  if (description.trim() === '') fail(`--desc file is empty: ${args.desc}`)

  const payload = buildPayload({ ...args, description })
  const problems = validatePayload(payload)
  if (problems.length > 0) {
    console.error('\n  advisory NOT filed. Fix these first:\n')
    for (const p of problems) console.error(`   - ${p}`)
    console.error('')
    process.exit(1)
  }

  const preview = { ...payload, description: `<${description.length} chars from ${args.desc}>` }
  console.log('\npayload:\n' + JSON.stringify(preview, null, 2) + '\n')

  if (args.dryRun) {
    console.log('--dry-run: nothing was filed. Re-run without --dry-run to file it.\n')
    return
  }

  const file = join(mkdtempSync(join(tmpdir(), 'ccc-advisory-')), 'payload.json')
  writeFileSync(file, JSON.stringify(payload))
  console.log(`filing against ${REPO} …`)
  try {
    const out = execFileSync(
      'gh',
      ['api', '-X', 'POST', `repos/${REPO}/security-advisories/reports`, '--input', file],
      { encoding: 'utf8' }
    )
    const res = JSON.parse(out)
    console.log(`\n  ghsa_id      ${res.ghsa_id}`)
    console.log(`  state        ${res.state}   (triage = awaiting the owner, this is expected)`)
    console.log(`  advisory     ${res.html_url}`)
    if (res.private_fork?.full_name) {
      console.log(`  private fork ${res.private_fork.full_name}`)
      console.log('\nDevelop the fix in that fork, based on and targeting `beta`. Never on a branch of the public repo.')
    }
    console.log('')
  } catch (err) {
    console.error('\n  the POST failed. Read this before assuming GitHub is down:')
    console.error('   - a 500 with an empty body from this endpoint means a MALFORMED PAYLOAD,')
    console.error('     not an outage. This script validates the known-required fields, so a 500')
    console.error('     here points at a field GitHub has started requiring since — compare against')
    console.error('     the API docs and update REQUIRED_FIELDS + buildPayload in this script.')
    console.error('   - a 403 means you used the MAINTAINER endpoint. This script does not.')
    console.error(`   - payload kept for inspection: ${file}`)
    console.error(`\n${err.stdout || ''}${err.stderr || err.message}\n`)
    process.exit(1)
  }
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('file-advisory.mjs')) {
  main()
}
