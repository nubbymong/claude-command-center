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
`

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
export function ensureHelpWorkspace(resourcesDir: string): string {
  const dir = path.join(resourcesDir, 'help')
  mkdirSecure(dir)
  hardenCredentialDir(dir)
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD, 'utf-8')
  fs.writeFileSync(path.join(dir, 'app-knowledge.md'), appKnowledgeMarkdown(), 'utf-8')
  return dir
}
