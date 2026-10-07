// README staging: the anonymisation scan behind shoot.js's "scan" step. Plain
// CommonJS with no dependencies, so it can be tested on its own.
//
// The repo holds only generic patterns: a user-folder path on a drive, a
// /home path, an IPv4 address, a host on a private-looking suffix, and any
// e-mail address outside the fictional example.dev / example.io / example.co
// the staging uses (content.js). Names that are private to the operator
// (people, companies, machines) are never written here: they come from a
// deny-list file read at run time from OUTSIDE the checkout, named by
// CCC_SHOTS_DENYLIST, which has no default. A capture whose shot list scans
// refuses to start without it (fail closed).
'use strict'

const fs = require('fs')
const path = require('path')

const GENERIC = [
  { name: 'user-folder path', re: /\b[A-Za-z]:\\Users\\[^\s"'<>|]+/g },
  { name: 'home path', re: /\/home\/[^\s"'<>|]+/g },
  { name: 'IPv4 address', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { name: 'private host', re: /\b[a-z0-9-]+\.(?:internal|local|lan|corp)\b/gi },
  { name: 'e-mail outside the example domains', re: /[A-Za-z0-9._%+-]+@(?!example\.(?:dev|io|co)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
]

/** The deny list: one literal term per line (matched case-insensitively
 *  anywhere in the page text), blank lines and # comments ignored. Throws when
 *  CCC_SHOTS_DENYLIST is unset, or its file is missing, empty, or inside
 *  `repoDir` (it must never be committable). */
function loadDenyList(env = process.env, repoDir = null) {
  if (!env.CCC_SHOTS_DENYLIST) throw new Error('CCC_SHOTS_DENYLIST is not set: a capture that scans needs it to name the deny list, a file outside the repo with one private term per line')
  const file = path.resolve(env.CCC_SHOTS_DENYLIST)
  if (repoDir) {
    const rel = path.relative(path.resolve(repoDir), file)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`the deny list ${file} is inside the checkout ${repoDir}: keep it outside the repo`)
  }
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch {
    throw new Error(`CCC_SHOTS_DENYLIST names ${file}, which cannot be read: a capture that scans needs that file (outside the repo, one private term per line)`)
  }
  const terms = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  if (!terms.length) throw new Error(`the deny list ${file} has no terms`)
  return { file, terms }
}

/** Every generic-pattern and deny-list hit in `text`, as { "<rule>: <match>": count }. */
function scanText(text, terms = []) {
  const hits = {}
  const add = (k) => { hits[k] = (hits[k] || 0) + 1 }
  for (const g of GENERIC) for (const m of String(text).match(g.re) || []) add(`${g.name}: ${m}`)
  const lower = String(text).toLowerCase()
  for (const t of terms) {
    const needle = t.toLowerCase()
    let i = lower.indexOf(needle)
    while (i >= 0) { add(`deny-list term #${terms.indexOf(t) + 1}`); i = lower.indexOf(needle, i + needle.length) }
  }
  return hits
}

module.exports = { GENERIC, loadDenyList, scanText }
