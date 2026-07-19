#!/usr/bin/env node
/**
 * Changelog generator — single source of truth is src/renderer/changelog.ts.
 *
 * That TS file is the hand-authored, user-facing changelog (it also drives the
 * in-app "What's New" modal). This script derives everything else from it so we
 * never maintain the same notes twice:
 *
 *   node scripts/gen-changelog.js            Write CHANGELOG.md (Keep a Changelog)
 *   node scripts/gen-changelog.js --check    Exit 1 if CHANGELOG.md is stale
 *   node scripts/gen-changelog.js --notes V  Print release-note markdown for
 *                                            version V to stdout (empty if the
 *                                            version has no entry). Used by
 *                                            .github/workflows/release.yml to
 *                                            populate the GitHub release body.
 *
 * changelog.ts entries carry typed changes: 'feature' | 'fix' | 'improvement'.
 * We map those to Keep-a-Changelog section headings (Added / Fixed / Changed).
 */

const fs = require('fs')
const path = require('path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const SOURCE = path.join(PROJECT_ROOT, 'src', 'renderer', 'changelog.ts')
const OUTPUT = path.join(PROJECT_ROOT, 'CHANGELOG.md')
const REPO_URL = 'https://github.com/nubbymong/claude-command-center'

// changelog.ts change-type -> Keep a Changelog section. Order here is the order
// sections render within a version block.
const SECTIONS = [
  { type: 'feature', heading: 'Added' },
  { type: 'improvement', heading: 'Changed' },
  { type: 'fix', heading: 'Fixed' },
]

/**
 * Pull the `changelog` array out of the TS source without a TS toolchain.
 * The array is a pure data literal (strings/arrays/objects, no runtime calls),
 * so we slice out the literal by bracket-matching and evaluate it in isolation.
 */
function loadChangelog() {
  const src = fs.readFileSync(SOURCE, 'utf-8')
  const anchor = src.indexOf('changelog: ChangelogEntry[] =')
  if (anchor === -1) {
    throw new Error(`Could not find "changelog: ChangelogEntry[] =" in ${SOURCE}`)
  }
  // Start AFTER the `=` — searching from `anchor` would match the `[` in the
  // `ChangelogEntry[]` type annotation instead of the array literal.
  const eq = src.indexOf('=', anchor)
  const start = src.indexOf('[', eq)
  if (start === -1) throw new Error('Could not find start of changelog array')

  // Bracket-match, ignoring brackets that appear inside string literals.
  let depth = 0
  let end = -1
  let inString = false
  let quote = ''
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (ch === '\\') { i++; continue } // skip escaped char
      if (ch === quote) inString = false
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; quote = ch; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) throw new Error('Could not find end of changelog array')

  const literal = src.slice(start, end + 1)
  // eslint-disable-next-line no-new-func — trusted, in-repo data literal only.
  const entries = new Function(`return (${literal})`)()
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Parsed changelog is empty or not an array')
  }
  return entries
}

/** Render the grouped change sections for one entry (shared by file + notes). */
function renderSections(entry) {
  const lines = []
  for (const { type, heading } of SECTIONS) {
    const items = (entry.changes || []).filter((c) => c.type === type)
    if (items.length === 0) continue
    lines.push(`### ${heading}`)
    for (const c of items) lines.push(`- ${c.description}`)
    lines.push('')
  }
  return lines
}

/** Full CHANGELOG.md text. */
function renderChangelog(entries) {
  const out = []
  out.push('# Changelog')
  out.push('')
  out.push('All notable changes to Claude Command Center are documented here.')
  out.push('')
  out.push('The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),')
  out.push('and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).')
  out.push('')
  out.push('> **Generated file — do not edit by hand.** The source of truth is')
  out.push('> `src/renderer/changelog.ts`. After editing that file, run `npm run changelog`')
  out.push('> (CI enforces that this file is in sync via `npm run changelog:check`).')
  out.push('')

  for (const entry of entries) {
    out.push(`## [${entry.version}] - ${entry.date}`)
    out.push('')
    if (entry.highlights) {
      out.push(`> ${entry.highlights}`)
      out.push('')
    }
    out.push(...renderSections(entry))
  }

  // Reference-style links: each version -> its release tag.
  for (const entry of entries) {
    out.push(`[${entry.version}]: ${REPO_URL}/releases/tag/v${entry.version}`)
  }
  out.push('')

  return out.join('\n')
}

/** Release-note body for a single version (GitHub release). Empty if unknown. */
function renderNotes(entries, version) {
  const entry = entries.find((e) => e.version === version)
  if (!entry) return ''
  const out = []
  if (entry.highlights) {
    out.push(entry.highlights)
    out.push('')
  }
  out.push(...renderSections(entry))
  out.push(`**Full changelog:** ${REPO_URL}/blob/v${version}/CHANGELOG.md`)
  return out.join('\n').trimEnd() + '\n'
}

function main() {
  const args = process.argv.slice(2)
  const entries = loadChangelog()

  const notesIdx = args.indexOf('--notes')
  if (notesIdx !== -1) {
    const version = args[notesIdx + 1]
    if (!version) {
      console.error('--notes requires a version argument')
      process.exit(2)
    }
    process.stdout.write(renderNotes(entries, version))
    return
  }

  const content = renderChangelog(entries)

  if (args.includes('--check')) {
    const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf-8') : ''
    // Compare EOL-insensitively: the file is written with LF, but a Windows
    // checkout under core.autocrlf=true can present it as CRLF on disk. Without
    // this, the check would spuriously fail for Windows devs while passing in
    // Linux CI. (.gitattributes also pins CHANGELOG.md to LF as defense in depth.)
    const norm = (s) => s.replace(/\r\n/g, '\n')
    if (norm(existing) !== norm(content)) {
      console.error('CHANGELOG.md is out of sync with src/renderer/changelog.ts.')
      console.error('Run `npm run changelog` and commit the result.')
      process.exit(1)
    }
    console.log('CHANGELOG.md is in sync.')
    return
  }

  fs.writeFileSync(OUTPUT, content, 'utf-8')
  console.log(`Wrote ${path.relative(PROJECT_ROOT, OUTPUT)} (${entries.length} versions).`)
}

main()
