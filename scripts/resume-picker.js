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
//   F:\CLAUDE_MULTI_APP                              → F--CLAUDE-MULTI-APP
//   f:\platform_v9                                   → f--platform-v9
//   F:\platform_v9\.claude-worktrees\warm-toolchain  → F--platform-v9--claude-worktrees-warm-toolchain
//   C:\Users\nicho                                   → C--Users-nicho
//
// The OLD rule (only `:` `\` `_`, leaving `.` etc.) produced the WRONG folder
// name for dotted/worktree paths, which is exactly why worktree conversations
// were invisible. The case-insensitive readdirSync match in main() is kept as a
// belt-and-braces guard on top of this.
function encodeProjectPath(p) {
  return String(p).replace(/[^A-Za-z0-9]/g, '-')
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

// Enumerate the project's worktrees from `cwd`. The configured cwd may itself BE
// a worktree — we include every worktree git reports regardless.
//
// FAIL-SAFE: if git is missing, errors, or cwd isn't a repo, returns a SINGLE
// synthetic main-worktree record for `cwd` so callers degrade to exactly the
// old single-source behaviour (no labels).
function listWorktrees(cwd) {
  const fallback = [{ path: cwd, branch: null, isMain: true }]
  try {
    const res = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })
    if (res.error || res.status !== 0 || !res.stdout) return fallback
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
  // Skip commands, caveats, and tool interrupts
  if (text.startsWith('<command-name>') || text.startsWith('<local-command')
      || text.startsWith('[Request interrupted')) return null
  return text.replace(/[\r\n]+/g, ' ').trim()
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

    for (const line of headLines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' && !firstMessage) {
          firstMessage = extractUserText(obj)
        }
        if (obj.type === 'assistant' && obj.message?.model && !model) {
          model = obj.message.model
        }
        if (firstMessage && model) break
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
        }
      } catch { /* skip */ }
    }

    // Last 5 user messages
    const lastMessages = recentMessages.slice(-5)

    return {
      sessionId,
      firstMessage: (firstMessage || '(continued session)').trim(),
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
// filter .jsonl that have a companion dir (current Claude CLI format) →
// parseConversation. Each returned conversation is tagged with `sourceCwd` (the
// worktree path) and `worktreeLabel` (null for the main worktree). FAIL-SAFE:
// any error → [].
//
// `claudeProjectsDir` and the worktree record are injectable for testing.
function scanWorktreeConversations(worktree, claudeProjectsDir) {
  try {
    const encoded = encodeProjectPath(worktree.path)

    // Find matching project directory (case-insensitive; belt-and-braces on top
    // of the now-correct mangle).
    let projectDir = null
    let dirs
    try {
      dirs = fs.readdirSync(claudeProjectsDir)
    } catch {
      return []
    }
    for (const d of dirs) {
      if (d.toLowerCase() === encoded.toLowerCase()) {
        projectDir = path.join(claudeProjectsDir, d)
        break
      }
    }
    if (!projectDir || !fs.existsSync(projectDir)) return []

    // .jsonl files that have a companion directory (current Claude CLI format).
    let files
    try {
      const entries = fs.readdirSync(projectDir)
      const dirSet = new Set(entries.filter(e => {
        try { return fs.statSync(path.join(projectDir, e)).isDirectory() } catch { return false }
      }))
      files = entries
        .filter(f => f.endsWith('.jsonl') && dirSet.has(f.replace('.jsonl', '')))
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
function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000)
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

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
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
  const maxWidth = Math.min(process.stdout.columns || 80, 78)
  const innerWidth = maxWidth - 6
  const dirDisplay = truncate(cwd, innerWidth)

  console.log('')
  console.log(`  ${C.surface}╭─${C.blue} Resume Conversation ${C.surface}─ ${C.subtext}${dirDisplay} ${C.surface}${'─'.repeat(Math.max(0, maxWidth - 26 - dirDisplay.length))}╮${C.reset}`)
  if (hasWorktrees) {
    const note = truncate('includes git worktrees — ⑂ tags the worktree', innerWidth)
    console.log(`  ${C.surface}│${C.reset}  ${C.dim}${C.overlay}${note}${C.reset}`)
  }
  console.log(`  ${C.surface}│${C.reset}`)

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]
    const num = String(i + 1).padStart(2)
    const title = truncate(conv.firstMessage.replace(/[\r\n]+/g, ' '), innerWidth - 6)
    const meta = [
      timeAgo(conv.mtime),
      formatSize(conv.size),
      conv.model || null,
      conv.sessionId || null,
    ].filter(Boolean).join(' · ')

    // Title line. A non-main worktree conversation gets a distinct themed tag
    // (⑂ = branch/fork glyph) appended so the worktree is CALLED OUT.
    let titleLine = `  ${C.surface}│${C.reset}  ${C.green}${num}${C.reset}  ${C.text}${title}${C.reset}`
    if (conv.worktreeLabel) {
      titleLine += `  ${C.mauve}⑂ ${truncate(conv.worktreeLabel, 24)}${C.reset}`
    }
    console.log(titleLine)
    // Meta line
    console.log(`  ${C.surface}│${C.reset}      ${C.overlay}${meta}${C.reset}`)

    // Last 5 user messages (dim, indented)
    if (conv.lastMessages.length > 0) {
      for (const msg of conv.lastMessages) {
        const line = truncate(msg, innerWidth - 10)
        console.log(`  ${C.surface}│${C.reset}      ${C.dim}${C.subtext}> ${line}${C.reset}`)
      }
    }

    if (i < conversations.length - 1) {
      console.log(`  ${C.surface}│${C.reset}      ${C.surface}${'─'.repeat(Math.max(0, innerWidth - 6))}${C.reset}`)
    }
  }

  console.log(`  ${C.surface}│${C.reset}`)
  console.log(`  ${C.surface}│${C.reset}  ${C.yellow} n${C.reset}  ${C.text}New conversation${C.reset}`)
  console.log(`  ${C.surface}│${C.reset}`)
  console.log(`  ${C.surface}╰${'─'.repeat(maxWidth - 4)}╯${C.reset}`)
  console.log('')

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
function getForwardedArgs() {
  // node resume-picker.js [ --settings <path> ] [ other flags ... ]
  return process.argv.slice(2)
}

// Resolve claude command — try native .exe first, then npm .cmd.
function resolveClaudeCmd() {
  let cmd = 'claude'
  if (os.platform() === 'win32') {
    const { execSync } = require('child_process')
    for (const bin of ['claude.exe', 'claude.cmd']) {
      try {
        // stdio: ignore stderr so Windows `where`'s "INFO: Could not find files
        // for the given pattern(s)." (printed when claude.exe isn't found before
        // claude.cmd) doesn't leak into the session terminal.
        cmd = execSync(`where ${bin}`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
          .trim().split('\n')[0].trim()
        break
      } catch { /* try next */ }
    }
  }
  return cmd
}

// Launch Claude. When `sourceCwd` is provided and differs from the current cwd
// (a worktree conversation), spawn from that directory so the cwd-scoped
// `--resume` resolves it. New/fresh launches always use process.cwd().
function launchClaude(resumeId, sourceCwd) {
  const forwarded = getForwardedArgs()
  const args = resumeId ? ['--resume', resumeId, ...forwarded] : [...forwarded]
  const cmd = resolveClaudeCmd()

  // Only override cwd for an actual resume into a different directory. Be
  // FAIL-SAFE: an unresolvable/missing sourceCwd silently falls back to inherit.
  const spawnOpts = {
    stdio: 'inherit',
    shell: os.platform() === 'win32',
    windowsHide: false,
  }
  if (resumeId && sourceCwd) {
    try {
      if (sourceCwd !== process.cwd() && fs.existsSync(sourceCwd)) {
        spawnOpts.cwd = sourceCwd
      }
    } catch { /* leave cwd inherited */ }
  }

  const result = spawnSync(cmd, args, spawnOpts)

  // If resume failed (conversation no longer exists), fall back to fresh session.
  // The fresh fallback runs in the SAME (worktree) cwd so it lands where the
  // user expected, not back in the configured project root.
  if (resumeId && result.status !== 0) {
    console.log('\n  Conversation no longer available - starting fresh session...\n')
    const freshOpts = {
      stdio: 'inherit',
      shell: os.platform() === 'win32',
      windowsHide: false,
    }
    if (spawnOpts.cwd) freshOpts.cwd = spawnOpts.cwd
    const fresh = spawnSync(cmd, forwarded, freshOpts)
    process.exit(fresh.status || 0)
  }

  process.exit(result.status || 0)
}

// Pure-logic exports for unit testing. Guarded so `require()` from the test (or
// a sanity `node -e "require('./scripts/resume-picker.js')"`) does NOT run main.
module.exports = {
  encodeProjectPath,
  parseWorktrees,
  listWorktrees,
  worktreeLabelFor,
  scanWorktreeConversations,
  mergeAndLabel,
  parseConversation,
}

if (require.main === module) {
  main().catch(() => {
    launchClaude()
  })
}
