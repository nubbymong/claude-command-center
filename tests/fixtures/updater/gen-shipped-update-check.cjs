// Regenerates shipped-update-check.ts (beside this file) from the update check a shipped build carries.
//
//   node tests/fixtures/updater/gen-shipped-update-check.cjs [tag]        (from the repo root; tag defaults to v2.1.1-beta.1)
//   node tests/fixtures/updater/gen-shipped-update-check.cjs [tag] --check  (exit 1 when the fixture differs)
//
// It reads src/main/github-update.ts at `tag` with `git show`, takes its types (UpdateChannel to
// ReleaseInfo), its tag helpers (classifyTag to compareTagToCurrentVersion) and checkGitHubRelease,
// leaves the comments out, and writes them after the fixture's own header and stand-ins (everything
// above `export type UpdateChannel`, kept as it is). The code of each function is copied as shipped;
// the only text changes are `export` dropped from checkGitHubRelease and one log line's dash made
// ASCII. v2.1.0-rc.5 to v2.1.1-beta.1 carry the same text for these parts.
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const args = process.argv.slice(2)
const check = args.includes('--check')
const tag = args.find((a) => !a.startsWith('--')) || 'v2.1.1-beta.1'
const repo = path.resolve(__dirname, '..', '..', '..')
const fixture = path.join(__dirname, 'shipped-update-check.ts')

const src = execFileSync('git', ['-C', repo, 'show', `${tag}:src/main/github-update.ts`], { encoding: 'utf8' }).split(/\r?\n/)

/** Lines from the one starting with `start` through the first line after it that is exactly `}`. */
function block(start) {
  const from = src.findIndex((l) => l.startsWith(start))
  if (from < 0) throw new Error(`${tag}: no line starts with ${JSON.stringify(start)}`)
  let to = from
  while (to < src.length && src[to] !== '}') to++
  if (to >= src.length) throw new Error(`${tag}: ${JSON.stringify(start)} has no closing line`)
  return { from, to }
}
/** Lines from the one starting with `first` through the closing line of the block starting with `last`. */
function span(first, last) {
  const a = block(first)
  const b = block(last)
  if (b.from < a.from) throw new Error(`${tag}: ${JSON.stringify(last)} comes before ${JSON.stringify(first)}`)
  return src.slice(a.from, b.to + 1)
}

/** The lines without comments: whole-line // and block comments, and a trailing `  // ` comment after code. */
function strip(lines) {
  const out = []
  let inBlock = false
  for (const l of lines) {
    const t = l.trim()
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue }
    if (t.startsWith('//')) continue
    const i = l.indexOf('  // ')
    out.push(i > 0 ? l.slice(0, i).replace(/\s+$/, '') : l)
  }
  // one blank line at most between parts, none leading
  return out.filter((l, k, a) => !(l.trim() === '' && (k === 0 || a[k - 1].trim() === '')))
}

const types = span('export type UpdateChannel', 'interface ReleaseInfo')
const helpers = span('function classifyTag(', 'function compareTagToCurrentVersion(')
const checkFn = span('export async function checkGitHubRelease', 'export async function checkGitHubRelease')
const body = [...strip(types), '', ...strip(helpers), '', ...strip(checkFn)].join('\n')
  .replace(/export async function checkGitHubRelease/, 'async function checkGitHubRelease')
  .replace(/ — no /, ' - no ')
const bad = body.match(/[^\x00-\x7f]/g)
if (bad) throw new Error(`non-ASCII left in the copied code: ${bad.join(',')}`)

const current = fs.readFileSync(fixture, 'utf8')
const at = current.indexOf('\nexport type UpdateChannel')
if (at < 0) throw new Error('shipped-update-check.ts has no `export type UpdateChannel` line to keep its header above')
const next = current.slice(0, at + 1) + body + '\n'
if (check) {
  if (next !== current) { console.error(`shipped-update-check.ts differs from ${tag}'s update check`); process.exit(1) }
  console.log(`shipped-update-check.ts matches ${tag}'s update check`)
} else {
  fs.writeFileSync(fixture, next)
  console.log(`shipped-update-check.ts written from ${tag}`)
}
