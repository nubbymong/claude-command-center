// fake-codex.js — a stand-in for the Codex CLI on the screenshot VM. It only
// has to look like a Codex session from across the room: its tab is never the
// active one in a capture, but the app must find *a* `codex` so the session
// card renders as a normal Codex session instead of an error.

'use strict'

const path = require('path')
const C = require(path.join(__dirname, 'content.js'))

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
out(`${DIM}│${RESET} ${BOLD}OpenAI Codex${RESET} ${DIM}(v0.60.0)${RESET}                                  ${DIM}│${RESET}\n`)
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
