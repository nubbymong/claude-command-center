// Helper module for scripts/codex-resume-picker.js. Lives in scripts/lib so
// the unit test (tests/unit/scripts/codex-resume-picker.test.ts) can require()
// these helpers without running main(). The picker script require()s this lib
// at runtime; both files are bundled together at deploy time.
//
// Self-contained Node.js, stdlib only.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

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

  // Walk subsequent lines for turn_context (any position) and first user_message.
  //
  // Two rollout formats supported (codex CLI changed the shape between
  // 0.128 and 0.133):
  //   - Legacy:  { type: 'event_msg',     payload: { type: 'user_message', message: '...' } }
  //   - Current: { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] } }
  //
  // In the current format Codex injects synthetic wrapper messages at the
  // top of every session (<environment_context>, <collaboration_mode>,
  // <permissions instructions>, etc.). These start with an XML-style
  // opening tag and should NOT be displayed as the conversation label.
  // The heuristic: skip any input_text that begins with `<` followed by
  // a letter (i.e. looks like a wrapper tag). The first real user input
  // wins.
  let model = meta.model
  let effort
  let label = '(continued session)'
  let foundLabel = false

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

    // Legacy format
    if (evt.type === 'event_msg' && evt.payload && evt.payload.type === 'user_message') {
      const m = evt.payload.message
      if (typeof m === 'string' && m.trim()) {
        label = m.replace(/[\r\n]+/g, ' ').trim()
        foundLabel = true
        continue
      }
    }

    // Current format -- response_item / message / role=user / content[].input_text
    if (evt.type === 'response_item' && evt.payload && evt.payload.type === 'message' && evt.payload.role === 'user' && Array.isArray(evt.payload.content)) {
      for (const part of evt.payload.content) {
        if (!part || typeof part !== 'object') continue
        if (part.type !== 'input_text') continue
        const text = part.text
        if (typeof text !== 'string') continue
        const trimmed = text.trim()
        if (!trimmed) continue
        // Skip Codex-injected wrappers like <environment_context>, <collaboration_mode>, etc.
        if (/^<[A-Za-z]/.test(trimmed)) continue
        label = trimmed.replace(/[\r\n]+/g, ' ').slice(0, 200)
        foundLabel = true
        break
      }
    }
  }

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
  if (!fs.existsSync(sessionsDir)) return []
  const matches = []

  for (const dayDir of dayFolders(sessionsDir, maxDays, Date.now())) {
    if (matches.length >= MAX_LISTED) break
    if (!fs.existsSync(dayDir)) continue

    let files
    try {
      files = fs.readdirSync(dayDir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
    } catch { continue }

    // Sort newest-first within day by mtime
    const dayEntries = []
    for (const f of files) {
      const fp = path.join(dayDir, f)
      let st
      try { st = fs.statSync(fp) } catch { continue }
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
      matches.push({ id: parsed.id, cwd: parsed.cwd, model: parsed.model, effort: parsed.effort, label: parsed.label, mtime, sourceCwd: wt.path, worktreeLabel: worktreeLabelFor(wt) })
    }
  }

  // Final sort across days
  matches.sort((a, b) => b.mtime - a.mtime)
  return matches.slice(0, MAX_LISTED)
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

function listWorktrees(cwd, platform) {
  const plat = platform || process.platform
  const own = { path: cwd, branch: null, isMain: true }
  let found = []
  try {
    const res = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf-8', timeout: 5000, windowsHide: true })
    if (!res.error && res.status === 0 && res.stdout) found = parseWorktrees(res.stdout)
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
const SPOOFABLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu
function displayText(raw, max) {
  const limit = typeof max === 'number' && max > 0 ? max : 500
  const clean = (raw === undefined || raw === null ? '' : String(raw)).replace(SPOOFABLE, ' ')
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

// -- buildPickerRows ------------------------------------------------
// The ONE place the picker's rows are built: every string in a row has
// been through displayText and fits `width` code points. A conversation
// with a name leads with it and shows its first prompt beneath (as
// Claude's picker does); `tag` names a worktree other than the main one.
function buildPickerRows(conversations, names, width, now) {
  const w = Math.max(10, Math.floor(Number(width) || 60))
  const at = typeof now === 'number' ? now : Date.now()
  return (Array.isArray(conversations) ? conversations : []).map((conv, i) => {
    const name = names && typeof names.get === 'function' ? names.get(conv.id) : undefined
    const label = displayText(conv.label)
    const title = fit(name ? displayText(name) : label, w)
    const meta = fit([
      conv.model ? displayText(conv.model, 64) : null,
      conv.effort ? displayText(conv.effort, 32) : null,
      timeAgo(conv.mtime, at),
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

// -- The pick file --------------------------------------------------
// Where the app asked the picker to record the conversation it opens
// (CCC_CODEX_PICK_FILE), so the session's status line and the session
// itself follow THAT conversation (P3.5). A conversation id only, to an
// absolute path only, into a new file only (exclusive create, owner-only):
// never over anything already there. Best-effort: false when not written.
function writePick(file, id) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !isResumeId(id)) return false
    fs.writeFileSync(file, JSON.stringify({ id }), { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

// The environment Codex itself starts with: the picker's own, without the
// pick file's name (in any spelling; Windows names are case-insensitive),
// so nothing the session runs can record a pick of its own.
function childEnv(env) {
  const out = {}
  for (const k of Object.keys(env || {})) {
    if (k.toUpperCase() === 'CCC_CODEX_PICK_FILE') continue
    out[k] = env[k]
  }
  return out
}

// Where the chosen conversation's CLI starts: its own worktree (the path
// git reported, never one a rollout names) when that is another directory
// that exists; otherwise the current one (null). Claude's picker's
// resolveRetargetCwd, less the project-settings gate a managed Claude
// launch carries (a Codex launch has none).
function resolveRetargetCwd(resumeId, sourceCwd, currentCwd, existsFn, platform) {
  if (!resumeId || !sourceCwd) return { cwd: null }
  try {
    if (samePath(sourceCwd, currentCwd, platform || process.platform) || !existsFn(sourceCwd)) return { cwd: null }
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
  samePath, parseWorktrees, listWorktrees, worktreeLabelFor, displayText, buildPickerRows, loadWorkNames, writePick, childEnv, resolveRetargetCwd, timeAgo,
}
