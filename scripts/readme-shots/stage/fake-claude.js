// fake-claude.js — a stand-in for the Claude Code CLI, for the screenshot VM ONLY.
//
// The app launches `claude` inside each session's PTY; on the VM this file is
// what `claude.cmd` runs. It draws a Claude-Code-looking transcript from the
// scripted scenario in content.js (chosen by the --resume uuid the app passes),
// then sits on a spinner so the terminal has motion in the animated capture,
// and it keeps the session's CCC status file fresh so the sidebar card, the
// status strip and the multi-account footer show live-looking numbers.
//
// Nothing here talks to any network. Every word it prints is from content.js.

'use strict'

const fs = require('fs')
const path = require('path')
const C = require(path.join(__dirname, 'content.js'))

// ── args the app passes (all optional here) ────────────────────────────────
const argv = process.argv.slice(2)
const argAfter = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }

// Non-interactive probes the app may run (cli:version, /doctor). Answer and exit
// so they never hang on the TUI. A plausible recent CC version keeps any gate happy.
if (argv.includes('--version') || argv.includes('-v')) { process.stdout.write('2.1.198 (Claude Code)\n'); process.exit(0) }
if (argv[0] === 'mcp' || argv.includes('--help') || argv.includes('-h')) { process.stdout.write('Claude Code\n'); process.exit(0) }
// Headless one-shot (`claude -p "…"`): print nothing useful, just exit cleanly.
if (argv.includes('-p') || argv.includes('--print')) { process.stdout.write('{}\n'); process.exit(0) }

const resumeUuid = argAfter('--resume')

const session = C.SESSIONS.find((s) => s.resumeUuid && s.resumeUuid === resumeUuid) || C.SESSIONS.find((s) => s.scenario === 'promo')
const scenario = C.SCENARIOS[session.scenario]
const account = C.ACCOUNTS.find((a) => a.key === session.accountKey)

const HOME = 'C:/Users/User'
const STATUS_DIR = process.env.CCC_FAKE_STATUS_DIR || `${HOME}/AppData/Local/AI Code Conductor/resources/status`
const CCC_SESSION = process.env.CLAUDE_MULTI_SESSION_ID || null

// ── terminal geometry + palette ────────────────────────────────────────────
const cols = Math.max(60, Math.min(process.stdout.columns || 120, 160))
const WRAP = cols - 2
const ESC = '\x1b['
const RESET = `${ESC}0m`, DIM = `${ESC}2m`, BOLD = `${ESC}1m`
const rgb = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`
const bg = (r, g, b) => `${ESC}48;2;${r};${g};${b}m`
const ORANGE = rgb(217, 119, 87)     // Claude's accent
const GREEN = rgb(166, 227, 161)
const RED = rgb(243, 139, 168)
const YELLOW = rgb(249, 226, 175)
const GREY = rgb(127, 132, 156)
const TEXT = rgb(205, 214, 244)
const USER_BG = bg(49, 50, 68)
const ADD_BG = bg(35, 62, 47)
const DEL_BG = bg(74, 40, 52)

const out = (s) => process.stdout.write(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function wrap(text, width, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if ((line + ' ' + word).trim().length > width - indent && line) { lines.push(pad + line); line = word } else line = line ? line + ' ' + word : word
    }
    lines.push(pad + line)
  }
  return lines
}

// ── pieces of the Claude Code look ─────────────────────────────────────────
function header() {
  out(`${ESC}2J${ESC}H`) // clear screen, home
  const w = Math.min(cols - 2, 76)
  const inner = w - 2
  const line = (s) => `${DIM}│${RESET} ${s}${' '.repeat(Math.max(0, inner - 1 - visibleLen(s)))}${DIM}│${RESET}\n`
  const model = session.status ? session.status.model : 'Fable 5'
  out(`${DIM}╭${'─'.repeat(inner)}╮${RESET}\n`)
  out(line(`${ORANGE}✻${RESET} ${BOLD}Welcome back!${RESET}`))
  out(line(''))
  out(line(`  ${TEXT}${model}${RESET} ${DIM}·${RESET} ${TEXT}effort ${session.effort}${RESET} ${DIM}·${RESET} ${TEXT}Claude Max${RESET}`))
  out(line(`  ${DIM}${scenario.cwd}${RESET}`))
  out(line(`  ${DIM}Resuming "${scenario.title}"${RESET}`))
  out(`${DIM}╰${'─'.repeat(inner)}╯${RESET}\n\n`)
}
function visibleLen(s) { return s.replace(/\x1b\[[0-9;]*m/g, '').length }

function userLine(text) {
  const lines = wrap(text, WRAP - 2, 0)
  out('\n')
  lines.forEach((l, i) => {
    const body = (i === 0 ? '> ' : '  ') + l
    out(`${USER_BG}${TEXT}${body}${' '.repeat(Math.max(0, WRAP - body.length))}${RESET}\n`)
  })
  out('\n')
}

async function assistantText(text) {
  const lines = wrap(text, WRAP, 2)
  out(`${TEXT}●${RESET} `)
  let first = true
  for (const l of lines) {
    const words = (first ? l.trimStart() : l).split(' ')
    for (let i = 0; i < words.length; i++) {
      out(`${TEXT}${words[i]}${i < words.length - 1 ? ' ' : ''}${RESET}`)
      await sleep(9)
    }
    out('\n')
    first = false
  }
  out('\n')
}

function toolLabel(name, input) {
  switch (name) {
    case 'Bash': return `Bash(${input.command})`
    case 'Grep': return `Grep(pattern: "${input.pattern}"${input.path ? `, path: "${input.path}"` : ''})`
    case 'Glob': return `Glob(pattern: "${input.pattern}")`
    default: return `${name}(${input.file_path || ''})`
  }
}

async function toolCall(t) {
  out(`${GREEN}●${RESET} ${TEXT}${toolLabel(t.tool, t.input)}${RESET}\n`)
  await sleep(220)
  const res = t.result || []
  res.forEach((r, i) => {
    out(i === 0 ? `  ${DIM}⎿  ${r}${RESET}\n` : `     ${DIM}${r}${RESET}\n`)
  })
  if (t.diff) {
    for (const row of t.diff) {
      if (row[0] === 'gap') { out(`       ${DIM}…${RESET}\n`); continue }
      const [kind, no, text] = row
      const num = String(no).padStart(4)
      if (kind === 'ctx') out(`       ${DIM}${num}${RESET}    ${TEXT}${text}${RESET}\n`)
      if (kind === 'add') out(`       ${DIM}${num}${RESET} ${ADD_BG}${GREEN}+${RESET}${ADD_BG}  ${text}${' '.repeat(Math.max(0, WRAP - 14 - text.length))}${RESET}\n`)
      if (kind === 'del') out(`       ${DIM}${num}${RESET} ${DEL_BG}${RED}-${RESET}${DEL_BG}  ${text}${' '.repeat(Math.max(0, WRAP - 14 - text.length))}${RESET}\n`)
    }
  }
  out('\n')
  await sleep(160)
}

function doneLine(dur) {
  out(`${ORANGE}✻${RESET} ${DIM}Baked for ${dur}${RESET}\n`)
}

// The resting state: spinner + prompt box + hint. Redrawn in place every tick.
const GLYPHS = ['✻', '✢', '✳', '✶', '✽', '✻']
let spinnerDrawn = false
function spinnerBlock(word, tick, seconds, tokens) {
  const g = GLYPHS[tick % GLYPHS.length]
  const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
  const rule = `${DIM}${'─'.repeat(WRAP)}${RESET}`
  const lines = [
    `${ORANGE}${g}${RESET} ${TEXT}${word}…${RESET} ${DIM}(${seconds}s · ↑ ${tok} tokens · esc to interrupt)${RESET}`,
    '',
    rule,
    `${TEXT}>${RESET} `,
    rule,
    `  ${YELLOW}⏵⏵ accept edits on${RESET} ${DIM}(shift+tab to cycle)${RESET}`,
  ]
  if (spinnerDrawn) out(`${ESC}${lines.length}A${ESC}J`)
  out(lines.join('\n') + '\n')
  spinnerDrawn = true
}

// ── status file ────────────────────────────────────────────────────────────
const t0 = Date.now()
function writeStatus() {
  if (!CCC_SESSION || !session.status) return
  try {
    const seconds = Math.round((Date.now() - t0) / 1000)
    const data = C.statusFor(session, Date.now(), HOME, { seconds, ctxPlus: Math.floor(seconds / 45) })
    data.sessionId = CCC_SESSION
    fs.mkdirSync(STATUS_DIR, { recursive: true })
    const file = path.join(STATUS_DIR, `${CCC_SESSION}.json`)
    fs.writeFileSync(file + '.tmp', JSON.stringify(data))
    fs.renameSync(file + '.tmp', file)
  } catch { /* the capture must not die on a status write */ }
}

// ── main ───────────────────────────────────────────────────────────────────
;(async () => {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(true) } catch { /* not a tty */ }
  process.stdin.resume()
  process.stdin.on('data', (d) => { const s = String(d); if (s.includes('\x03') || s === 'q') process.exit(0) })

  writeStatus()
  setInterval(writeStatus, 2000)

  header()
  let spinnerWord = 'Thinking'
  for (const t of scenario.turns) {
    if (t.user) { userLine(t.user); await sleep(300); continue }
    if (t.text) await assistantText(t.text)
    if (t.tool) await toolCall(t)
    if (t.done) { doneLine(t.done); out('\n'); await sleep(200) }
    if (t.spinner) spinnerWord = t.spinner
  }
  let tick = 0
  let tokens = 640
  setInterval(() => {
    tick++
    tokens += 7 + (tick % 5)
    spinnerBlock(spinnerWord, tick, Math.floor(tick * 0.12) + 4, tokens)
  }, 120)
})().catch((e) => { out(`\n${RED}fake-claude: ${e && e.message}${RESET}\n`); setInterval(() => {}, 1 << 30) })
