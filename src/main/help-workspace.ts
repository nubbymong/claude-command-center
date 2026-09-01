import * as fs from 'fs'
import * as path from 'path'
import { appKnowledgeMarkdown } from '../shared/app-knowledge'
import { mkdirSecure, hardenCredentialDir } from './account-profiles'

/**
 * "Ask Conductor" workspace. A folder under the resources directory
 * holding a CLAUDE.md preamble + the curated app-knowledge.md; the ask session
 * simply launches with this folder as its working directory, so Claude Code
 * reads the knowledge through its normal CLAUDE.md mechanism. No CLI flags, no
 * global config writes, and the user can open the files themselves.
 *
 * Refreshed on every call (cheap, idempotent) so the docs always match the
 * running app version rather than whichever version staged them first.
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
 *  moment, so it names the confusions it exists to answer. Single-quoted (')
 *  YAML is deliberate: the text contains no quotes, and a colon inside plain
 *  YAML would truncate the description silently. */
const SKILL_FRONTMATTER = `---
name: ask-conductor
description: 'How the AI Code Conductor desktop app works -- settings files and which one wins, multiple Claude accounts and the copied-settings rule, SSH and remote sessions, the status line, known issues. Invoke for questions about the Conductor app, or when a Claude Code setting seems not to apply on this machine. Not for questions about the user''s own project code.'
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
orchestrates Claude Code sessions. The app regenerates its curated user
documentation on every launch at:

    ${path.join(helpDir, 'app-knowledge.md')}

Read that file first, then answer from it. It covers the settings precedence
chain (which file wins and why a change can look ignored), how multiple Claude
accounts share and copy settings, SSH and container sessions, the status line,
and the app's known issues with workarounds.

If the file is missing, the app has moved or been uninstalled: say so plainly
and suggest the app's own Ask Conductor tab (the pill at the foot of its
sidebar) or its Feature Guide. Do not answer app questions from memory in that
case, and never invent a setting, tab or menu path the file does not name.
Questions about Claude Code itself (hooks, MCP servers, slash commands) you may
answer from your own knowledge -- say clearly which of the two you are
describing.
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
menu path it does not name. Questions about Claude Code itself you may answer
from your own knowledge -- say which of the two you are describing.

---

${appKnowledgeMarkdown()}
`
}

/**
 * CLAUDE.md here is not data: it is the instruction file a real Claude Code
 * session reads at startup, and this directory becomes that session's cwd (so
 * `.mcp.json` / `.claude/settings.local.json` beside it are live too). A plain
 * mkdirSync writes straight THROUGH a junction planted at `<resources>/help`,
 * and succeeds, so the swallowed-error path upstream never fires.
 *
 * mkdirSecure refuses a reparse point anywhere below the resources anchor;
 * hardenCredentialDir then makes the directory owner-only so it cannot be
 * re-planted. A throw propagates -- the caller returns null and the Ask session
 * fails closed, which is the right answer for an instruction file we cannot
 * vouch for.
 */
export function ensureHelpWorkspace(resourcesDir: string, opts?: { appVersion?: string }): string {
  const dir = path.join(resourcesDir, 'help')
  mkdirSecure(dir)
  hardenCredentialDir(dir)
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD, 'utf-8')
  fs.writeFileSync(path.join(dir, 'app-knowledge.md'), appKnowledgeMarkdown(), 'utf-8')
  // The two ready-made helper-skill files the CLAUDE.md preamble teaches the
  // Ask session to install (#586). Written here -- inside the hardened dir --
  // and ONLY here: the app itself never writes into ~/.claude; the install is
  // a user-approved copy performed by the Ask session under Claude Code's own
  // permission prompt.
  fs.writeFileSync(path.join(dir, 'ask-conductor-skill.md'), askConductorSkillMarkdown(dir), 'utf-8')
  fs.writeFileSync(
    path.join(dir, 'ask-conductor-skill-portable.md'),
    askConductorSkillPortableMarkdown(opts?.appVersion ?? 'unknown'),
    'utf-8',
  )
  return dir
}
