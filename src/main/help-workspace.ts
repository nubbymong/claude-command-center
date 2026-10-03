import * as fs from 'fs'
import * as path from 'path'
import { appKnowledgeMarkdown } from '../shared/app-knowledge'
import { mkdirSecure, hardenCredentialDir, atomicWriteSecure } from './account-profiles'
import { logWarn } from './debug-logger'

/**
 * "Ask Conductor" workspace. A folder under the resources directory
 * holding a CLAUDE.md preamble, an AGENTS.md preamble + the curated
 * app-knowledge.md; the ask session simply launches with this folder as its
 * working directory, so Claude Code reads the knowledge through its normal
 * CLAUDE.md mechanism and Codex through its AGENTS.md one. No global config
 * writes, and the user can open the files themselves.
 *
 * Checked on every call, and rebuilt from nothing whenever the folder is not
 * exactly the app's own files (WP2 PR 4, P4.3), so the docs always match the
 * running app version and nothing a session wrote here outlives it.
 */
const CLAUDE_MD = `# Ask Conductor

You are the in-app help assistant for AI Code Conductor (formerly Claude Command Center), the desktop app the user is asking from. Read app-knowledge.md in this folder before answering.

You cover TWO subjects, and the user will move between them without announcing it:

1. **The Conductor app itself.** app-knowledge.md is your source. Keep answers short and
   practical, and name the exact Settings tab, button or menu when directing the user
   somewhere. If the docs genuinely do not cover something, say so plainly and point at the
   Feature Guide (the ? in the sidebar rail, which also opens as a tab) or the project's
   GitHub page. Do not guess at behaviour you cannot find.
2. **Claude Code itself** -- the CLI this app runs. Answer these properly from your own
   knowledge: slash commands, hooks, MCP servers, settings.json, permissions, subagents,
   skills, CLAUDE.md, resume/continue, model selection, context and cost. When you are not
   certain, fetch the official documentation at https://docs.claude.com/en/docs/claude-code
   rather than guessing. Always be clear about which of the two you are describing: "that
   is Claude Code" versus "that is this app" is usually the answer the user actually needs.

Rules:
- You are NOT looking at the user's own project. This session runs in a documentation
  workspace, so you cannot see their code, and you must not pretend to. For a question
  about their repository, tell them to ask in that project's own session.
- Never invent a setting, a shortcut or a menu path. A named control that does not exist is
  worse than "I do not know".

## The helper skill (you are the installer)

Beside this file sit two READY-MADE skill files that let the user's OTHER Claude sessions
answer Conductor questions without opening this tab:

- **ask-conductor-skill.md** -- for THIS machine. To install it: create the directory
  \`~/.claude/skills/ask-conductor\` and copy the file into it as \`SKILL.md\`, VERBATIM --
  no edits, no summarising, no regeneration from memory. To update it, copy again the same
  way. To uninstall, delete that directory. Its body points at the app-knowledge.md the app
  regenerates, so an installed copy never goes stale on this machine.
- **ask-conductor-skill-portable.md** -- a SELF-CONTAINED, version-stamped copy for a
  machine this app is not installed on (an SSH host the user works over, say). The pointer
  variant cannot cross machines. Help the user get it there -- build the exact scp/copy
  command for them, or hand them the content to paste into that machine's own Claude
  session -- but NEVER ask for, or handle, a password or credential to do it yourself, and
  remind them a portable copy only refreshes when they re-copy it after an app update.

Consent rules: install, update or remove a skill file ONLY when the user asks for it in
this conversation. You may OFFER it -- once, briefly -- when their question shows they
would benefit (they ask about settings from another session's point of view, or how to
teach their sessions about the app). If a copy fails or the permission prompt is refused,
report exactly what happened and stop; never retry around a refusal.
`

/** Frontmatter + shared description for both generated skill files. The
 *  description is what makes another session invoke the skill at the right
 *  moment, so it names the confusions it exists to answer. Both preambles
 *  offer the same files, CLAUDE.md to a Claude Code session and AGENTS.md to a
 *  Codex one, so the skill speaks for either assistant (WP2 PR 4, P4.3).
 *  Single-quoted (') YAML is deliberate: the text contains no quotes, and a
 *  colon inside plain YAML would truncate the description silently. */
const SKILL_FRONTMATTER = `---
name: ask-conductor
description: 'How the AI Code Conductor desktop app works -- settings files and which one wins, multiple accounts and how they share settings, SSH and remote sessions, the status line, known issues. Invoke for questions about the Conductor app, or when a Claude Code or Codex setting seems not to apply on this machine. Not for questions about the user''s own project code.'
---
`

/** The skill the Ask session installs on THIS machine: a thin pointer at the
 *  app-knowledge.md the app regenerates, so the installed file never goes
 *  stale -- freshness rides the same refresh that keeps the Ask session
 *  current. */
export function askConductorSkillMarkdown(helpDir: string): string {
  return `${SKILL_FRONTMATTER}
# AI Code Conductor helper

This machine runs AI Code Conductor, the desktop app that launches and
orchestrates Claude Code or Codex sessions. The app regenerates its curated
user documentation on every launch at:

    ${path.join(helpDir, 'app-knowledge.md')}

Read that file first, then answer from it. It covers the settings precedence
chain (which file wins and why a change can look ignored), how multiple
accounts share and copy settings, SSH and container sessions, the status line,
and the app's known issues with workarounds.

If the file is missing, the app has moved or been uninstalled: say so plainly
and suggest the app's own Ask Conductor tab (the pill at the foot of its
sidebar) or its Feature Guide. Do not answer app questions from memory in that
case, and never invent a setting, tab or menu path the file does not name.
Questions about the assistant you run on, Claude Code or Codex (its hooks, MCP
servers, slash commands, settings), you may answer from your own knowledge --
say clearly which of the two, the app or the assistant, you are describing.
`
}

/** The self-contained variant for a machine the app is NOT installed on (the
 *  pointer above cannot cross machines). Version-stamped because it only
 *  refreshes when the user re-copies it. */
export function askConductorSkillPortableMarkdown(appVersion: string): string {
  return `${SKILL_FRONTMATTER}
# AI Code Conductor helper (portable copy)

Written for AI Code Conductor v${appVersion}. This copy embeds the app's
documentation inline so it works on a machine the app is not installed on; it
does NOT update itself -- after an app update, copy it across again. Answer app
questions from the embedded documentation only; never invent a setting, tab or
menu path it does not name. Questions about the assistant you run on, Claude
Code or Codex, you may answer from your own knowledge -- say which of the two,
the app or the assistant, you are describing.

---

${appKnowledgeMarkdown()}
`
}

/**
 * The AGENTS.md preamble, Codex's counterpart of CLAUDE.md above (WP2 PR 4,
 * P4.3): Codex reads AGENTS.md from its working folder as a user message once
 * the folder is trusted (PB4). The two subjects, the rules and the installer
 * section are CLAUDE.md's, said for Codex: the CLI it answers about is Codex,
 * and the helper skill goes into the skills folder of the Codex home the
 * session runs under, the folder Codex lists skills from (P3.1 answer 8).
 *
 * Where the knowledge comes from differs by platform. On Windows the user
 * guide is carried INLINE, after the preamble: Codex reads AGENTS.md itself,
 * outside its sandbox, so the session needs no read of the help folder by a
 * sandboxed command (under the non-admin sandbox PowerShell, Codex's default
 * shell, does not even start; the administrator sandbox's reads are untested;
 * PB8). That file is larger than Codex's default limit for project
 * instructions, which is why an Ask launch on Codex passes
 * `project_doc_max_bytes` (askConductorProjectDocMaxBytes). On macOS and Linux
 * it points at app-knowledge.md, as CLAUDE.md does.
 */
function agentsPreamble(inline: boolean): string {
  const source = inline
    ? 'The app\'s user guide follows this preamble, at the end of this file; answer app questions from it.'
    : 'Read app-knowledge.md in this folder before answering.'
  const where = inline ? 'The user guide at the end of this file is your source.' : 'app-knowledge.md is your source.'
  return `# Ask Conductor

You are the in-app help assistant for AI Code Conductor (formerly Claude Command Center), the desktop app the user is asking from. ${source}

You cover TWO subjects, and the user will move between them without announcing it:

1. **The Conductor app itself.** ${where} Keep answers short and
   practical, and name the exact Settings tab, button or menu when directing the user
   somewhere. If the docs genuinely do not cover something, say so plainly and point at the
   Feature Guide (the ? in the sidebar rail, which also opens as a tab) or the project's
   GitHub page. Do not guess at behaviour you cannot find.
2. **Codex itself** -- the CLI this session runs on. Answer these properly from your own
   knowledge: slash commands, config.toml and profiles, approval and sandbox settings, MCP
   servers, AGENTS.md, skills, resume, model selection. When you are not certain, fetch the
   official documentation at https://developers.openai.com/codex rather than guessing.
   Always be clear about which of the two you are describing: "that is Codex" versus "that
   is this app" is usually the answer the user actually needs.

Rules:
- You are NOT looking at the user's own project. This session runs in a documentation
  workspace, so you cannot see their code, and you must not pretend to. For a question
  about their repository, tell them to ask in that project's own session.
- Never invent a setting, a shortcut or a menu path. A named control that does not exist is
  worse than "I do not know".
- Do not write files in this folder. The app rebuilds it from its own copy before every
  Ask Conductor launch, so anything written here is gone by the next one.

## The helper skill (you are the installer)

Beside this file sit two READY-MADE skill files that let the user's OTHER Codex sessions
answer Conductor questions without opening this tab:

- **ask-conductor-skill.md** -- for THIS machine. To install it: in the \`skills\` folder of
  the Codex home this session runs under (\`$CODEX_HOME/skills\` when CODEX_HOME is set,
  otherwise \`~/.codex/skills\`), create the directory \`ask-conductor\` and copy the file into
  it as \`SKILL.md\`, VERBATIM -- no edits, no summarising, no regeneration from memory. To
  update it, copy again the same way. To uninstall, delete that directory. Its body points
  at the app-knowledge.md the app regenerates, so an installed copy never goes stale on
  this machine.
- **ask-conductor-skill-portable.md** -- a SELF-CONTAINED, version-stamped copy for a
  machine this app is not installed on (an SSH host the user works over, say). The pointer
  variant cannot cross machines. Help the user get it there -- build the exact scp/copy
  command for them, or hand them the content to paste into that machine's own session --
  but NEVER ask for, or handle, a password or credential to do it yourself, and remind them
  a portable copy only refreshes when they re-copy it after an app update.

Consent rules: install, update or remove a skill file ONLY when the user asks for it in
this conversation. You may OFFER it -- once, briefly -- when their question shows they
would benefit (they ask about settings from another session's point of view, or how to
teach their sessions about the app). If a copy fails or the approval prompt is refused,
report exactly what happened and stop; never retry around a refusal.
`
}

/** The AGENTS.md the help folder holds on `platform`: the preamble, and on
 *  Windows the whole user guide inline after it (agentsPreamble). */
export function askConductorAgentsMarkdown(platform: NodeJS.Platform = process.platform): string {
  const inline = platform === 'win32'
  const preamble = agentsPreamble(inline)
  return inline ? `${preamble}\n---\n\n${appKnowledgeMarkdown()}` : preamble
}

/** Room above AGENTS.md's own size in the value an Ask launch passes. */
const PROJECT_DOC_MARGIN_BYTES = 4096

/**
 * The `project_doc_max_bytes` value an Ask launch on Codex passes (with
 * `project_root_markers=[]`, so no parent folder's AGENTS.md joins it): the
 * UTF-8 size of the AGENTS.md this module writes on `platform`, plus a margin,
 * so Codex reads the whole file and never a cut one. Computed from the same
 * text ensureHelpWorkspace writes, so the two cannot drift apart; a plain
 * integer, which both launch routes take.
 */
export function askConductorProjectDocMaxBytes(platform: NodeJS.Platform = process.platform): number {
  return Buffer.byteLength(askConductorAgentsMarkdown(platform), 'utf-8') + PROJECT_DOC_MARGIN_BYTES
}

/** Every file the help folder holds, by name, with its exact bytes. Nothing
 *  else may be in the folder (ensureHelpWorkspace). */
function helpWorkspaceFiles(dir: string, appVersion: string, platform: NodeJS.Platform): ReadonlyArray<readonly [string, Buffer]> {
  const utf8 = (s: string) => Buffer.from(s, 'utf-8')
  return [
    ['CLAUDE.md', utf8(CLAUDE_MD)],
    ['AGENTS.md', utf8(askConductorAgentsMarkdown(platform))],
    ['app-knowledge.md', utf8(appKnowledgeMarkdown())],
    // The two ready-made helper-skill files the preambles teach the Ask
    // session to install (#586). Written here -- inside the hardened dir --
    // and ONLY here: the app itself never writes into ~/.claude or a Codex
    // home; the install is a user-approved copy performed by the Ask session
    // under its own CLI's permission or approval prompt.
    ['ask-conductor-skill.md', utf8(askConductorSkillMarkdown(dir))],
    ['ask-conductor-skill-portable.md', utf8(askConductorSkillPortableMarkdown(appVersion))],
  ]
}

/** `O_NOFOLLOW` where the platform has it (POSIX). On Windows the `lstat`
 *  below is what refuses a link. */
const O_NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

/**
 * True when `file` is a real, unlinked file whose bytes are EXACTLY
 * `expected`: the check `canvas-plugin.ts` makes of its own tree (see its
 * `fileHasExactly` for the reasoning). Content, not shape -- an instruction
 * file edited in place keeps its name -- read from one descriptor that was
 * checked to be a plain file, so a swap between the check and the read
 * cannot get a different file compared than the one read.
 */
function fileHasExactly(file: string, expected: Buffer): boolean {
  let fd: number | undefined
  try {
    if (!fs.lstatSync(file).isFile()) return false
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW)
    const st = fs.fstatSync(fd)
    // Size first: the common mismatch is cheap, and a huge replacement is
    // never read into memory only to be rejected.
    if (!st.isFile() || st.size !== expected.length) return false
    const buf = Buffer.alloc(expected.length)
    let read = 0
    while (read < expected.length) {
      const n = fs.readSync(fd, buf, read, expected.length - read, null)
      if (n <= 0) break
      read += n
    }
    return read === expected.length && buf.equals(expected)
  } catch {
    return false
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* best-effort */ } }
  }
}

/** True when `dir` is a real folder holding exactly `files`, byte for byte,
 *  and no other entry of any kind (a hidden one, a folder, a link). */
function holdsExactly(dir: string, files: ReadonlyArray<readonly [string, Buffer]>): boolean {
  try {
    const st = fs.lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) return false
    const names = fs.readdirSync(dir)
    const wanted = new Set(files.map(([name]) => name))
    if (names.length !== wanted.size) return false
    for (const name of names) if (!wanted.has(name)) return false
  } catch {
    return false
  }
  return files.every(([name, bytes]) => fileHasExactly(path.join(dir, name), bytes))
}

/**
 * Remove `p` and everything below it WITHOUT following a link of any kind.
 *
 * Not `fs.rmSync(..., { recursive: true })`: what sits in this folder may have
 * been put there by a sandboxed model (Codex grants its sandbox write access
 * to the session's working folder, PB8), so a junction or symlink inside it is
 * the expected attack, and only the link itself may go, never what it points
 * at. `lstat` reports a Windows junction as a symbolic link, and `unlink`
 * removes a link of either kind (file or directory) without touching its
 * target. A read-only attribute or a mode the owner can lift is lifted, on a
 * real file or folder only, and the removal tried once more.
 */
function removeNoFollow(p: string): void {
  const st = fs.lstatSync(p)
  if (st.isDirectory() && !st.isSymbolicLink()) {
    let names: string[]
    try {
      names = fs.readdirSync(p)
    } catch {
      fs.chmodSync(p, 0o700)
      names = fs.readdirSync(p)
    }
    for (const name of names) removeNoFollow(path.join(p, name))
    try {
      fs.rmdirSync(p)
    } catch {
      fs.chmodSync(p, 0o700)
      fs.rmdirSync(p)
    }
    return
  }
  try {
    fs.unlinkSync(p)
  } catch (err) {
    if (st.isSymbolicLink()) throw err
    fs.chmodSync(p, 0o600)
    fs.unlinkSync(p)
  }
}

/**
 * Rebuild the help folder from nothing: everything in it goes, then the
 * folder itself where it can (it cannot while some process still has it as
 * its working folder, on Windows; it is then left in place, empty), then the
 * app's own files are written into a hardened folder and read back.
 *
 * A failure anywhere throws: an Ask launch then fails closed rather than
 * starting a session in a folder the app cannot vouch for. The emptiness check
 * is its own guard, not a repeat of the removals': on Windows a file another
 * process holds open is removed only when that process closes it, and is
 * listed until then.
 */
function rebuildHelpWorkspace(dir: string, files: ReadonlyArray<readonly [string, Buffer]>): void {
  for (const name of fs.readdirSync(dir)) removeNoFollow(path.join(dir, name))
  try { fs.rmdirSync(dir) } catch { /* held open as a working folder: kept, empty */ }
  mkdirSecure(dir)
  hardenCredentialDir(dir)
  if (fs.readdirSync(dir).length !== 0) throw new Error(NOT_EMPTIED)
  for (const [name, bytes] of files) atomicWriteSecure(path.join(dir, name), bytes, 0o600)
  if (!holdsExactly(dir, files)) throw new Error(NOT_EXACT)
}

const NOT_EMPTIED = 'the help folder could not be emptied'
const NOT_EXACT = 'the help folder is not the app\'s own files after a rebuild'

/**
 * A failed rebuild as the log may hold it (P4.3): a file system error by its
 * code and the call that failed, this module's own failures by their fixed
 * words. Never an error's message: that names the path, and the entry's name
 * is one a session chose.
 */
function rebuildFailureForLog(err: unknown): string {
  if (err instanceof Error && (err.message === NOT_EMPTIED || err.message === NOT_EXACT)) return err.message
  const word = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(v) ? v : null)
  const { code, syscall } = (err ?? {}) as { code?: unknown; syscall?: unknown }
  const c = word(code)
  if (c) return word(syscall) ? `${c} (${word(syscall)})` : c
  if (err instanceof Error && /reparse point/.test(err.message)) return 'a link or junction where a folder should be'
  return 'an unexpected error'
}

/**
 * CLAUDE.md and AGENTS.md here are not data: they are the instruction files a
 * real Claude Code or Codex session reads at startup, and this directory
 * becomes that session's cwd (so `.mcp.json` / `.claude/settings.local.json`,
 * or Codex's `.codex/config.toml`, beside them would be live too). A plain
 * mkdirSync writes straight THROUGH a junction planted at `<resources>/help`,
 * and succeeds, so the swallowed-error path upstream never fires.
 *
 * mkdirSecure refuses a reparse point anywhere below the resources anchor;
 * hardenCredentialDir then makes the directory owner-only so it cannot be
 * re-planted. A throw propagates -- the caller returns null and the Ask session
 * fails closed, which is the right answer for an instruction file we cannot
 * vouch for.
 *
 * The folder is VERIFIED on every call and rebuilt from nothing whenever it is
 * not exactly the app's own files, down to the bytes, as `ensureCanvasPlugin`
 * does for its plugin tree (WP2 PR 4, P4.3). Owner-only is not enough here:
 * Codex grants its sandbox write access to the session's working folder, and
 * the app's re-hardening cannot take that grant back (PB8; 9.6 items 21, 22),
 * and the session in which Codex's first-launch screens are answered runs with
 * workspace writes whatever preset it was given. So no Ask preset is relied on
 * to keep this folder read-only: whatever a session wrote here (an instruction
 * file, an edited AGENTS.md, a project settings file such as
 * `.codex/config.toml` or `.claude/settings.local.json`, a skills folder) is
 * gone before the next Ask launch reads the folder.
 *
 * Called by main right before EVERY Ask spawn, of either assistant: a first
 * launch, a revive, a Restart, Past discussions, an account switch's remount,
 * a restored tab (`pty:spawn`, ipc/pty-handlers.ts; no rebuild, no launch);
 * by `help:workspace`, which gives the renderer the folder's path; and once
 * at boot, best-effort, so an installed helper skill reads current docs. It
 * runs for a Claude Code Ask too: a project settings file a Codex session
 * planted would reach it otherwise; the cost is that a Claude Ask's own
 * "don't ask again" approvals written here do not outlive its session. A
 * failed rebuild is logged, neutrally (rebuildFailureForLog), then thrown:
 * any failure, the folder's own making included, so the log has the cause
 * of every Ask start that a rebuild refused (review RASK-2).
 */
export function ensureHelpWorkspace(resourcesDir: string, opts?: { appVersion?: string; platform?: NodeJS.Platform }): string {
  const dir = path.join(resourcesDir, 'help')
  try {
    mkdirSecure(dir)
    hardenCredentialDir(dir)
    const files = helpWorkspaceFiles(dir, opts?.appVersion ?? 'unknown', opts?.platform ?? process.platform)
    if (!holdsExactly(dir, files)) rebuildHelpWorkspace(dir, files)
  } catch (err) {
    logWarn(`[help-workspace] the help folder could not be rebuilt: ${rebuildFailureForLog(err)}; no Ask Conductor session starts until it can be`)
    throw err
  }
  return dir
}
