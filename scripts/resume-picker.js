#!/usr/bin/env node
// Claude Command Center — Resume Picker
// Shows a conversation picker in the terminal before Claude launches.
// For local (non-SSH) sessions that have prior conversations on disk.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const readline = require('readline')

// ── Path encoding ───────────────────────────────────────────────────
// Matches how Claude CLI encodes project paths to directory names.
// C:\Projects\my-app → C--Projects-my-app
function encodeProjectPath(p) {
  const norm = p.replace(/\//g, '\\')
  let encoded = norm.replace(/:\\/, '--')
  encoded = encoded.replace(/\\/g, '-')
  encoded = encoded.replace(/_/g, '-')
  return encoded
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
  return str.slice(0, maxLen - 1) + '\u2026'
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const cwd = process.cwd()
  const encoded = encodeProjectPath(cwd)
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')

  // Find matching project directory (case-insensitive)
  let projectDir = null
  try {
    const dirs = fs.readdirSync(claudeDir)
    for (const d of dirs) {
      if (d.toLowerCase() === encoded.toLowerCase()) {
        projectDir = path.join(claudeDir, d)
        break
      }
    }
  } catch {
    launchClaude()
    return
  }

  if (!projectDir || !fs.existsSync(projectDir)) {
    launchClaude()
    return
  }

  // Scan for .jsonl files that have a companion directory (current Claude CLI format).
  // Older conversations with only a .jsonl file can't be resumed by the current CLI.
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
    launchClaude()
    return
  }

  if (files.length === 0) {
    launchClaude()
    return
  }

  // Parse conversations
  const conversations = files
    .map(parseConversation)
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 15)

  if (conversations.length === 0) {
    launchClaude()
    return
  }

  // ── Display ─────────────────────────────────────────────────────
  const maxWidth = Math.min(process.stdout.columns || 80, 78)
  const innerWidth = maxWidth - 6
  const dirDisplay = truncate(cwd, innerWidth)

  console.log('')
  console.log(`  ${C.surface}\u256D\u2500${C.blue} Resume Conversation ${C.surface}\u2500 ${C.subtext}${dirDisplay} ${C.surface}${'\u2500'.repeat(Math.max(0, maxWidth - 26 - dirDisplay.length))}\u256E${C.reset}`)
  console.log(`  ${C.surface}\u2502${C.reset}`)

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]
    const num = String(i + 1).padStart(2)
    const title = truncate(conv.firstMessage.replace(/[\r\n]+/g, ' '), innerWidth - 6)
    const meta = [
      timeAgo(conv.mtime),
      formatSize(conv.size),
      conv.model || null,
      conv.sessionId || null,
    ].filter(Boolean).join(' \u00B7 ')

    // Title line
    console.log(`  ${C.surface}\u2502${C.reset}  ${C.green}${num}${C.reset}  ${C.text}${title}${C.reset}`)
    // Meta line
    console.log(`  ${C.surface}\u2502${C.reset}      ${C.overlay}${meta}${C.reset}`)

    // Last 5 user messages (dim, indented)
    if (conv.lastMessages.length > 0) {
      for (const msg of conv.lastMessages) {
        const line = truncate(msg, innerWidth - 10)
        console.log(`  ${C.surface}\u2502${C.reset}      ${C.dim}${C.subtext}> ${line}${C.reset}`)
      }
    }

    if (i < conversations.length - 1) {
      console.log(`  ${C.surface}\u2502${C.reset}      ${C.surface}${'─'.repeat(Math.max(0, innerWidth - 6))}${C.reset}`)
    }
  }

  console.log(`  ${C.surface}\u2502${C.reset}`)
  console.log(`  ${C.surface}\u2502${C.reset}  ${C.yellow} n${C.reset}  ${C.text}New conversation${C.reset}`)
  console.log(`  ${C.surface}\u2502${C.reset}`)
  console.log(`  ${C.surface}\u2570${'\u2500'.repeat(maxWidth - 4)}\u256F${C.reset}`)
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
      launchClaude(conv.sessionId)
      return
    }

    // Invalid input — just launch new
    launchClaude()
  })
}

function launchClaude(resumeId) {
  const args = resumeId ? ['--resume', resumeId] : []

  // Resolve claude command — try native .exe first, then npm .cmd
  let cmd = 'claude'
  if (os.platform() === 'win32') {
    const { execSync } = require('child_process')
    for (const bin of ['claude.exe', 'claude.cmd']) {
      try {
        cmd = execSync(`where ${bin}`, { encoding: 'utf-8', timeout: 5000 })
          .trim().split('\n')[0].trim()
        break
      } catch { /* try next */ }
    }
  }

  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: os.platform() === 'win32',
    windowsHide: false
  })

  // If resume failed (conversation no longer exists), fall back to fresh session
  if (resumeId && result.status !== 0) {
    console.log('\n  Conversation no longer available — starting fresh session...\n')
    const fresh = spawnSync(cmd, [], {
      stdio: 'inherit',
      shell: os.platform() === 'win32',
      windowsHide: false
    })
    process.exit(fresh.status || 0)
  }

  process.exit(result.status || 0)
}

main().catch(() => {
  launchClaude()
})
