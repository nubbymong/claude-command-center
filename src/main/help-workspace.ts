import * as fs from 'fs'
import * as path from 'path'
import { appKnowledgeMarkdown } from '../shared/app-knowledge'

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

Rules:
- Answer questions about the Conductor's features, settings, and behaviour using app-knowledge.md. Keep answers short and practical, and name the exact Settings tab or button when directing the user somewhere.
- You only have user documentation. If asked about the app's source code, internals, or anything not covered by the docs, say the docs do not cover it and suggest the Feature Guide (the ? button in the sidebar) or the project's GitHub page.
- General Claude Code questions are fine to answer from your own knowledge; be clear about what is Claude Code versus what is the Conductor app.
`

export function ensureHelpWorkspace(resourcesDir: string): string {
  const dir = path.join(resourcesDir, 'help')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD, 'utf-8')
  fs.writeFileSync(path.join(dir, 'app-knowledge.md'), appKnowledgeMarkdown(), 'utf-8')
  return dir
}
