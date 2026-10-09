#!/usr/bin/env node
// Claude Command Center — Resume Picker
// Shows a conversation picker in the terminal before Claude launches.
// For local (non-SSH) sessions that have prior conversations on disk.
//
// WORKTREE-AWARE (bug #5): a conversation that ran inside a git worktree of the
// project is stored under its OWN ~/.claude/projects/<mangled-worktree-cwd>
// folder, NOT the configured cwd's folder. Scanning only the cwd folder makes
// those conversations INVISIBLE in the list (the user got dropped onto a stale
// fork). So we enumerate the project's worktrees, include every worktree's
// conversations, LABEL the non-main ones, and — because `claude --resume <uuid>`
// is cwd-scoped — launch the chosen conversation from ITS OWN cwd.
//
// Self-contained Node.js (CommonJS, stdlib only). Pure-logic helpers are
// exported via module.exports (guarded by require.main === module) so the unit
// test (tests/unit/scripts/resume-picker.test.ts) can require() them without
// running main(). FAIL-SAFE throughout: any git/fs error falls back to the
// current single-source behaviour or a fresh launch — the picker must NEVER
// crash the session spawn.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const readline = require('readline')

// ── Path encoding ───────────────────────────────────────────────────
// Maps a filesystem cwd to Claude CLI's project-folder naming convention.
//
// SOURCE OF TRUTH: src/main/logging/transcript-discovery.ts → mangleCwdToProjectDir
// (verified 2026-06-06 against real ~/.claude/projects dirs). This script is CJS
// and cannot import that TS module, so the rule is replicated here verbatim:
//
//   Replace EVERY non-alphanumeric character (`:` `\` `/` `_` `.` space …) with
//   a single `-`. No run-collapsing. Case preserved.
//
//   Formally: cwd.replace(/[^A-Za-z0-9]/g, '-')
//
// Verified examples:
//   F:\MY_PROJECT                              → F--MY-PROJECT
//   f:\sample_app                                   → f--sample-app
//   F:\sample_app\.claude-worktrees\warm-toolchain  → F--sample-app--claude-worktrees-warm-toolchain
//   C:\Users\jane                                   → C--Users-jane
//
// The OLD rule (only `:` `\` `_`, leaving `.` etc.) produced the WRONG folder
// name for dotted/worktree paths, which is exactly why worktree conversations
// were invisible. The case-insensitive readdirSync match in main() is kept as a
// belt-and-braces guard on top of this.
//
// P3.16a round 2 (Q1): a name longer than 200 characters is cut at 200, and
// `-` and the base-36 absolute value of a 32-bit hash of the WHOLE folder
// follow it, as Claude Code names it (src/shared/project-key.ts, replicated).
function encodeProjectPath(p) {
  const cwd = String(p)
  const name = cwd.replace(/[^A-Za-z0-9]/g, '-')
  if (name.length <= 200) return name
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = (h << 5) - h + cwd.charCodeAt(i) | 0
  return name.slice(0, 200) + '-' + Math.abs(h).toString(36)
}

// ── Project-dir resolution ──────────────────────────────────────────
// Mangle a cwd and case-insensitively match it against the on-disk
// ~/.claude/projects folders (belt-and-braces on top of the now-correct
// mangle). Returns the matched absolute folder path or null. FAIL-SAFE.
//
// PR-level ADR-009 round 1 (A3): the folder is named from the cwd's REAL path,
// as Claude Code names it and as the app does (src/main/logging/
// transcript-discovery.ts claudeProjectDirName: fs.realpathSync, the JS one),
// so a folder reached through a link or a junction finds its conversations; a
// cwd whose real path cannot be read is named as given, as there. `realpath`
// is injectable for the unit test.
function resolveProjectDir(claudeProjectsDir, cwd, realpath = fs.realpathSync) {
  try {
    let folder = cwd
    try { folder = realpath(cwd) } catch { /* named as given */ }
    const encoded = encodeProjectPath(folder)
    let dirs
    try { dirs = fs.readdirSync(claudeProjectsDir) } catch { return null }
    for (const d of dirs) {
      if (d.toLowerCase() === encoded.toLowerCase()) return path.join(claudeProjectsDir, d)
    }
    return null
  } catch {
    return null
  }
}

// ── Companion-dir ensure ────────────────────────────────────────────
// Mirror of src/main/logging/companion-dir.ts (this CJS script cannot import
// the TS module). The Claude CLI only creates a `<uuid>/` companion dir beside a
// transcript LAZILY (first subagent/workflow/large-tool-result). A direct-work
// conversation has the `.jsonl` but no companion dir, and `claude --resume`
// needs one — so before resuming the chosen conversation we ensure it exists.
//
// Creates `<projectDir>/<uuid>/subagents/` + `/workflows/` (a recursive mkdir of
// each subdir creates the `<uuid>/` parent too). ORPHAN-SAFE: only acts when the
// `<uuid>.jsonl` transcript exists. IDEMPOTENT: a no-op when the dir is already
// present; never deletes. FAIL-SAFE: any fs error returns false, never throws.
function ensureCompanionDir(projectDir, uuid) {
  try {
    if (!projectDir || !uuid) return false
    const transcript = path.join(projectDir, `${uuid}.jsonl`)
    if (!fs.existsSync(transcript)) return false // never create an orphan dir
    const companion = path.join(projectDir, uuid)
    if (fs.existsSync(companion)) {
      // A stray same-named FILE must never be mkdir'd over — refuse it.
      let isDir
      try { isDir = fs.statSync(companion).isDirectory() } catch { return false }
      if (!isDir) return false
      // Otherwise fall through: recursive mkdir HEALS a partially-created dir.
    }
    fs.mkdirSync(path.join(companion, 'subagents'), { recursive: true })
    fs.mkdirSync(path.join(companion, 'workflows'), { recursive: true })
    return true
  } catch {
    return false
  }
}

// ── Worktree enumeration ────────────────────────────────────────────
// Parse `git worktree list --porcelain` output into worktree records.
//
//   worktree /abs/path/to/main
//   HEAD <sha>
//   branch refs/heads/main
//
//   worktree /abs/path/to/.git-worktrees/feature
//   HEAD <sha>
//   branch refs/heads/feature
//
// Records are separated by blank lines. The FIRST record is the main worktree.
// A detached worktree has `detached` instead of `branch`. Returns:
//   [{ path, branch | null, isMain }]
// FAIL-SAFE: garbage / empty input → []. Never throws.
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
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      // A new record begins. Flush any in-progress one (defensive: some git
      // versions omit the trailing blank line between records).
      flush()
      current = { path: line.slice('worktree '.length).trim(), branch: null, isMain: false }
      continue
    }
    if (!current) continue
    if (line.startsWith('branch ')) {
      // branch refs/heads/<name> → keep the short <name>.
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.replace(/^refs\/heads\//, '')
    }
    // HEAD / detached / bare / locked / prunable lines are ignored.
  }
  flush()

  if (worktrees.length > 0) worktrees[0].isMain = true
  return worktrees
}

// ── Programs from PATH's folders ────────────────────────────────────
// The picker starts git -- and, on Windows, Claude Code -- only by a full
// path found in a folder PATH names: never by a bare name (which Windows, or
// a shell, also looks up in the current folder -- the project). It finds
// them in-process, never through the where command or a shell; git starts
// without a shell, and a claude.cmd or claude.bat launcher only through the
// system cmd.exe, by its full path (buildSpawnTarget). Elsewhere Claude Code
// is started by its name, as before. The folder rule is the app's own
// (src/main/windows-programs.ts and src/main/providers/windows-path-names.ts,
// which this script cannot import; a parity test holds the copy to the same
// answer): on Windows only a fully qualified folder -- a drive, or a share --
// with one pair of surrounding quotes dropped, never one holding an
// unexpanded `%`, each named as Windows names it when it starts a program from
// it (a folder name's one trailing dot dropped); elsewhere only an absolute
// folder, and only a file the user may run. `env`, `platform` and `isFile`
// are for tests.
function isFileOnDisk(p) {
  try {
    return fs.statSync(p).isFile()
  } catch (e) {
    // Not there; any other failure (a folder that does not answer) is thrown.
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false
    throw e
  }
}
// Elsewhere a program is also one the user may run, as the system's own
// lookup requires: a file without that permission is passed over.
function isRunnableOnDisk(p) {
  if (!fs.statSync(p).isFile()) return false
  fs.accessSync(p, fs.constants.X_OK)
  return true
}
function pathVariable(env, platform) {
  const source = env || {}
  if (typeof source.PATH === 'string') return source.PATH
  if (platform !== 'win32') return ''
  const key = Object.keys(source).find((k) => k.toUpperCase() === 'PATH')
  return key !== undefined && typeof source[key] === 'string' ? source[key] : ''
}
function folderAsRun(dir) {
  const parts = dir.split(/([\\/])/)
  // A share keeps `\\server\share` as it is: parts '', sep, '', sep, server, sep, share.
  const root = /^[\\/]{2}/.test(dir) ? 7 : 1
  return parts.map((part, i) => (i < root || i % 2 === 1 ? part : part.replace(/([^.])\.$/, '$1'))).join('')
}
/** A fully qualified Windows folder: a drive (`C:\`) or a share
 *  (`\\server\share`), never one named relative to the folder a program runs
 *  in. The app's own test (src/main/providers/windows-path-names.ts
 *  windowsPathFolderIsFullyQualified). */
const FULLY_QUALIFIED_FOLDER_RE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+)/
function pathFolders(env, platform) {
  if (platform === 'win32') {
    return pathVariable(env, platform).split(';')
      .map((d) => d.trim().replace(/^"(.*)"$/, '$1').trim())
      .filter((d) => d !== '' && !d.includes('%') && FULLY_QUALIFIED_FOLDER_RE.test(d))
      .map(folderAsRun)
  }
  return pathVariable(env, platform).split(':').filter((d) => d.startsWith('/'))
}
/** The names Claude Code goes by on Windows, in the order the app asks for
 *  them (src/main/claude-cli-probe.ts CLAUDE_WINDOWS_NAMES, which this script
 *  cannot import; a parity test holds the copy to the same list): the native
 *  claude.exe in any folder PATH names, then claude.cmd, then claude.bat. */
const CLAUDE_WINDOWS_NAMES = Object.freeze(['claude.exe', 'claude.cmd', 'claude.bat'])
/** The full path of the first of `names` found in PATH's folders -- every
 *  folder for the first name, then every folder for the next -- or null. A
 *  folder whose check throws (one that does not answer) is not asked again
 *  for another name, as the app's walk does. */
function findOnPath(names, env, platform, isFile) {
  const api = platform === 'win32' ? path.win32 : path.posix
  const dirs = pathFolders(env, platform)
  const unreachable = new Set()
  for (const name of names) {
    for (const dir of dirs) {
      if (unreachable.has(dir)) continue
      const candidate = api.join(dir, name)
      try { if (isFile(candidate)) return candidate } catch { unreachable.add(dir) }
    }
  }
  return null
}
/** A child's environment: on Windows NoDefaultCurrentDirectoryInExePath=1, in
 *  one spelling, so a program the child starts by a bare name is looked up in
 *  PATH's folders only, never in the folder it runs in. `env` is not changed. */
function withoutCurrentFolderLookup(env, platform) {
  const out = {}
  for (const k of Object.keys(env || {})) {
    if (platform === 'win32' && k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') continue
    out[k] = env[k]
  }
  if (platform === 'win32') out.NoDefaultCurrentDirectoryInExePath = '1'
  return out
}
/** The environment of a child the picker starts on Windows (a launcher's
 *  cmd.exe, git): withoutCurrentFolderLookup, and every spelling of PATH kept
 *  to its fully qualified folders (FULLY_QUALIFIED_FOLDER_RE), each read as a
 *  PATH walk reads it (trimmed, and without the quotes around a quoted one),
 *  a spelling left with none dropped. A program the child starts by a bare
 *  name (a launcher's `node`) is then found only in a folder PATH names in
 *  full: never in the project folder, nor in one named relative to it. The
 *  app's own rule (src/main/windows-programs.ts
 *  withFullyQualifiedProgramLookup, which this script cannot import; a parity
 *  test holds the copy to it). Elsewhere as withoutCurrentFolderLookup gives
 *  it. `env` is not changed. */
function withFullyQualifiedProgramLookup(env, platform) {
  const out = withoutCurrentFolderLookup(env, platform)
  if (platform !== 'win32') return out
  for (const key of Object.keys(out)) {
    if (key.toUpperCase() !== 'PATH') continue
    const value = out[key]
    const kept = []
    for (const raw of typeof value === 'string' ? value.split(';') : []) {
      let dir = raw.trim()
      if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
      if (FULLY_QUALIFIED_FOLDER_RE.test(dir)) kept.push(dir)
    }
    if (kept.length) out[key] = kept.join(';')
    else delete out[key]
  }
  return out
}

// Enumerate the project's worktrees from `cwd`. The configured cwd may itself BE
// a worktree — we include every worktree git reports regardless.
//
// git is started by its full path from PATH's folders (findOnPath), without a
// shell, its environment carrying the Windows rule for what it starts by name
// (withFullyQualifiedProgramLookup: PATH's fully qualified folders only, never
// the current folder); its command line keeps the repository's own settings
// from running anything (no pager, no file-system monitor hook). The project
// folder is git's working folder only.
//
// FAIL-SAFE: if git is missing, errors, or cwd isn't a repo, returns a SINGLE
// synthetic main-worktree record for `cwd` so callers degrade to exactly the
// old single-source behaviour (no labels). `platform` and `deps` (spawn, env,
// isFile) are for tests.
const GIT_WORKTREE_ARGS = Object.freeze(['--no-pager', '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain'])
function listWorktrees(cwd, platform, deps) {
  const fallback = [{ path: cwd, branch: null, isMain: true }]
  const plat = platform || process.platform
  const env = (deps && deps.env) || process.env
  const spawn = (deps && deps.spawn) || spawnSync
  const isFile = (deps && deps.isFile) || (plat === 'win32' ? isFileOnDisk : isRunnableOnDisk)
  try {
    const git = findOnPath([plat === 'win32' ? 'git.exe' : 'git'], env, plat, isFile)
    if (!git) return fallback
    const res = spawn(git, [...GIT_WORKTREE_ARGS], {
      cwd,
      env: withFullyQualifiedProgramLookup(env, plat),
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      shell: false,
    })
    if (!res || res.error || res.status !== 0 || !res.stdout) return fallback
    const parsed = parseWorktrees(res.stdout)
    return parsed.length > 0 ? parsed : fallback
  } catch {
    return fallback
  }
}

// Most-recognizable label for a non-main worktree: prefer the directory
// basename (e.g. `warm-toolchain`); fall back to the branch name.
function worktreeLabelFor(worktree) {
  if (!worktree || worktree.isMain) return null
  const base = worktree.path ? path.basename(worktree.path) : ''
  if (base) return base
  if (worktree.branch) return worktree.branch
  return null
}

// ── Sanitize message text ───────────────────────────────────────────
// The Claude CLI records structural XML inside user messages — slash-command
// invocations (<command-name>/foo</command-name><command-message>…</command-message>
// <command-args>…</command-args>), local-command output, and injected
// <system-reminder> blocks. Left in, this markup fills the row and pushes the
// real content off-screen (#130). Strip these tag families AND their contents
// (they're structure, not conversation), collapse whitespace, and return null
// when nothing meaningful remains (so a pure-command message is skipped).
function sanitizeMessageText(raw) {
  if (typeof raw !== 'string') return null
  const text = raw
    // <command-*>…</command-*> (name/message/args) and <local-command-*>…
    // </local-command-*> (stdout/stderr/caveat/…) — strip tags AND contents.
    // The backreference keeps each open tag matched to its own close tag.
    .replace(/<(command-[a-z]+)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(local-command-[a-z]+)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    // Leftover unpaired/partial wrapper tags (defensive).
    .replace(/<\/?(?:command-[a-z]+|local-command-[a-z]+|system-reminder)>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

// ── Extract user text from a message object ─────────────────────────
function extractUserText(obj) {
  if (obj.isMeta) return null
  let text = null
  if (typeof obj.message === 'string') {
    text = obj.message
  } else if (obj.message?.content) {
    if (typeof obj.message.content === 'string') {
      text = obj.message.content
    } else if (Array.isArray(obj.message.content)) {
      const textBlock = obj.message.content.find(b => b.type === 'text')
      if (textBlock) text = textBlock.text
    }
  }
  if (!text) return null
  // Tool-interrupt marker — not a tag, so sanitize won't catch it.
  if (text.startsWith('[Request interrupted')) return null
  // Strip command / system markup so the picker shows real content, not XML.
  return sanitizeMessageText(text)
}

// ── Parse conversation: first message from head, last 5 from tail ───
function parseConversation(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size < 20480) return null // Skip ghost sessions

    const fd = fs.openSync(filePath, 'r')
    const sessionId = path.basename(filePath, '.jsonl')

    // ── Read HEAD (first 32KB) for first message + model ──
    const headBuf = Buffer.alloc(Math.min(32768, stat.size))
    fs.readSync(fd, headBuf, 0, headBuf.length, 0)
    const headText = headBuf.toString('utf-8')
    const headLines = headText.split('\n').filter(Boolean)

    let firstMessage = null
    let model = null
    // Claude Code writes these metadata entries into the transcript: `ai-title`
    // is its own concise AI-generated title for the conversation; `last-prompt`
    // holds the most recent prompt text. They're the best labels when the head
    // has no clean user message (resumed/compacted sessions), so a conversation
    // no longer degrades to "(continued session)" (#130). No early break — these
    // entries sit after the first user/assistant lines, and the head is small.
    let aiTitle = null
    let lastPrompt = null

    for (const line of headLines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' && !firstMessage) {
          firstMessage = extractUserText(obj)
        } else if (obj.type === 'assistant' && obj.message?.model && !model) {
          model = obj.message.model
        } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
          aiTitle = obj.aiTitle.trim() || aiTitle
        } else if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') {
          lastPrompt = sanitizeMessageText(obj.lastPrompt) || lastPrompt
        }
      } catch { /* skip */ }
    }

    // ── Read TAIL (last 128KB) for recent user messages ──
    const tailSize = Math.min(131072, stat.size)
    const tailOffset = Math.max(0, stat.size - tailSize)
    const tailBuf = Buffer.alloc(tailSize)
    fs.readSync(fd, tailBuf, 0, tailSize, tailOffset)
    fs.closeSync(fd)

    const tailText = tailBuf.toString('utf-8')
    // If we started mid-line, skip the first partial line
    const tailStart = tailOffset > 0 ? tailText.indexOf('\n') + 1 : 0
    const tailLines = tailText.slice(tailStart).split('\n').filter(Boolean)

    const recentMessages = []
    for (const line of tailLines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user') {
          const text = extractUserText(obj)
          if (text) recentMessages.push(text)
        } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
          aiTitle = obj.aiTitle.trim() // append-only log: the latest title wins
        } else if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') {
          const p = sanitizeMessageText(obj.lastPrompt)
          if (p) lastPrompt = p // latest wins
        }
      } catch { /* skip */ }
    }

    // Last 5 user messages
    const lastMessages = recentMessages.slice(-5)

    // firstMessage stays null when the head had no clean user text — the display
    // builds the label from the aiTitle/lastPrompt/lastMessages fallback chain.
    return {
      sessionId,
      aiTitle,
      firstMessage,
      lastPrompt,
      lastMessages,
      model,
      mtime: stat.mtimeMs,
      size: stat.size,
      filePath
    }
  } catch {
    return null
  }
}

// ── Scan one worktree's project dir ─────────────────────────────────
// Mangle the worktree path → case-insensitive match in ~/.claude/projects →
// list EVERY .jsonl → parseConversation. Each returned conversation is tagged
// with `sourceCwd` (the worktree path) and `worktreeLabel` (null for the main
// worktree). FAIL-SAFE: any error → [].
//
// We deliberately do NOT gate on a companion directory. The CLI only creates a
// `<uuid>/` companion dir LAZILY (first subagent/workflow/large-tool-result), so
// a conversation worked on directly never gets one — and the old gate hid those
// from the picker entirely, which is exactly how the user lost real work. We
// list them all here; launchClaude() ensures the companion dir for the chosen
// conversation just before `claude --resume`.
//
// `claudeProjectsDir` and the worktree record are injectable for testing.
function scanWorktreeConversations(worktree, claudeProjectsDir) {
  try {
    const projectDir = resolveProjectDir(claudeProjectsDir, worktree.path)
    if (!projectDir || !fs.existsSync(projectDir)) return []

    // List EVERY .jsonl (no companion-dir gate — see header above).
    let files
    try {
      files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(projectDir, f))
    } catch {
      return []
    }

    const label = worktreeLabelFor(worktree)
    return files
      .map(parseConversation)
      .filter(Boolean)
      .map(conv => ({ ...conv, sourceCwd: worktree.path, worktreeLabel: label }))
  } catch {
    return []
  }
}

// ── Merge + sort + cap ──────────────────────────────────────────────
// Merge tagged conversations from every worktree, sort by mtime desc, cap the
// list. Dedup by resolved filePath (defensive — e.g. cwd == a worktree path so
// the same project dir is scanned twice). `cap` defaults to 20 (bumped from the
// single-source 15 since there are now multiple sources).
function mergeAndLabel(conversationsBySource, cap = 20) {
  const all = []
  for (const list of conversationsBySource) {
    if (Array.isArray(list)) all.push(...list)
  }
  const seen = new Set()
  const deduped = []
  for (const conv of all) {
    const key = conv && conv.filePath ? path.resolve(conv.filePath) : null
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    deduped.push(conv)
  }
  deduped.sort((a, b) => b.mtime - a.mtime)
  return deduped.slice(0, cap)
}

// ── Time formatting ─────────────────────────────────────────────────
function timeAgo(ms, now = Date.now()) {
  const sec = Math.floor((now - ms) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

function formatSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

// ── ANSI helpers ────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  blue: '\x1b[38;2;137;180;250m',
  green: '\x1b[38;2;166;227;161m',
  yellow: '\x1b[38;2;249;226;175m',
  peach: '\x1b[38;2;250;179;135m',
  mauve: '\x1b[38;2;203;166;247m',
  text: '\x1b[38;2;205;214;244m',
  subtext: '\x1b[38;2;166;173;200m',
  overlay: '\x1b[38;2;147;153;178m',
  surface: '\x1b[38;2;69;71;90m',
}

// ── Display text ────────────────────────────────────────────────────
// Everything the picker shows that it did not write itself -- the folder, a
// work name, a title or message, a model, a session id, a worktree's name --
// is shown as plain text, by the same rule the app applies everywhere else
// (src/shared/safe-text.ts, which this script cannot import; a parity test
// holds the copies to one answer): every character a reader cannot see --
// the C0 and C1 controls and every character Unicode counts as
// default-ignorable (the bidi marks, overrides and isolates, the zero-width
// and invisible formatters, the fillers, the variation selectors, the TAG
// block) -- and, named one by one, the line and paragraph separators, the
// braille blank, the interlinear annotation marks and a lone half of a
// surrogate pair, each replaced by a space; then cut at `max` code points,
// never inside a surrogate pair. The only escapes the picker prints are its
// own colours (C above).
const SPOOFABLE = /[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800\ufff9-\ufffb\ud800-\udfff]/gu
function displayText(raw, max = 500) {
  const clean = (raw === undefined || raw === null ? '' : String(raw)).replace(SPOOFABLE, ' ')
  const points = Array.from(clean)
  return points.length <= max ? clean : points.slice(0, max).join('')
}
// A name on its way to a refusal message, read at the moment something has
// gone wrong: the same rule.
function displayPath(raw, max = 500) {
  return displayText(raw, max)
}

/** Cut to `maxLen` code points, the last one an ellipsis when it was cut. */
function truncate(str, maxLen) {
  const points = Array.from(str)
  if (points.length <= maxLen) return str
  return points.slice(0, Math.max(0, maxLen - 1)).join('') + '…'
}

// ── Layout width ────────────────────────────────────────────────────
// Render to the REAL interface width — the old hard clamp (78, then 120)
// truncated content on wide terminals even though the window could show more
// (#130). We only ever *display* what fits the window; the full message text is
// read regardless and truncated to this width per line. Floor 60 keeps a narrow
// terminal usable; a high sanity bound (400) guards a pathological columns value
// without imposing an artificial narrow cap. Injectable for testing.
function computeLayoutWidth(columns) {
  const cols = Number(columns) || 80
  return Math.max(60, Math.min(cols - 4, 400))
}

// ── CCC work names ──────────────────────────────────────────────────
// Read the CCC session-state.json (its dir is passed via CCC_CONFIG_DIR by
// pty-manager) and map each session's resume conversation UUID -> its
// user-assigned work name (customName, from the rename feature). Lets the picker
// show the recognizable work name next to the matching conversation instead of
// only the first user message (#130). The transcript's basename UUID equals the
// session's resumeUuid (both are what `claude --resume <uuid>` takes).
// FAIL-SAFE: missing env / file / field / parse error -> empty map. Never throws.
function loadWorkNames(configDir) {
  const map = new Map()
  try {
    if (!configDir) return map
    const raw = fs.readFileSync(path.join(configDir, 'session-state.json'), 'utf-8')
    const data = JSON.parse(raw)
    const sessions = Array.isArray(data && data.sessions) ? data.sessions : []
    for (const s of sessions) {
      const name = s && typeof s.customName === 'string' ? s.customName.trim() : ''
      const uuid = s && typeof s.resumeUuid === 'string' ? s.resumeUuid : ''
      if (name && uuid) map.set(uuid, name)
    }
  } catch { /* fail-safe */ }
  return map
}

// ── CCC name sidecar (#536) ─────────────────────────────────────────
// A CCC-owned `<uuid>.ccc-name.json` sibling of the transcript carries the
// user's session name durably — written by main on rename / exact-bind. Prefer
// it over loadWorkNames(): the sidecar sits next to the exact transcript, so it
// survives the session-state.json last-writer-wins uuid->name collision and any
// worktree / cross-account move of the projects tree. FAIL-SAFE → null.
function readSidecarName(transcriptFilePath) {
  try {
    if (typeof transcriptFilePath !== 'string' || !transcriptFilePath.endsWith('.jsonl')) return null
    const p = transcriptFilePath.slice(0, -'.jsonl'.length) + '.ccc-name.json'
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim() : ''
    return name || null
  } catch { return null }
}

// ── The picker's lines ──────────────────────────────────────────────
// The ONE place the lines the picker prints are built, from the folder it was
// started in, the conversations, their work names and the layout width
// (computeLayoutWidth). `names` answers a conversation's work name: a
// function of the conversation, or a Map keyed by session id. `opts.now`
// fixes the clock and `opts.hasWorktrees` adds the worktree note. Pure: main()
// prints the lines as they come back. Every field shown here goes through
// displayText first and is then cut to fit (see "Display text").
function pickerLines(cwd, conversations, names, width, opts) {
  const o = opts || {}
  const nameOf = typeof names === 'function'
    ? names
    : (conv) => (names && typeof names.get === 'function' ? names.get(conv.sessionId) : undefined)
  const list = Array.isArray(conversations) ? conversations : []
  const maxWidth = width
  const innerWidth = maxWidth - 6
  const dirDisplay = truncate(displayText(cwd), innerWidth)
  const lines = []

  lines.push('')
  lines.push(`  ${C.surface}╭─${C.blue} Resume Conversation ${C.surface}─ ${C.subtext}${dirDisplay} ${C.surface}${'─'.repeat(Math.max(0, maxWidth - 26 - Array.from(dirDisplay).length))}╮${C.reset}`)
  if (o.hasWorktrees) {
    const note = truncate('includes git worktrees — ⑂ tags the worktree', innerWidth)
    lines.push(`  ${C.surface}│${C.reset}  ${C.dim}${C.overlay}${note}${C.reset}`)
  }
  lines.push(`  ${C.surface}│${C.reset}`)

  // A field counts as text to show only when something in it is left to see
  // once it is cleaned (displayText); otherwise the next field is tried.
  const visible = (x) => (x !== undefined && x !== null && displayText(x).trim() !== '' ? x : null)

  for (let i = 0; i < list.length; i++) {
    const conv = list[i]
    const num = String(i + 1).padStart(2)
    const workName = visible(nameOf(conv))
    const lastMessages = Array.isArray(conv.lastMessages) ? conv.lastMessages : []
    // Best available label, most→least useful: the user's own work name, then
    // Claude's AI title, then the first real user message, then the last prompt,
    // then the most recent user message. "(continued session)" only when the
    // conversation truly yielded no readable text (#130).
    const recent = lastMessages.length ? lastMessages[lastMessages.length - 1] : null
    const primary = workName || visible(conv.aiTitle) || visible(conv.firstMessage) || visible(conv.lastPrompt) || visible(recent) || '(continued session)'
    const shownPrimary = truncate(displayText(primary), innerWidth - 6)
    const primaryColored = workName
      ? `${C.bold}${C.peach}${shownPrimary}${C.reset}`
      : `${C.text}${shownPrimary}${C.reset}`
    const meta = [
      timeAgo(conv.mtime, o.now),
      formatSize(conv.size),
      conv.model ? displayText(conv.model, 64) : null,
      conv.sessionId ? displayText(conv.sessionId, 64) : null,
    ].filter(Boolean).join(' · ')

    // Title line. A non-main worktree conversation gets a distinct themed tag
    // (⑂ = branch/fork glyph) appended so the worktree is CALLED OUT.
    let titleLine = `  ${C.surface}│${C.reset}  ${C.green}${num}${C.reset}  ${primaryColored}`
    if (conv.worktreeLabel) {
      titleLine += `  ${C.mauve}⑂ ${truncate(displayText(conv.worktreeLabel, 64), 24)}${C.reset}`
    }
    lines.push(titleLine)
    // Meta line
    lines.push(`  ${C.surface}│${C.reset}      ${C.overlay}${meta}${C.reset}`)
    // When we led with the work name, show the AI title / first message beneath
    // so the row still says what the conversation was about.
    const sub = workName ? (visible(conv.aiTitle) || visible(conv.firstMessage) || visible(conv.lastPrompt)) : null
    if (sub) {
      lines.push(`  ${C.surface}│${C.reset}      ${C.dim}${C.subtext}${truncate(displayText(sub), innerWidth - 10)}${C.reset}`)
    }

    // Last 5 user messages (dim, indented)
    for (const msg of lastMessages) {
      const line = truncate(displayText(msg), innerWidth - 10)
      lines.push(`  ${C.surface}│${C.reset}      ${C.dim}${C.subtext}> ${line}${C.reset}`)
    }

    if (i < list.length - 1) {
      lines.push(`  ${C.surface}│${C.reset}      ${C.surface}${'─'.repeat(Math.max(0, innerWidth - 6))}${C.reset}`)
    }
  }

  lines.push(`  ${C.surface}│${C.reset}`)
  lines.push(`  ${C.surface}│${C.reset}  ${C.yellow} n${C.reset}  ${C.text}New conversation${C.reset}`)
  lines.push(`  ${C.surface}│${C.reset}`)
  lines.push(`  ${C.surface}╰${'─'.repeat(Math.max(0, maxWidth - 4))}╯${C.reset}`)
  lines.push('')
  return lines
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const cwd = process.cwd()
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')

  // Enumerate worktrees (FAIL-SAFE → single synthetic main record for cwd).
  const worktrees = listWorktrees(cwd)
  const hasWorktrees = worktrees.some(w => !w.isMain)

  // Scan each unique worktree project dir once (dedup by resolved path).
  const seenPaths = new Set()
  const bySource = []
  for (const wt of worktrees) {
    let key
    try { key = path.resolve(wt.path) } catch { key = wt.path }
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    bySource.push(scanWorktreeConversations(wt, claudeDir))
  }

  const conversations = mergeAndLabel(bySource, 20)

  if (conversations.length === 0) {
    launchClaude()
    return
  }

  // ── Display ─────────────────────────────────────────────────────
  // Map resume UUID -> CCC work name so a renamed session is recognizable here;
  // the name sidecar beside the transcript wins (#536).
  const workNames = loadWorkNames(process.env.CCC_CONFIG_DIR)
  const nameOf = (conv) => readSidecarName(conv.filePath) || workNames.get(conv.sessionId)
  const shown = pickerLines(cwd, conversations, nameOf, computeLayoutWidth(process.stdout.columns), { hasWorktrees })
  for (const line of shown) console.log(line)

  // ── Read choice ─────────────────────────────────────────────────
  process.stdout.write(`  ${C.blue}>${C.reset} `)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  })

  rl.on('line', (line) => {
    rl.close()
    const choice = line.trim().toLowerCase()

    if (choice === 'n' || choice === 'new') {
      launchClaude()
      return
    }

    const idx = parseInt(choice, 10)
    if (idx >= 1 && idx <= conversations.length) {
      const conv = conversations[idx - 1]
      // Launch from the chosen conversation's OWN cwd — `claude --resume` is
      // cwd-scoped, so a worktree conversation only resolves from its worktree.
      launchClaude(conv.sessionId, conv.sourceCwd)
      return
    }

    // Invalid input — just launch new
    launchClaude()
  })
}

// Forwarded args come via this script's own argv — pty-manager passes
// things like `--settings <path>` in when the hooks gateway is active.
// They're appended after `--resume <id>` so the resume verb stays first.
/**
 * Build the spawn target for `claude`, WITHOUT handing anything to a shell.
 *
 * `shell: true` on Windows is the trap this replaces. Node joins [file,
 * ...args] with spaces and hands the result to `cmd.exe /d /s /c` UNESCAPED
 * (the documented child_process caveat, CVE-2024-27980 class). Every argument
 * this script forwards is therefore re-parsed by cmd.exe:
 *
 *  - Any `&`, `|`, `<`, `>` or `%` inside a forwarded value becomes cmd.exe
 *    syntax. The `--agents` payload is user-authored template text, so that is
 *    a command-execution path, not a theoretical one.
 *  - Any SPACE inside a path splits it. The default Windows data root is
 *    `%LOCALAPPDATA%\Claude Command Center`, which ALWAYS contains spaces, so
 *    `--settings` was being truncated on every restored Windows session and the
 *    tail was landing as a positional arg (an accidental initial prompt).
 *
 * `shell: false` fixes both: Node passes argv to CreateProcess directly and
 * quotes each element itself. The only thing shell:true was buying is the
 * ability to invoke a `.cmd` or `.bat` shim, so that runs through cmd.exe
 * explicitly, the one route for both.
 *
 * cmd.exe reads what follows `/c` itself: without /s it keeps the quotes only
 * when the line holds exactly two of them around a program name, with none of
 * `& < > ( ) @ ^ |` between them, and otherwise drops the first quote and the
 * last one. A shim in a folder with a space or parentheses (npm's folder under
 * a Windows user name with a space) therefore lost its quotes as soon as one
 * argument needed quotes too (a `--settings` path with a space, the `--agents`
 * JSON), and the launch did not start. So the shim
 * runs the way Node runs a `shell: true` command, and the way the Claude
 * version probe and the Codex picker run one: `/d /v:off /s /c "<line>"`,
 * passed VERBATIM (AutoRun skipped, delayed expansion off). With /s cmd.exe
 * drops exactly that outer pair; inside it the shim path is quoted and each
 * argument is written so it stays one argument, exactly as written
 * (quoteArgForCmdShim): wrapped in double quotes, every double quote inside
 * it doubled, and the backslashes before a double quote doubled as the C
 * runtime reads them. cmd.exe's quote state turns at every double quote, so
 * every other character of every argument stays inside quotes, where
 * `& | < > ^ ( )` are text -- on the /c line and again on the shim's own `%*`
 * line -- and the program's argument parser (the C runtime rule, which node
 * and the native binary follow) reads a doubled quote inside quotes as one
 * quote. cmd.exe reads `%` inside quotes as well, and a /c line has no way
 * to keep it as text, so an argument holding `%` or a control character is
 * refused (null) and the launch says which one (notStartedMessage). `!` is
 * text: the line runs with delayed expansion off, and npm's shims do not
 * turn it on. A shim path carrying one of `" % & ^` or a control character
 * is refused (null), as the version probe refuses it: cmd.exe or the shim
 * itself would re-read it.
 *
 * `cwd`: the folder the shim starts in. cmd.exe cannot start in a share or a
 * device path (two leading slashes of either kind), so the shim is never
 * started there (null), and the launch says why and names the two ways out
 * (notStartedMessage), as the app's own launch does. The native claude.exe
 * starts in any folder.
 *
 * P3.10 round 3b: the picker resolves its helpers from fixed locations: the
 * cmd.exe that runs a shim is the system's own, by its full path
 * (systemCmdExe).
 */
// eslint-disable-next-line no-control-regex
const SHIM_PATH_UNSAFE_RE = /["%&^\x00-\x1f\x7f]/
/** A variable's one value in `env`, matched as Windows matches names (either
 *  case, ASCII names only): undefined when unset, null when two spellings
 *  disagree. */
function envOne(env, name) {
  const values = new Set()
  for (const k of Object.keys(env || {})) {
    const v = env[k]
    if (typeof v === 'string' && v !== '' && /^[A-Za-z]+$/.test(k) && k.toUpperCase() === name.toUpperCase()) values.add(v)
  }
  if (values.size > 1) return null
  return values.size === 1 ? [...values][0] : undefined
}
/** A folder name that cmd.exe or the file system would read as more than a name. */
const ROOT_PART_UNSAFE_RE = /[<>|*?:]/
/**
 * P3.10 round 3b: the cmd.exe that runs a shim, by its full path:
 * `<SystemRoot>\System32\cmd.exe`, written as ComSpec spells it only when
 * ComSpec names exactly that file (in any case). SystemRoot is read from `env`
 * and is C:\Windows only when it is not set; one that is not a plain absolute
 * folder (a drive, then names, none of them `.` or `..`), or two spellings that
 * disagree, give null (no start).
 */
function systemCmdExe(env) {
  const root = envOne(env, 'SystemRoot')
  if (root === null) return null
  const base = (root === undefined ? 'C:\\Windows' : root).replace(/\\+$/, '')
  const parts = base.split(/[\\/]/)
  if (!/^[A-Za-z]:$/.test(parts[0]) || SHIM_PATH_UNSAFE_RE.test(base)) return null
  if (parts.slice(1).some((p) => p === '' || p === '.' || p === '..' || ROOT_PART_UNSAFE_RE.test(p))) return null
  const system = `${base}\\System32\\cmd.exe`
  const comSpec = envOne(env, 'ComSpec')
  return typeof comSpec === 'string' && comSpec.toLowerCase() === system.toLowerCase() ? comSpec : system
}
/** One argument on the shim's line: in double quotes, each double quote in
 *  it doubled, the backslashes before a double quote (or before the closing
 *  one) doubled. cmd.exe and the C runtime then both read it as one argument,
 *  exactly as written. */
function quoteArgForCmdShim(arg) {
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue }
    if (ch === '"') { out += '\\'.repeat(slashes * 2) + '""'; slashes = 0; continue }
    out += '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}
/** What no quoting keeps as text on a /c line: `%`, and any control character. */
const SHIM_ARG_REFUSED_RE = /[%\p{Cc}]/u
/** The index of the first argument the shim route refuses, or -1. */
function shimArgRefused(args) {
  return args.findIndex((a) => typeof a !== 'string' || SHIM_ARG_REFUSED_RE.test(a))
}
/** The name of the first agent template in an `--agents` value that holds
 *  what the shim route refuses -- a list of templates each with a `name` (as
 *  the app writes it), or an object keyed by name -- or null when the value
 *  names none. A name counts only when something in it is left to see once
 *  it is shown (displayText), as for the picker's rows. */
function refusedTemplateName(value) {
  let parsed
  try { parsed = JSON.parse(value) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const entries = Array.isArray(parsed)
    ? parsed.map((t) => [t && typeof t === 'object' ? t.name : undefined, t])
    : Object.entries(parsed)
  for (const [name, template] of entries) {
    if (typeof name === 'string' && displayText(name).trim() !== '' && SHIM_ARG_REFUSED_RE.test(JSON.stringify([name, template]))) return name
  }
  return null
}
/** A folder cmd.exe cannot start in: a share or a device path. */
const CMD_EXE_NETWORK_FOLDER_RE = /^[\\/]{2}/
const NETWORK_FOLDER_REFUSAL = 'Cannot start Claude Code in a network folder through its npm launcher: open the folder from a mapped drive letter, or install the native Claude Code.'
const isShim = (cmd) => /\.(cmd|bat)$/i.test(cmd)
const inNetworkFolder = (cwd) => typeof cwd === 'string' && CMD_EXE_NETWORK_FOLDER_RE.test(cwd)
function buildSpawnTarget(cmd, args, platform = os.platform(), env = process.env, cwd) {
  if (platform === 'win32' && isShim(cmd)) {
    if (inNetworkFolder(cwd)) return null
    if (SHIM_PATH_UNSAFE_RE.test(cmd)) return null
    const shell = systemCmdExe(env)
    if (!shell) return null
    if (shimArgRefused(args) !== -1) return null
    const line = [`"${cmd}"`, ...args.map(quoteArgForCmdShim)].join(' ')
    // The shim starts node by a bare name when no node.exe sits beside it:
    // it looks in PATH's fully qualified folders only, never in the project
    // folder nor in one named relative to it.
    return { file: shell, argv: ['/d', '/v:off', '/s', '/c', `"${line}"`], verbatim: true, env: withFullyQualifiedProgramLookup(env, platform) }
  }
  return { file: cmd, argv: args, verbatim: false }
}
/** What the launch says when it starts nothing: `cmd` null (Claude Code not
 *  found), or why buildSpawnTarget refused, checked in its order (`cwd`: the
 *  folder it would start in). A name shown in it is plain text. */
function notStartedMessage(cmd, args, env = process.env, cwd) {
  if (!cmd) return `Not starting Claude Code: it was not found in a folder PATH names (${CLAUDE_WINDOWS_NAMES.join(', ')}). Install it, or add its folder to PATH, then start the session again.`
  if (isShim(cmd) && inNetworkFolder(cwd)) return NETWORK_FOLDER_REFUSAL
  if (SHIM_PATH_UNSAFE_RE.test(cmd)) return `Not starting Claude Code from ${displayPath(cmd)}: cmd.exe would re-read a character in that path. Install it in a folder without " % & or ^.`
  const refused = shimArgRefused(args)
  if (systemCmdExe(env) && refused !== -1) {
    const flagOf = (a) => (typeof a === 'string' && a.startsWith('--') ? a.split('=')[0] : null)
    const inline = flagOf(args[refused])
    const flag = inline || flagOf(args[refused - 1])
    if (flag === '--agents') {
      const value = inline ? args[refused].slice(inline.length + 1) : args[refused]
      const name = typeof value === 'string' ? refusedTemplateName(value) : null
      const which = name ? `the agent template "${displayText(name, 64)}"` : 'an agent template'
      return `Not starting Claude Code: ${which} holds a % sign or a control character, which Claude Code started through its claude.cmd or claude.bat launcher cannot be given exactly as written. Remove it from the template, or install the native Claude Code.`
    }
    const what = flag ? `the value of ${displayText(flag, 64)}` : 'an argument'
    return `Not starting Claude Code: ${what} holds a % sign or a control character, which Claude Code started through its claude.cmd or claude.bat launcher cannot be given exactly as written. Remove it, or install the native Claude Code.`
  }
  return 'Not starting Claude Code: the Windows folder (SystemRoot) is not a plain absolute folder, so the system cmd.exe cannot be named.'
}

function getForwardedArgs() {
  // node resume-picker.js [ --settings <path> ] [ other flags ... ]
  return process.argv.slice(2)
}

// Resolve the claude command. On Windows: the first of CLAUDE_WINDOWS_NAMES in
// the folders PATH names -- the native claude.exe in any of them, then
// claude.cmd, then claude.bat, as the app's own lookup asks -- found in-process
// (findOnPath), never through the where command or a shell, never in the
// project folder, never the bare name; null when none is there, and the launch
// says so. A claude.cmd and a claude.bat both start through the system cmd.exe
// on the same line (buildSpawnTarget). Elsewhere the bare name, as before.
function resolveClaudeCmd(platform = os.platform(), env = process.env, isFile = isFileOnDisk) {
  if (platform !== 'win32') return 'claude'
  return findOnPath(CLAUDE_WINDOWS_NAMES, env, platform, isFile)
}

/** What one launch starts -- the program, its arguments and its spawn options
 *  (`base`, plus the npm route's environment and verbatim line) -- or, when
 *  it starts nothing, the message it shows (notStartedMessage). `inherited`:
 *  the folder it starts in when `base` names none (the picker's own). Pure:
 *  both of launchClaude's launches run exactly what this returns. */
function launchSpec(cmd, args, base, platform = os.platform(), env = process.env, inherited) {
  const folder = base && typeof base.cwd === 'string' && base.cwd !== '' ? base.cwd : inherited
  const target = cmd ? buildSpawnTarget(cmd, args, platform, env, folder) : null
  if (!target) return { message: notStartedMessage(cmd, args, env, folder) }
  const opts = { ...base, windowsVerbatimArguments: target.verbatim }
  if (target.env) opts.env = target.env
  return { file: target.file, argv: target.argv, opts }
}

// Launch Claude. When `sourceCwd` is provided and differs from the current cwd
// (a worktree conversation), spawn from that directory so the cwd-scoped
// `--resume` resolves it. New/fresh launches always use process.cwd().
// `deps` (spawn, exit, argv, env, platform, isFile, cwd) are for tests; the
// picker itself passes none.
function launchClaude(resumeId, sourceCwd, deps) {
  const d = deps || {}
  const spawn = d.spawn || spawnSync
  const exit = d.exit || ((code) => process.exit(code))
  const env = d.env || process.env
  const platform = d.platform || os.platform()
  const forwarded = d.argv || getForwardedArgs()
  const args = resumeId ? ['--resume', resumeId, ...forwarded] : [...forwarded]
  const cmd = resolveClaudeCmd(platform, env, d.isFile || isFileOnDisk)
  // The folder the picker runs in: a launch that names no other starts there.
  const here = d.cwd || process.cwd()

  // The retarget decision comes FIRST, before anything touches the disk for
  // the chosen directory: a refusal used to be reached only after the
  // companion directory below had been created under the unscanned
  // worktree's project key, a durable side effect keyed on a directory the
  // gate never checked (adversarial confirmation pass, MINOR).
  // Only override cwd for an actual resume into a different directory. Be
  // FAIL-SAFE: an unresolvable/missing sourceCwd silently falls back to inherit.
  const retarget = resolveRetargetCwd(resumeId, sourceCwd, here, env, fs.existsSync)
  if (retarget.refused) {
    // Refused, visibly, and NOT started in the configured directory instead:
    // a `--resume` there would fall through to a fresh session in silence.
    // The directory is untrusted text on its way to the terminal: stripped.
    console.error(`\n  Not resuming in ${displayPath(retarget.refused)}: AI Code Conductor did not check that folder's project settings for this account before the session started. Start the session again and pick it then.\n`)
    return exit(1)
  }

  const spawnOpts = {
    stdio: 'inherit',
    // NEVER shell:true here -- see buildSpawnTarget.
    shell: false,
    windowsHide: false,
  }
  if (retarget.cwd) spawnOpts.cwd = retarget.cwd

  // Whether the launch can start at all is settled before anything is
  // written for it: a launch that starts nothing leaves nothing behind.
  const first = launchSpec(cmd, args, spawnOpts, platform, env, here)
  if (first.message) {
    console.error(`\n  ${first.message}\n`)
    return exit(1)
  }

  // Ensure the chosen conversation's companion dir exists so a direct-work
  // conversation (no subagent/workflow → no companion dir from the CLI) can be
  // resumed. Best-effort: any failure must NOT block the launch.
  if (resumeId) {
    try {
      const projectDir = resolveProjectDir(
        path.join(os.homedir(), '.claude', 'projects'),
        sourceCwd || here,
      )
      if (projectDir) ensureCompanionDir(projectDir, resumeId)
    } catch { /* best-effort */ }
  }

  const result = spawn(first.file, first.argv, first.opts)

  // If resume failed (conversation no longer exists), fall back to fresh session.
  // The fresh fallback runs in the SAME (worktree) cwd so it lands where the
  // user expected, not back in the configured project root.
  if (resumeId && result.status !== 0) {
    console.log('\n  Conversation no longer available - starting fresh session...\n')
    // Its arguments are a part of the first launch's, so it is refused only if
    // that one was; checked all the same.
    const fresh = launchSpec(cmd, forwarded, spawnOpts, platform, env, here)
    if (fresh.message) {
      console.error(`\n  ${fresh.message}\n`)
      return exit(1)
    }
    const again = spawn(fresh.file, fresh.argv, fresh.opts)
    return exit(again.status || 0)
  }

  return exit(result.status || 0)
}

// The gated directory set a MANAGED launch hands the picker (see pty-manager's
// pickerCandidateDirs). Absent or unparseable means "not a managed launch":
// nothing to enforce. A directory is compared resolved, and case-folded on
// Windows, where git and the app may spell one directory in two cases.
function gatedDirsFromEnv(env) {
  const raw = env && env.CCC_GATED_DIRS
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d === 'string' && d !== '') : null
  } catch {
    return null
  }
}

function isGatedDir(dir, gated) {
  const norm = (p) => {
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  const target = norm(dir)
  return gated.some((d) => norm(d) === target)
}

// Where a resume relaunches the CLI: `{ cwd }` to retarget into the
// conversation's worktree, `{ cwd: null }` to inherit the current directory
// (no resume, same directory, or a directory that is gone -- fail-safe, as
// before), or `{ refused }` when this is a MANAGED launch (an AI Code
// Conductor account, which arrives with the directories its project-settings
// gate checked in CCC_GATED_DIRS) and the worktree is not one of them: the CLI
// must not be relaunched anywhere the gate did not scan, because a worktree's
// own settings files can redirect the account. The set covers every worktree
// git listed when the session started, so this refuses only a worktree that
// appeared since. Pure, so the decision has a test; the caller exits on
// `refused` and says why.
function resolveRetargetCwd(resumeId, sourceCwd, currentCwd, env, existsSync) {
  if (!resumeId || !sourceCwd) return { cwd: null }
  try {
    if (sourceCwd === currentCwd || !existsSync(sourceCwd)) return { cwd: null }
  } catch {
    return { cwd: null }
  }
  const gated = gatedDirsFromEnv(env)
  if (gated && !isGatedDir(sourceCwd, gated)) return { cwd: null, refused: sourceCwd }
  return { cwd: sourceCwd }
}

// Pure-logic exports for unit testing. Guarded so `require()` from the test (or
// a sanity `node -e "require('./scripts/resume-picker.js')"`) does NOT run main.
module.exports = {
  gatedDirsFromEnv,
  isGatedDir,
  resolveRetargetCwd,
  displayPath,
  displayText,
  buildSpawnTarget,
  notStartedMessage,
  launchSpec,
  launchClaude,
  resolveClaudeCmd,
  CLAUDE_WINDOWS_NAMES,
  withFullyQualifiedProgramLookup,
  encodeProjectPath,
  resolveProjectDir,
  ensureCompanionDir,
  parseWorktrees,
  listWorktrees,
  worktreeLabelFor,
  scanWorktreeConversations,
  mergeAndLabel,
  parseConversation,
  computeLayoutWidth,
  pickerLines,
  colours: C,
  loadWorkNames,
  readSidecarName,
  sanitizeMessageText,
}

if (require.main === module) {
  main().catch(() => {
    launchClaude()
  })
}
