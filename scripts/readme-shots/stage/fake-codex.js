// fake-codex.js — a stand-in for the Codex CLI on the screenshot VM. It only
// has to look like a Codex session from across the room: its tab is never the
// active one in a capture, but the app must find *a* `codex` so the session
// card renders as a normal Codex session instead of an error.

'use strict'

const path = require('path')
const C = require(path.join(__dirname, 'content.js'))

// 2.1.1 asks a Codex it found for its version (and launches one only between
// the tested minimum and maximum; src/main/providers/codex/cli-contract.ts),
// an account's sign-in (`login status`, with that account's CODEX_HOME) and
// its usage (the `app-server` helper). Answer those and exit; anything else
// is a session and draws the stand-in TUI below. No network.
const VERSION = '0.155.1'
const NL = '\n'
const args = process.argv.slice(2)
if (args.join(' ') === '--version') { process.stdout.write(`codex-cli ${VERSION}${NL}`); process.exit(0) }
if (args.join(' ') === 'login status') { process.stderr.write(`Logged in using ChatGPT${NL}`); process.exit(0) }
if (args[0] === 'app-server') {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf(NL)) >= 0) {
      let m = null
      try { m = JSON.parse(buf.slice(0, i)) } catch { m = null }
      buf = buf.slice(i + 1)
      if (!m) continue
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: { codexHome: process.env.CODEX_HOME || '', platformFamily: 'windows', platformOs: 'windows', userAgent: `codex_cli_rs/${VERSION} (stand-in)` } }) + NL)
      if (m.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({ id: m.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, planType: 'plus' } } }) + NL)
    }
  })
  process.stdin.on('end', () => process.exit(0))
  setInterval(() => {}, 1000)
  return
}

const ESC = '\x1b['
const RESET = `${ESC}0m`, DIM = `${ESC}2m`, BOLD = `${ESC}1m`
const TEXT = `${ESC}38;2;205;214;244m`
const CYAN = `${ESC}38;2;137;220;235m`
const out = (s) => process.stdout.write(s)

try { if (process.stdin.isTTY) process.stdin.setRawMode(true) } catch { /* not a tty */ }
process.stdin.resume()
process.stdin.on('data', (d) => { const s = String(d); if (s.includes('\x03') || s === 'q') process.exit(0) })

out(`${ESC}2J${ESC}H`)
out(`${DIM}╭──────────────────────────────────────────────────────╮${RESET}\n`)
out(`${DIM}│${RESET} ${BOLD}OpenAI Codex${RESET} ${DIM}(v${VERSION})${RESET}                                ${DIM}│${RESET}\n`)
out(`${DIM}│${RESET}                                                      ${DIM}│${RESET}\n`)
out(`${DIM}│${RESET} ${DIM}model:${RESET}     ${TEXT}${C.CODEX.model}${RESET}                                  ${DIM}│${RESET}\n`)
out(`${DIM}│${RESET} ${DIM}directory:${RESET} ${TEXT}${C.CODEX.cwd}${RESET}                     ${DIM}│${RESET}\n`)
out(`${DIM}╰──────────────────────────────────────────────────────╯${RESET}\n\n`)
out(`${CYAN}›${RESET} ${TEXT}${C.CODEX.lines[0]}${RESET}\n\n`)
for (const l of C.CODEX.lines.slice(1)) out(`${DIM}${l}${RESET}\n`)
out('\n')
const GLYPHS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let tick = 0
setInterval(() => {
  tick++
  out(`\r${CYAN}${GLYPHS[tick % GLYPHS.length]}${RESET} ${DIM}Working (${Math.floor(tick / 8) + 12}s · esc to interrupt)${RESET}   `)
}, 125)
