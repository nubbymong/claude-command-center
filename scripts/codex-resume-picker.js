#!/usr/bin/env node
// Claude Command Center -- Codex Resume Picker
// Mirrors scripts/resume-picker.js for Codex sessions.
// Walks <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, lists the
// conversations of every git worktree of the project (P3.5: the non-main ones
// tagged, each named by its session's name where the app has one), shows a
// numbered list, execs `codex resume <uuid>` on pick -- in the conversation's
// own worktree -- or fresh `codex` on N. Every string it shows comes from
// lib.buildPickerRows, as plain text. The pick is recorded in the file the app
// named (CCC_CODEX_PICK_FILE) so the session follows that conversation.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const readline = require('readline')

const lib = require('./lib/codex-resume-picker-lib.js')

// -- Codex home -----------------------------------------------------
function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
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

// The worktree tag, as Claude's picker draws it (the branch glyph).
const FORK = String.fromCodePoint(0x2442)

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

// -- Forwarded args -------------------------------------------------
// node codex-resume-picker.js [-m gpt-5.5] [-c key=val] [--sandbox X] [--ask-for-approval Y] ...
function getForwardedArgs() {
  return process.argv.slice(2)
}

// -- Codex executable -----------------------------------------------
// WP2: the executable the app's setup proved for this session, passed in
// CCC_CODEX_EXECUTABLE. Never re-resolved here: a second lookup could find
// a different codex. Null when the app gave none (the picker then stops).
function resolveCodexCmd() {
  const proven = process.env.CCC_CODEX_EXECUTABLE
  return proven && path.isAbsolute(proven) ? proven : null
}

// -- Main -----------------------------------------------------------
async function main() {
  const cwd = process.cwd()
  const home = getCodexHome()
  // Every git worktree of the project, as Claude's picker lists them (P3.5).
  const worktrees = lib.listWorktrees(cwd)
  const hasWorktrees = worktrees.some((w) => !w.isMain)
  const conversations = lib.walkRollouts(home, 30, worktrees)

  if (conversations.length === 0) {
    launchCodex(null)
    return
  }

  // -- Display ------------------------------------------------------
  const maxWidth = Math.min(process.stdout.columns || 80, 78)
  const innerWidth = maxWidth - 6
  const dirDisplay = truncate(lib.displayText(cwd), innerWidth)
  // Each session's own name for the conversation it is on, from the app.
  const names = lib.loadWorkNames(process.env.CCC_CONFIG_DIR)
  // The one place every shown string is built, as plain text (lib). A
  // conversation another open tab is on says so (P3.10 round 1).
  const rows = lib.buildPickerRows(conversations, names, innerWidth - 6, undefined, lib.openElsewhereIds(process.env))

  console.log('')
  console.log(`  ${C.surface}╭─${C.peach} Resume Codex Conversation ${C.surface}─ ${C.subtext}${dirDisplay} ${C.surface}${'─'.repeat(Math.max(0, maxWidth - 32 - dirDisplay.length))}╮${C.reset}`)
  if (hasWorktrees) {
    console.log(`  ${C.surface}│${C.reset}  ${C.dim}${C.overlay}${truncate(`includes git worktrees; ${FORK} tags the worktree`, innerWidth)}${C.reset}`)
  }
  console.log(`  ${C.surface}│${C.reset}`)

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const title = row.named ? `${C.bold}${C.peach}${row.title}${C.reset}` : `${C.text}${row.title}${C.reset}`
    const tag = row.tag ? `  ${C.mauve}${FORK} ${row.tag}${C.reset}` : ''
    console.log(`  ${C.surface}│${C.reset}  ${C.green}${row.num}${C.reset}  ${title}${tag}`)
    console.log(`  ${C.surface}│${C.reset}      ${C.overlay}${row.meta}${C.reset}`)
    if (row.sub) {
      console.log(`  ${C.surface}│${C.reset}      ${C.dim}${C.subtext}${row.sub}${C.reset}`)
    }
    if (i < rows.length - 1) {
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
      const conv = conversations[idx - 1]
      const id = lib.isResumeId(conv.id) ? conv.id : null
      launchCodex(id, conv.sourceCwd)
      return
    }
    launchCodex(null)
  })
}

// A decision the app could not be told is said in the terminal (see
// lib.recordPick); the launch goes on either way.
function noteUnrecorded(notice) {
  if (notice) console.error(notice)
}

// -- launchCodex ----------------------------------------------------
// Every start goes through here: a pick, New conversation, nothing to list,
// a failed main(). It first tells the app what this session now runs (the
// pick file, P3.5): the conversation it resumes, or a new one; the app
// claims nothing until it is told. `sourceCwd`: the worktree git reported
// for the chosen conversation. A conversation from another worktree starts
// there, as Claude's picker does, and so does its fresh fallback; a new
// conversation starts here.
function launchCodex(resumeUuid, sourceCwd) {
  const forwarded = getForwardedArgs()
  const cmd = resolveCodexCmd()
  if (!cmd) {
    console.error('\n  Failed to launch codex: the app did not pass the Codex executable for this session.\n')
    process.exit(1)
  }
  noteUnrecorded(lib.recordPick(process.env.CCC_CODEX_PICK_FILE, resumeUuid, process.env.CCC_CODEX_PICK_DIR_ID))
  const retarget = lib.resolveRetargetCwd(resumeUuid, sourceCwd, process.cwd(), lib.isDirectory)
  // Codex itself never gets the pick file's name.
  const env = lib.childEnv(process.env)
  const run = (args) => {
    const target = lib.launchTarget(cmd, args, os.platform(), process.env)
    if (!target) {
      console.error('\n  Failed to launch codex: its path or arguments cannot be passed to cmd.exe safely.\n')
      process.exit(1)
    }
    return spawnSync(target.file, target.args, { stdio: 'inherit', windowsHide: false, windowsVerbatimArguments: target.verbatim, env, ...(retarget.cwd ? { cwd: retarget.cwd } : {}) })
  }
  const result = run(lib.buildResumeArgs(resumeUuid, forwarded))

  // spawnSync failed to launch (ENOENT, EACCES, etc.). status is null when
  // this happens; result.error carries the cause. Surface and exit non-zero
  // -- a fallback retry would just hit the same missing binary.
  if (result.error) {
    console.error(`\n  Failed to launch codex: ${result.error.message}\n`)
    process.exit(1)
  }

  // If resume exited non-zero with a real status, fall back to fresh codex.
  if (lib.shouldFallback(resumeUuid, result.status)) {
    // Said as it is (P3.10 round 1): one another open tab is on (Codex lets
    // one tab at a time write a conversation), or one that was not resumed.
    console.log(`\n  ${lib.fallbackNotice(resumeUuid, lib.openElsewhereIds(process.env))}\n`)
    // The session now runs a new conversation: the app follows that one.
    noteUnrecorded(lib.recordPick(process.env.CCC_CODEX_PICK_FILE, null, process.env.CCC_CODEX_PICK_DIR_ID))
    const fresh = run(forwarded)
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
