// README staging: the anonymisation scan behind shoot.js's "scan" step. Plain
// CommonJS with no dependencies, so it can be tested on its own.
//
// The repo holds only generic patterns: a user-folder path on a drive (either
// slash, any case, JSON-escaped too), a /home or macOS /Users path, an IPv4
// address (not a version
// number), a host on a private-looking suffix, and any
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
  // Any case, and separators doubled as JSON escapes them (C:\\Users\\alice).
  { name: 'user-folder path', re: /\b[A-Za-z]:[\\/]+Users[\\/]+[^\s"'<>|]+/gi },
  { name: 'home path', re: /\/home\/[^\s"'<>|]+/g },
  // A path's own root only: not src/Users/..., a web path, or C:/Users (above).
  // After a colon it counts (path:/Users/..., a PATH list), after a drive letter not.
  { name: 'macOS user folder', re: /(?<![\w.-])(?<!\b[A-Za-z]:)\/Users\/[^\s"'<>|]+/g },
  // Four octets of 0-255, not one run of a longer dotted number, and not a
  // version (v2.1.1.4, "version 2.1.1.4").
  { name: 'IPv4 address', re: /(?<![\w.])(?<!\b[Vv]ersion[\s:=]*)(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?!\.?\w)/g },
  { name: 'private host', re: /\b[a-z0-9-]+\.(?:internal|local|lan|corp)\b/gi },
  // Bounded as an address is (RFC 5321: a local part of up to 64, labels of up
  // to 63, a name of up to 253, so at most 127 labels), so a long token with no
  // space costs the same at every start position instead of rescanning to its end.
  { name: 'e-mail outside the example domains', re: /[A-Za-z0-9._%+-]{1,64}@(?!example\.(?:dev|io|co)\b)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,125}\.[A-Za-z]{2,63}/g },
]

/** The deny list: one literal term per line (matched case-insensitively
 *  anywhere in the page text), blank lines and # comments ignored. Throws when
 *  CCC_SHOTS_DENYLIST is unset, or its file is missing, empty, or inside
 *  `repoDir` (it must never be committable). */
function loadDenyList(env = process.env, repoDir = null) {
  if (!env.CCC_SHOTS_DENYLIST) throw new Error('CCC_SHOTS_DENYLIST is not set: a capture that scans needs it to name the deny list, a file outside the repo with one private term per line')
  const file = path.resolve(env.CCC_SHOTS_DENYLIST)
  if (repoDir) {
    // Inside = the checkout itself or below it. A name that merely starts with
    // two dots (<repo>/..foo) is inside; only '..' as a whole step leaves it.
    const rel = path.relative(path.resolve(repoDir), file)
    const inside = !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)
    if (inside) throw new Error(`the deny list ${file} is inside the checkout ${repoDir}: keep it outside the repo`)
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
