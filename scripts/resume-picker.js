#!/usr/bin/env node
// Claude Conductor — Resume Picker
// Shows a conversation picker in the terminal before Claude launches.
// For local (non-SSH) sessions that have prior conversations on disk.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const readline = require('readline')

// ── Path encoding ───────────────────────────────────────────────────
// Matches how Claude CLI encodes project paths to directory names.
// F:\scratch_space\rune → F--scratch-space-rune
function encodeProjectPath(p) {
  // Normalise to backslash on Windows
  const norm = p.replace(/\//g, '\\')
  // Drive letter stays, :\ → --
  let encoded = norm.replace(/:\\/, '--')
  // Remaining backslashes → -
  encoded = encoded.replace(/\\/g, '-')
  // Underscores → -
  encoded = encoded.replace(/_/g, '-')
  return encoded
}

// ── Parse first user message from a .jsonl file ─────────────────────
function parseConversation(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(16384)
    const bytesRead = fs.readSync(fd, buf, 0, 16384, 0)
    fs.closeSync(fd)
    const text = buf.toString('utf-8', 0, bytesRead)

    const lines = text.split('\n').filter(Boolean)
    let sessionId = null
    let firstMessage = null
    let messageCount = 0
    let model = null

    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        // Extract session ID from the conversation UUID (filename minus .jsonl)
        if (!sessionId) {
          sessionId = path.basename(filePath, '.jsonl')
        }
        // Count messages
        if (obj.type === 'human' || obj.type === 'assistant') {
          messageCount++
        }
        // First user message
        if (obj.type === 'human' && !firstMessage) {
          if (typeof obj.message === 'string') {
            firstMessage = obj.message
          } else if (obj.message?.content) {
            if (typeof obj.message.content === 'string') {
              firstMessage = obj.message.content
            } else if (Array.isArray(obj.message.content)) {
              const textBlock = obj.message.content.find(b => b.type === 'text')
              if (textBlock) firstMessage = textBlock.text
            }
          }
        }
        // Model
        if (obj.model && !model) {
          model = obj.model
        }
      } catch { /* skip unparseable lines */ }
    }

    if (!sessionId || !firstMessage) return null

    const stat = fs.statSync(filePath)
    return {
      sessionId,
      firstMessage: firstMessage.trim(),
      messageCount,
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
    // No .claude/projects — just launch Claude
    launchClaude()
    return
  }

  if (!projectDir || !fs.existsSync(projectDir)) {
    launchClaude()
    return
  }

  // Scan for .jsonl files
  let files
  try {
    files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
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
    .slice(0, 20) // Max 20 entries

  if (conversations.length === 0) {
    launchClaude()
    return
  }

  // ── Display ─────────────────────────────────────────────────────
  const maxWidth = Math.min(process.stdout.columns || 80, 72)
  const innerWidth = maxWidth - 6 // padding: 3 left + 3 right
  const dirDisplay = truncate(cwd, innerWidth)

  console.log('')
  console.log(`  ${C.surface}\u256D\u2500${C.blue} Resume Conversation ${C.surface}\u2500 ${C.subtext}${dirDisplay} ${C.surface}${'\u2500'.repeat(Math.max(0, maxWidth - 26 - dirDisplay.length))}\u256E${C.reset}`)
  console.log(`  ${C.surface}\u2502${C.reset}${''.padEnd(maxWidth - 4)}${C.surface}\u2502${C.reset}`)

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]
    const num = String(i + 1).padStart(2)
    const msg = truncate(conv.firstMessage.replace(/[\r\n]+/g, ' '), innerWidth - 6)
    const meta = [
      timeAgo(conv.mtime),
      conv.messageCount > 0 ? `${conv.messageCount} msgs` : null,
      formatSize(conv.size),
      conv.model || null,
    ].filter(Boolean).join(' \u00B7 ')

    console.log(`  ${C.surface}\u2502${C.reset}  ${C.green}${num}${C.reset}  ${C.text}"${msg}"${C.reset}`)
    console.log(`  ${C.surface}\u2502${C.reset}      ${C.overlay}${meta}${C.reset}`)
    if (i < conversations.length - 1) {
      console.log(`  ${C.surface}\u2502${C.reset}`)
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

  // Resolve claude command
  let cmd = 'claude'
  if (os.platform() === 'win32') {
    try {
      const { execSync } = require('child_process')
      cmd = execSync('where claude.cmd', { encoding: 'utf-8', timeout: 5000 })
        .trim().split('\n')[0].trim()
    } catch { /* fallback to 'claude' */ }
  }

  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: os.platform() === 'win32',
    windowsHide: false
  })

  process.exit(result.status || 0)
}

main().catch(() => {
  // On any error, fall through to plain Claude
  launchClaude()
})
