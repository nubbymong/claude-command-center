#!/usr/bin/env node
// Claude Command Center -- Codex Resume Picker
// Mirrors scripts/resume-picker.js for Codex sessions.
// Walks ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, filters to current cwd,
// shows numbered list, execs `codex resume <uuid>` on pick or fresh `codex` on N.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync, execSync } = require('child_process')
const readline = require('readline')

const lib = require('./lib/codex-resume-picker-lib.js')

// -- Codex home -----------------------------------------------------
function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

// -- Time formatting ------------------------------------------------
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

// -- ANSI helpers (Catppuccin Mocha) --------------------------------
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

// -- Forwarded args -------------------------------------------------
// node codex-resume-picker.js [-m gpt-5.5] [-c key=val] [--sandbox X] [--ask-for-approval Y] ...
function getForwardedArgs() {
  return process.argv.slice(2)
}

// -- Codex binary discovery -----------------------------------------
function resolveCodexCmd() {
  if (os.platform() !== 'win32') return 'codex'
  for (const bin of ['codex.exe', 'codex.cmd']) {
    try {
      return execSync(`where ${bin}`, { encoding: 'utf-8', timeout: 5000 })
        .trim().split('\n')[0].trim()
    } catch { /* try next */ }
  }
  return 'codex'
}

// -- Main -----------------------------------------------------------
async function main() {
  const cwd = process.cwd()
  const home = getCodexHome()
  const conversations = lib.walkRollouts(home, 30, cwd)

  if (conversations.length === 0) {
    launchCodex(null)
    return
  }

  // -- Display ------------------------------------------------------
  const maxWidth = Math.min(process.stdout.columns || 80, 78)
  const innerWidth = maxWidth - 6
  const dirDisplay = truncate(cwd, innerWidth)

  console.log('')
  console.log(`  ${C.surface}╭─${C.peach} Resume Codex Conversation ${C.surface}─ ${C.subtext}${dirDisplay} ${C.surface}${'─'.repeat(Math.max(0, maxWidth - 32 - dirDisplay.length))}╮${C.reset}`)
  console.log(`  ${C.surface}│${C.reset}`)

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]
    const num = String(i + 1).padStart(2)
    const title = truncate(conv.label.replace(/[\r\n]+/g, ' '), innerWidth - 6)
    const metaParts = [
      conv.model || null,
      conv.effort || null,
      timeAgo(conv.mtime),
    ].filter(Boolean)
    const meta = metaParts.join(' · ')

    console.log(`  ${C.surface}│${C.reset}  ${C.green}${num}${C.reset}  ${C.text}${title}${C.reset}`)
    console.log(`  ${C.surface}│${C.reset}      ${C.overlay}${meta}${C.reset}`)
    if (i < conversations.length - 1) {
      console.log(`  ${C.surface}│${C.reset}      ${C.surface}${'─'.repeat(Math.max(0, innerWidth - 6))}${C.reset}`)
    }
  }

  console.log(`  ${C.surface}│${C.reset}`)
  console.log(`  ${C.surface}│${C.reset}  ${C.yellow} n${C.reset}  ${C.text}New conversation${C.reset}`)
  console.log(`  ${C.surface}│${C.reset}`)
  console.log(`  ${C.surface}╰${'─'.repeat(maxWidth - 4)}╯${C.reset}`)
  console.log('')
  process.stdout.write(`  ${C.blue}>${C.reset} `)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  rl.on('line', (line) => {
    rl.close()
    const choice = line.trim().toLowerCase()
    if (choice === '' || choice === 'n' || choice === 'new') {
      launchCodex(null)
      return
    }
    const idx = parseInt(choice, 10)
    if (idx >= 1 && idx <= conversations.length) {
      launchCodex(conversations[idx - 1].id)
      return
    }
    launchCodex(null)
  })
}

// -- launchCodex ----------------------------------------------------
function launchCodex(resumeUuid) {
  const forwarded = getForwardedArgs()
  const args = lib.buildResumeArgs(resumeUuid, forwarded)
  const cmd = resolveCodexCmd()
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: lib.shouldUseShell(cmd, os.platform()),
    windowsHide: false,
  })

  // spawnSync failed to launch (ENOENT, EACCES, etc.). status is null when
  // this happens; result.error carries the cause. Surface and exit non-zero
  // -- a fallback retry would just hit the same missing binary.
  if (result.error) {
    console.error(`\n  Failed to launch codex: ${result.error.message}\n`)
    process.exit(1)
  }

  // If resume exited non-zero with a real status, fall back to fresh codex.
  if (lib.shouldFallback(resumeUuid, result.status)) {
    console.log('\n  Conversation no longer available -- starting fresh session...\n')
    const fresh = spawnSync(cmd, forwarded, {
      stdio: 'inherit',
      shell: lib.shouldUseShell(cmd, os.platform()),
      windowsHide: false,
    })
    if (fresh.error) {
      console.error(`\n  Failed to launch codex: ${fresh.error.message}\n`)
      process.exit(1)
    }
    // Use ?? not || so a real exit 0 is preserved; null (signal-killed) -> 1.
    process.exit(fresh.status ?? 1)
  }

  process.exit(result.status ?? 1)
}

main().catch(() => {
  launchCodex(null)
})
