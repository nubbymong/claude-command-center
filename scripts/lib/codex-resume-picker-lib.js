// Helper module for scripts/codex-resume-picker.js. Lives in scripts/lib so
// the unit test (tests/unit/scripts/codex-resume-picker.test.ts) can require()
// these helpers without running main(). The picker script require()s this lib
// at runtime; both files are bundled together at deploy time.
//
// Self-contained Node.js, stdlib only.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const crypto = require('crypto')

// -- the first user message ----------------------------------------
// P3.12 round 1 (V3): the user's words in one event_msg payload, by the
// conversation index's rule (codex-rollout-normalizer.ts eventEntries and
// contentText): null when the event is not a user message, or is blank.
function eventUserText(p) {
  if (p.type === 'user_message') {
    // Only a plain user_message (or one with no kind) is the user's words.
    if (typeof p.kind === 'string' && p.kind !== 'plain') return null
    const parts = []
    if (typeof p.message === 'string' && p.message.length > 0) parts.push(p.message)
    for (const list of [p.images, p.local_images]) if (Array.isArray(list)) for (let i = 0; i < list.length; i++) parts.push('[image]')
    const text = parts.join('\n\n')
    return text.trim() ? text : null
  }
  if (p.type === 'item_completed' && p.item && typeof p.item === 'object' && p.item.type === 'UserMessage') {
    const text = contentText(p.item.content)
    return text.trim() ? text : null
  }
  return null
}

// The text parts of a turn's content, [image] for each image (the index's contentText).
function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const type = part.type
    if ((type === 'text' || type === 'Text' || type === 'input_text' || type === 'output_text') && typeof part.text === 'string') {
      if (part.text.length > 0) parts.push(part.text)
    } else if (type === 'image' || type === 'local_image' || type === 'input_image') {
      parts.push('[image]')
    }
  }
  return parts.join('\n\n')
}

// Context Codex injects as a user response item: an XML-style wrapper, or
// its AGENTS.md instructions.
function isInjectedContext(trimmed) {
  return /^<[A-Za-z]/.test(trimmed) || /^# AGENTS\.md instructions\b/.test(trimmed)
}

// -- parseRollout ---------------------------------------------------
// Reads the first ~32KB head of a rollout buffer and extracts:
//   { id, cwd, model, effort?, label, mtime? }
// Returns null when the first line is malformed or session_meta is absent.
function parseRollout(text) {
  if (!text || typeof text !== 'string') return null
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) return null

  // First line must be session_meta
  let meta = null
  try {
    const first = JSON.parse(lines[0])
    if (first && first.type === 'session_meta' && first.payload) {
      meta = {
        id: String(first.payload.id || ''),
        cwd: String(first.payload.cwd || ''),
        model: String(first.payload.model || ''),
      }
    }
  } catch {
    return null
  }
  if (!meta) return null

  // Walk subsequent lines for turn_context (any position) and the first user
  // message.
  //
  // P3.12 round 1 (V3): the first user message as the conversation index
  // reads it (src/main/logging/codex-rollout-normalizer.ts, the same rule):
  // the user's words from the events, never the response items, which also
  // carry the context Codex injects (AGENTS.md, the environment):
  //   - legacy history: { type: 'event_msg', payload: { type: 'user_message', message } },
  //     a plain one (no kind, or kind 'plain'), with [image] per image;
  //   - paginated history: { type: 'event_msg', payload: { type: 'item_completed',
  //     item: { type: 'UserMessage', content: [{ type: 'text', text }] } } }.
  //
  // Only a head with no such event (one cut before it) falls back to the
  // response items: { type: 'response_item', payload: { type: 'message',
  // role: 'user', content: [{ type: 'input_text', text }] } }, skipping the
  // injected context there: text that opens with an XML-style tag
  // (<environment_context>, <collaboration_mode>, ...) or is Codex's
  // AGENTS.md instructions.
  let model = meta.model
  let effort
  let label = '(continued session)'
  let foundLabel = false
  let fallback = null

  for (let i = 1; i < lines.length; i++) {
    let evt
    try { evt = JSON.parse(lines[i]) } catch { continue }
    if (!evt || typeof evt !== 'object') continue

    if (evt.type === 'turn_context' && evt.payload) {
      if (typeof evt.payload.model === 'string' && evt.payload.model) model = evt.payload.model
      if (typeof evt.payload.effort === 'string' && evt.payload.effort) effort = evt.payload.effort
      continue
    }

    if (foundLabel) continue

    // The user's words from the events (the index's rule).
    if (evt.type === 'event_msg' && evt.payload && typeof evt.payload === 'object') {
      const text = eventUserText(evt.payload)
      if (text !== null) {
        label = text.replace(/[\r\n]+/g, ' ').trim()
        foundLabel = true
      }
      continue
    }

    // The fallback: the first response-item user text that is not injected context.
    if (fallback === null && evt.type === 'response_item' && evt.payload && evt.payload.type === 'message' && evt.payload.role === 'user' && Array.isArray(evt.payload.content)) {
      for (const part of evt.payload.content) {
        if (!part || typeof part !== 'object') continue
        if (part.type !== 'input_text') continue
        const text = part.text
        if (typeof text !== 'string') continue
        const trimmed = text.trim()
        if (!trimmed) continue
        if (isInjectedContext(trimmed)) continue
        fallback = trimmed.replace(/[\r\n]+/g, ' ').slice(0, 200)
        break
      }
    }
  }
  if (!foundLabel && fallback !== null) label = fallback

  return { id: meta.id, cwd: meta.cwd, model, effort, label }
}

// -- walkRollouts ---------------------------------------------------
// Walks <home>/sessions/YYYY/MM/DD/ newest-first, up to maxDays back, by
// both the UTC and the local date of each day: Codex names a rollout in
// local time, and which date its folder follows is not proven (P3.5, row
// 38), so today's conversations can sit in a folder dated ahead of or
// behind the UTC date. For each rollout-*.jsonl, reads the first
// ROLLOUT_HEAD_BYTES and parseRollout()s it.
//
// `where` is the configured directory (a string, as before) or the
// project's git worktrees (listWorktrees). A rollout is listed when the
// directory it records is one of them -- compared resolved, and
// case-folded on Windows, where git spells a path with forward slashes --
// and is tagged with that worktree: `sourceCwd`, the path git reported (the
// picker starts the CLI there, never in a directory the rollout names);
// `worktreeLabel`, null for the main one. Newest first, at most MAX_LISTED
// (Claude's picker lists 20 across its worktrees).
//
// P9.8: bumped from 32KB to 256KB. Codex 0.133's session_meta line is
// 22KB (system prompt) + the first developer wrapper line is another
// 10KB, so a 32KB head consistently truncated before the first user
// message and every entry rendered as "(continued session)" in the
// picker. 256KB is the empirical 99th-percentile size needed to see
// at least one real user turn, and capped low enough that 20 files
// stays around 5MB peak read.
const ROLLOUT_HEAD_BYTES = 256 * 1024
const MAX_LISTED = 20
function dayFolders(sessionsDir, maxDays, now) {
  const out = []
  const seen = new Set()
  const pad = (n) => String(n).padStart(2, '0')
  for (let dayOffset = 0; dayOffset < maxDays; dayOffset++) {
    const d = new Date(now - dayOffset * 24 * 3600 * 1000)
    const dates = [
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
    ]
    for (const [y, m, dd] of dates) {
      const dir = path.join(sessionsDir, String(y), pad(m), pad(dd))
      if (!seen.has(dir)) { seen.add(dir); out.push(dir) }
    }
  }
  return out
}
function walkRollouts(home, maxDays, where, platform) {
  const plat = platform || process.platform
  const worktrees = typeof where === 'string'
    ? [{ path: where, branch: null, isMain: true }]
    : (Array.isArray(where) ? where.filter((w) => w && typeof w.path === 'string' && w.path) : [])
  const sessionsDir = path.join(home, 'sessions')
  if (!isRealFolder(sessionsDir)) return []
  const matches = []

  for (const dayDir of dayFolders(sessionsDir, maxDays, Date.now())) {
    if (matches.length >= MAX_LISTED) break
    // Real folders only, at every level (P3.5 fix round 1): a year, month or
    // day folder that is a link or junction is not entered.
    if (!realFolderChain(sessionsDir, dayDir)) continue

    let files
    try {
      files = fs.readdirSync(dayDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
        .map((e) => e.name)
    } catch { continue }

    // Sort newest-first within day by mtime (plain files only: a file link is not read)
    const dayEntries = []
    for (const f of files) {
      const fp = path.join(dayDir, f)
      let st
      try { st = fs.lstatSync(fp) } catch { continue }
      if (!st.isFile()) continue
      dayEntries.push({ fp, mtime: st.mtimeMs })
    }
    dayEntries.sort((a, b) => b.mtime - a.mtime)

    for (const { fp, mtime } of dayEntries) {
      if (matches.length >= MAX_LISTED) break
      let buf
      let fd = null
      try {
        fd = fs.openSync(fp, 'r')
        const st = fs.fstatSync(fd)
        const size = Math.min(ROLLOUT_HEAD_BYTES, st.size)
        buf = Buffer.alloc(size)
        fs.readSync(fd, buf, 0, size, 0)
      } catch { continue }
      finally {
        if (fd !== null) {
          try { fs.closeSync(fd) } catch {}
        }
      }
      const parsed = parseRollout(buf.toString('utf-8'))
      if (!parsed) continue
      const wt = worktrees.find((w) => samePath(w.path, parsed.cwd, plat))
      if (!wt) continue
      // P3.12 (row 32): the name the app wrote next to the rollout, if any.
      const name = readRolloutName(fp)
      matches.push({ id: parsed.id, cwd: parsed.cwd, model: parsed.model, effort: parsed.effort, label: parsed.label, mtime, sourceCwd: wt.path, worktreeLabel: worktreeLabelFor(wt), ...(name ? { name } : {}) })
    }
  }

  // Final sort across days
  matches.sort((a, b) => b.mtime - a.mtime)
  return matches.slice(0, MAX_LISTED)
}

// -- Real folders ---------------------------------------------------
// A folder that is a folder, not a link or junction to one (lstat).
function isRealFolder(dir) {
  try { return fs.lstatSync(dir).isDirectory() } catch { return false }
}

// Every folder from `sessionsDir` down to `dir` is a real one.
function realFolderChain(sessionsDir, dir) {
  const rel = path.relative(sessionsDir, dir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  let at = sessionsDir
  if (!isRealFolder(at)) return false
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part)
    if (!isRealFolder(at)) return false
  }
  return true
}

// -- samePath -------------------------------------------------------
// Two spellings of one directory, as far as a string can tell: resolved,
// and case-folded on Windows. Mirrors sameDirectory in
// src/main/providers/codex/rollout-lookup.ts.
function samePath(a, b, platform) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const win = platform === 'win32'
  const api = win ? path.win32 : path.posix
  const norm = (p) => { const r = api.resolve(p); return win ? r.toLowerCase() : r }
  return norm(a) === norm(b)
}

// -- Worktrees ------------------------------------------------------
// The project's git worktrees, as Claude's picker enumerates them
// (scripts/resume-picker.js, parseWorktrees / listWorktrees /
// worktreeLabelFor, which this CJS lib cannot import): `git worktree list
// --porcelain` from the configured directory, the first record the main
// worktree. FAIL-SAFE: no git, no repository or a timeout gives the
// configured directory alone, as before. The configured directory is
// always one of them (a project folder inside a repository is not a
// worktree root, and its conversations must still be listed).
function parseWorktrees(porcelainText) {
  if (!porcelainText || typeof porcelainText !== 'string') return []
  const worktrees = []
  let current = null
  const flush = () => {
    if (current && current.path) worktrees.push(current)
    current = null
  }
  for (const rawLine of porcelainText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') { flush(); continue }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length).trim(), branch: null, isMain: false }
      continue
    }
    if (!current) continue
    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  flush()
  if (worktrees.length > 0) worktrees[0].isMain = true
  return worktrees
}

// P3.5 fix round 1: git is never resolved from the project folder. It is
// named by an absolute path found on PATH's absolute entries (findGit, as
// the reviewer's src/main/review-diff.ts findGit), never spawned by bare
// name, never through a shell; on Windows the child also gets
// NoDefaultCurrentDirectoryInExePath=1 (one spelling), as the reviewer's
// environment does. The command line keeps the repository's own settings
// from running anything (no pager, no fsmonitor hook). Only absolute worktree
// paths with no control character are kept. `deps` (spawn, env, isFile) is
// injected by tests; nothing else passes it.
const GIT_WORKTREE_ARGS = Object.freeze(['--no-pager', '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain'])
function findGit(pathVar, platform, isFile) {
  const win = platform === 'win32'
  const api = win ? path.win32 : path.posix
  const dirs = String(pathVar || '').split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && !d.includes('%') && (win ? /^([A-Za-z]:[\\/]|\\\\[^\\?.])/.test(d) : d.startsWith('/')))
  for (const dir of dirs) {
    const candidate = api.join(dir, win ? 'git.exe' : 'git')
    try { if (isFile(candidate)) return candidate } catch { /* not there */ }
  }
  return null
}
const isAbsoluteFor = (p, platform) => (platform === 'win32' ? /^([A-Za-z]:[\\/]|\\\\[^\\?.][^\\]*\\[^\\]+)/.test(p) : p.startsWith('/'))
const hasControlChar = (s) => [...s].some((c) => { const n = c.codePointAt(0); return n < 32 || (n >= 127 && n < 160) })
function listWorktrees(cwd, platform, deps) {
  const plat = platform || process.platform
  const own = { path: cwd, branch: null, isMain: true }
  const env = (deps && deps.env) || process.env
  const spawn = (deps && deps.spawn) || spawnSync
  const isFile = (deps && deps.isFile) || ((p) => fs.statSync(p).isFile())
  let found = []
  try {
    const pathKey = Object.keys(env).find((k) => (plat === 'win32' ? k.toUpperCase() : k) === 'PATH')
    const git = findGit(pathKey ? env[pathKey] : undefined, plat, isFile)
    if (git) {
      const childEnv = {}
      for (const k of Object.keys(env)) {
        if (plat === 'win32' && k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') continue
        childEnv[k] = env[k]
      }
      if (plat === 'win32') childEnv.NoDefaultCurrentDirectoryInExePath = '1'
      const res = spawn(git, [...GIT_WORKTREE_ARGS], { cwd, env: childEnv, encoding: 'utf-8', timeout: 5000, windowsHide: true, shell: false })
      if (res && !res.error && res.status === 0 && typeof res.stdout === 'string' && res.stdout) {
        found = parseWorktrees(res.stdout).filter((w) => isAbsoluteFor(w.path, plat) && !hasControlChar(w.path))
      }
    }
  } catch { found = [] }
  return found.some((w) => samePath(w.path, cwd, plat)) ? found : [own, ...found]
}

function worktreeLabelFor(worktree) {
  if (!worktree || worktree.isMain) return null
  const base = worktree.path ? path.basename(worktree.path.replace(/[\\/]+$/, '')) : ''
  return base || worktree.branch || null
}

// -- Display text ---------------------------------------------------
// Everything the picker shows that it did not write itself -- a first
// prompt, a model or effort label, a session name, a worktree's name, the
// directory -- is shown as plain text: every control character (C0, DEL,
// C1), the bidi overrides, marks and isolates, the zero-width and
// invisible formatters, the line and paragraph separators and the TAG
// block become a space, and the text is cut at `max` code points, never
// inside a surrogate pair. The same class as src/shared/safe-text.ts,
// which this CJS lib cannot import (and Claude's picker's displayPath).
const NOT_PLAIN_TEXT = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu
function displayText(raw, max) {
  const limit = typeof max === 'number' && max > 0 ? max : 500
  const clean = (raw === undefined || raw === null ? '' : String(raw)).replace(NOT_PLAIN_TEXT, ' ')
  const points = Array.from(clean)
  return points.length <= limit ? clean : points.slice(0, limit).join('')
}

const ELLIPSIS = String.fromCharCode(0x2026)
const MIDDLE_DOT = String.fromCharCode(0xb7)
/** Cut to `max` code points, the last one an ellipsis when it was cut. */
function fit(str, max) {
  const points = Array.from(str)
  if (points.length <= max) return str
  return points.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS
}

function timeAgo(ms, now) {
  const sec = Math.floor(((typeof now === 'number' ? now : Date.now()) - ms) / 1000)
  if (!Number.isFinite(sec) || sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

// -- Names ----------------------------------------------------------
// The app's own name for each conversation, as Claude's picker reads it
// (loadWorkNames): session-state.json in the config folder the app hands
// the picker (CCC_CONFIG_DIR), each session's customName keyed by the
// conversation it resumes (resumeUuid). FAIL-SAFE: an empty map.
function loadWorkNames(configDir) {
  const map = new Map()
  try {
    if (!configDir) return map
    const data = JSON.parse(fs.readFileSync(path.join(configDir, 'session-state.json'), 'utf-8'))
    const sessions = Array.isArray(data && data.sessions) ? data.sessions : []
    for (const s of sessions) {
      const name = s && typeof s.customName === 'string' ? s.customName.trim() : ''
      const uuid = s && typeof s.resumeUuid === 'string' ? s.resumeUuid : ''
      if (name && isResumeId(uuid)) map.set(uuid, name)
    }
  } catch { /* fail-safe */ }
  return map
}

// -- The name file (P3.12, row 32) ----------------------------------
// The app writes `rollout-....ccc-name.json` next to a rollout (on a rename,
// and at the session's exact claim of it), as it writes `<uuid>.ccc-name.json`
// next to a Claude transcript; the picker prefers it over the session-state
// names, as Claude's picker does, so a renamed conversation keeps its name
// after its tab is closed. Read only when it is a plain file (never through a
// link: lstat, then the opened file must be that one), at most
// NAME_FILE_MAX_BYTES, valid JSON with a non-blank string name. FAIL-SAFE: null.
const NAME_FILE_MAX_BYTES = 4096
function readRolloutName(rolloutPath) {
  let fd = null
  try {
    if (typeof rolloutPath !== 'string' || !rolloutPath.endsWith('.jsonl')) return null
    const p = rolloutPath.slice(0, -'.jsonl'.length) + '.ccc-name.json'
    const seen = fs.lstatSync(p, { bigint: true })
    if (!seen.isFile() || seen.size > BigInt(NAME_FILE_MAX_BYTES)) return null
    fd = fs.openSync(p, 'r')
    const st = fs.fstatSync(fd, { bigint: true })
    if (!st.isFile() || st.dev !== seen.dev || st.ino !== seen.ino) return null
    const buf = Buffer.alloc(NAME_FILE_MAX_BYTES)
    const n = fs.readSync(fd, buf, 0, NAME_FILE_MAX_BYTES, 0)
    const parsed = JSON.parse(buf.subarray(0, n).toString('utf-8'))
    const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim() : ''
    return name || null
  } catch {
    return null
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* already closed */ } }
  }
}

// -- buildPickerRows ------------------------------------------------
// The ONE place the picker's rows are built: every string in a row has
// been through displayText and fits `width` code points. A conversation
// with a name leads with it and shows its first prompt beneath (as
// Claude's picker does); `tag` names a worktree other than the main one.
function buildPickerRows(conversations, names, width, now, openElsewhere) {
  const w = Math.max(10, Math.floor(Number(width) || 60))
  const at = typeof now === 'number' ? now : Date.now()
  return (Array.isArray(conversations) ? conversations : []).map((conv, i) => {
    // The name file's name first (P3.12), then the session-state name.
    const fileName = typeof conv.name === 'string' && conv.name ? conv.name : undefined
    const name = fileName || (names && typeof names.get === 'function' ? names.get(conv.id) : undefined)
    const label = displayText(conv.label)
    const title = fit(name ? displayText(name) : label, w)
    const meta = fit([
      conv.model ? displayText(conv.model, 64) : null,
      conv.effort ? displayText(conv.effort, 32) : null,
      timeAgo(conv.mtime, at),
      isOpenElsewhere(openElsewhere, conv.id) ? OPEN_ELSEWHERE_WORDS : null,
    ].filter(Boolean).join(` ${MIDDLE_DOT} `), w)
    return {
      num: String(i + 1).padStart(2),
      title,
      named: !!name,
      sub: name ? fit(label, w) : null,
      meta,
      tag: conv.worktreeLabel ? fit(displayText(conv.worktreeLabel, 64), Math.min(24, w)) : null,
    }
  })
}

// -- Open in another tab (P3.10 round 1, V2) ------------------------
// Codex lets one tab at a time write a conversation (0.155.1 shows its own
// lock screen; 0.153.4 refuses the resume). The app names the conversations
// its other open tabs are on (CCC_CODEX_OPEN_ELSEWHERE: ids, comma-separated,
// from main's own record, as the launch saw them), so a row says so, and a
// resume Codex refused for one is said to be open in another tab rather than
// gone. FAIL-SAFE: an empty set.
const OPEN_ELSEWHERE_VAR = 'CCC_CODEX_OPEN_ELSEWHERE'
const OPEN_ELSEWHERE_MAX = 64
const OPEN_ELSEWHERE_WORDS = 'open in another tab'
function openElsewhereIds(env) {
  const values = new Set()
  for (const k of Object.keys(env || {})) {
    const v = env[k]
    if (typeof v === 'string' && k.toUpperCase() === OPEN_ELSEWHERE_VAR) values.add(v)
  }
  const out = new Set()
  if (values.size !== 1) return out
  for (const id of [...values][0].split(',').slice(0, OPEN_ELSEWHERE_MAX)) {
    if (isResumeId(id)) out.add(id.toLowerCase())
  }
  return out
}
function isOpenElsewhere(openElsewhere, id) {
  return !!openElsewhere && typeof openElsewhere.has === 'function' && typeof id === 'string' && openElsewhere.has(id.toLowerCase())
}
// The line the picker prints when Codex's resume of the picked conversation
// failed and it starts a new one instead.
function fallbackNotice(resumeUuid, openElsewhere) {
  return isOpenElsewhere(openElsewhere, resumeUuid)
    ? 'This conversation is open in another tab, and Codex lets one tab at a time write to it -- starting a new conversation...'
    : 'Conversation no longer available -- starting fresh session...'
}

// -- The pick file --------------------------------------------------
// Where the app asked the picker to record each decision it makes
// (CCC_CODEX_PICK_FILE), so the session's status line and the session
// itself follow what it runs (P3.5; fix round 1: EVERY decision, so the app
// claims nothing before one): `{ id }` when it resumes that conversation,
// `{ fresh: true }` when it starts a new one (New conversation, nothing to
// list, or the fallback after a resume failed). The latest decision wins.
function pickDecision(resumeUuid) {
  return isResumeId(resumeUuid) ? { id: resumeUuid } : { fresh: true }
}

// A rename Windows refuses for a moment (another program -- a virus
// scanner, the app reading the last decision -- has one of the files open)
// is tried again, a short wait apart: four more tries, 150 ms of waiting in
// all, never more, so the launch is never held up for longer.
const PICK_RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const PICK_RENAME_WAITS_MS = [10, 20, 40, 80]

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* no wait */ }
}

const PICK_IO = {
  writeFileSync: (file, data, opts) => fs.writeFileSync(file, data, opts),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (file) => fs.unlinkSync(file),
  sleep: sleepSync,
}

// The pick folder's identity: its device and file id, read exactly (lstat,
// as main reads them when it makes the folder). Null unless it is a real
// folder, not a link or junction to one.
function folderIdOf(dir) {
  try {
    const st = fs.lstatSync(dir, { bigint: true })
    if (!st.isDirectory() || st.isSymbolicLink()) return null
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

// A decision is written whole: into a new file beside the pick file
// (exclusive create, owner-only where the platform keeps modes), then
// renamed over it, which replaces whatever entry is there -- a link
// included -- and never writes through one; a folder there is left as it
// is. To an absolute path only. With `ops.dirId` (fix round 3), only into
// the folder with that identity, looked at before the new file is written
// and again before each rename: a link or junction, or another folder, in
// its place is never written into. Best-effort: false when not written (the
// new file is then removed). `ops` also replaces the file operations in tests.
function writePick(file, decision, ops) {
  const io = { ...PICK_IO, ...(ops || {}) }
  const checksFolder = !!ops && Object.prototype.hasOwnProperty.call(ops, 'dirId')
  const folderIsMade = () => !checksFolder || (typeof io.dirId === 'string' && io.dirId !== '' && folderIdOf(path.dirname(file)) === io.dirId)
  let body = null
  if (decision && typeof decision === 'object') {
    const keys = Object.keys(decision)
    if (keys.length === 1 && keys[0] === 'id' && isResumeId(decision.id)) body = { id: decision.id }
    else if (keys.length === 1 && keys[0] === 'fresh' && decision.fresh === true) body = { fresh: true }
  }
  if (typeof file !== 'string' || !path.isAbsolute(file) || !body) return false
  if (!folderIsMade()) return false
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    io.writeFileSync(tmp, JSON.stringify(body), { flag: 'wx', mode: 0o600 })
  } catch {
    return false
  }
  for (let attempt = 0; ; attempt++) {
    if (!folderIsMade()) break
    try {
      io.renameSync(tmp, file)
      return true
    } catch (err) {
      const code = err && err.code
      if (attempt < PICK_RENAME_WAITS_MS.length && PICK_RENAME_RETRY_CODES.has(code)) {
        io.sleep(PICK_RENAME_WAITS_MS[attempt])
        continue
      }
      break
    }
  }
  try { io.unlinkSync(tmp) } catch { /* nothing left to remove */ }
  return false
}

// A decision the app asked for (it named a pick file) and could not be told
// leaves the watcher where it was: before a first decision it claims
// nothing, so the status line stays empty; after one it keeps following the
// conversation it has. It never claims one the picker did not name. The
// launch goes on either way; the terminal says so. Returns that notice, or
// null when the decision was recorded or none was asked for.
const PICK_NOT_RECORDED_NOTICE = '\n  AI Code Conductor could not be told which conversation this session runs, so its status line will not follow it. The conversation itself is not affected.\n'

// `dirId`: the pick folder's identity as the app recorded it
// (CCC_CODEX_PICK_DIR_ID); without it nothing is written.
function recordPick(file, resumeUuid, dirId, ops) {
  if (typeof file !== 'string' || file === '') return null
  const written = writePick(file, pickDecision(resumeUuid), { ...(ops || {}), dirId: typeof dirId === 'string' ? dirId : '' })
  return written ? null : PICK_NOT_RECORDED_NOTICE
}

// The environment Codex itself starts with: the picker's own, without the
// pick file's name or its folder's identity (in any spelling; Windows names
// are case-insensitive), so nothing the session runs can record a pick of
// its own; nor the ids of other tabs' conversations (P3.10 round 1).
function childEnv(env) {
  const out = {}
  for (const k of Object.keys(env || {})) {
    const name = k.toUpperCase()
    if (name === 'CCC_CODEX_PICK_FILE' || name === 'CCC_CODEX_PICK_DIR_ID' || name === OPEN_ELSEWHERE_VAR) continue
    out[k] = env[k]
  }
  return out
}

// Where the chosen conversation's CLI starts: its own worktree (the path
// git reported, never one a rollout names) when that is another directory
// that exists (the picker passes isDirectory, the check main's resume makes;
// fix round 2); otherwise the current one (null). Claude's picker's
// resolveRetargetCwd, less the project-settings gate a managed Claude
// launch carries (a Codex launch has none).
function isDirectory(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function resolveRetargetCwd(resumeId, sourceCwd, currentCwd, isDirFn, platform) {
  if (!resumeId || !sourceCwd) return { cwd: null }
  try {
    if (samePath(sourceCwd, currentCwd, platform || process.platform) || !isDirFn(sourceCwd)) return { cwd: null }
  } catch {
    return { cwd: null }
  }
  return { cwd: sourceCwd }
}

// -- buildResumeArgs ------------------------------------------------
// Returns argv for `codex` (or the picker's wrapping spawn).
//   uuid != null -> ['resume', uuid, ...flags]
//   uuid == null -> [...flags] (fresh session)
// The id comes from a transcript file: only a UUID resumes (WP2), anything
// else -- an option-shaped string included -- starts a fresh session.
function buildResumeArgs(uuid, flags) {
  if (isResumeId(uuid)) return ['resume', uuid, ...flags]
  return [...flags]
}

// -- shouldFallback -------------------------------------------------
// Decides whether `launchCodex` should retry as a fresh `codex` session.
// Only retries when (a) we tried a `codex resume <uuid>` (resumeUuid is set)
// AND (b) the resume exited non-zero with a real status code. A null status
// means spawnSync failed to launch the process at all (e.g. ENOENT) -- no
// point retrying with a fresh session because the same binary is missing;
// caller should surface the error instead.
function shouldFallback(resumeUuid, exitStatus) {
  if (!resumeUuid) return false
  if (exitStatus === null || exitStatus === undefined) return false
  return exitStatus !== 0
}

// -- shouldUseShell -------------------------------------------------
// Decides whether spawnSync should wrap the command in cmd.exe. Mirrors
// src/main/providers/codex/spawn.ts:50-53: only wrap on win32 when the
// resolved command is a .cmd or .bat shim. A real codex.exe path needs
// no shell -- wrapping it adds quoting/injection edge cases.
function shouldUseShell(cmd, platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
}

// -- launchTarget ---------------------------------------------------
// How the picker starts codex (WP2): never through a shell option. A .cmd or
// .bat shim runs through cmd.exe named by absolute path (ComSpec or
// SystemRoot, in any spelling: Windows names are case-insensitive), AutoRun
// and delayed expansion off, in the `/s /c ""<shim>" <args>"` form, passed
// VERBATIM (`verbatim: true` -> spawnSync's windowsVerbatimArguments):
// libuv's per-argument quoting would escape the inner quotes. cmd.exe still
// parses the line, so a path or an argument carrying one of its
// metacharacters is refused rather than quoted. Null = refused. Mirrors
// codexCmdExeTarget in src/main/providers/codex/spawn.ts.
const CMD_UNSAFE_PATH_RE = /["%&^]/
const CMD_UNSAFE_ARG_RE = /["%&^|<>!()\s]/
const WIN_ABSOLUTE_RE = /^([A-Za-z]:\\|\\\\[^\\?.][^\\]*\\[^\\]+\\)/
const hasControl = (s) => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
function envValue(env, name) {
  const values = new Set()
  for (const k of Object.keys(env || {})) {
    const v = env[k]
    if (typeof v === 'string' && v !== '' && /^[A-Za-z]+$/.test(k) && k.toUpperCase() === name.toUpperCase()) values.add(v)
  }
  return values.size === 1 ? [...values][0] : undefined
}
function launchTarget(cmd, args, platform, env) {
  if (!shouldUseShell(cmd, platform)) return { file: cmd, args, verbatim: false }
  const usable = (p) => typeof p === 'string' && WIN_ABSOLUTE_RE.test(p) && /[\\/]cmd\.exe$/i.test(p) && !CMD_UNSAFE_PATH_RE.test(p) && !hasControl(p)
  const comSpec = envValue(env, 'ComSpec')
  const root = envValue(env, 'SystemRoot')
  const system32 = root ? root.replace(/\\+$/, '') + '\\System32\\cmd.exe' : undefined
  const shell = usable(comSpec) ? comSpec : usable(system32) ? system32 : null
  if (!shell) return null
  if (!WIN_ABSOLUTE_RE.test(cmd) || /[. ]$/.test(cmd) || CMD_UNSAFE_PATH_RE.test(cmd) || hasControl(cmd)) return null
  if (args.some((a) => typeof a !== 'string' || a === '' || CMD_UNSAFE_ARG_RE.test(a) || hasControl(a))) return null
  return { file: shell, args: ['/d', '/v:off', '/s', '/c', `"${[`"${cmd}"`, ...args].join(' ')}"`], verbatim: true }
}

// -- isResumeId -----------------------------------------------------
// A conversation id read from a transcript is used only when it is a UUID:
// anything else starts a fresh session.
function isResumeId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)
}

module.exports = {
  parseRollout, walkRollouts, buildResumeArgs, shouldFallback, shouldUseShell, launchTarget, isResumeId,
  samePath, parseWorktrees, listWorktrees, worktreeLabelFor, displayText, buildPickerRows, loadWorkNames, readRolloutName, pickDecision, writePick, recordPick, folderIdOf, childEnv, isDirectory, resolveRetargetCwd, timeAgo,
  openElsewhereIds, fallbackNotice,
}
