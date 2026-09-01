/**
 * The Ask Conductor helper-skill templates (#586).
 *
 * ensureHelpWorkspace stages two READY-MADE skill files beside app-knowledge.md
 * and the CLAUDE.md preamble teaches the Ask session to install them -- the app
 * itself never writes outside its resources dir, so what these tests hold shut
 * is the CONTENT CONTRACT: the templates the session copies verbatim must be
 * complete, correctly pointed, version-stamped, and the preamble must carry the
 * consent rules (only on the user's ask; never handle credentials).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// The real mkdirSecure/hardenCredentialDir do reparse-point checks and Windows
// ACL work -- correct in production, irrelevant to the content contract and
// slow/fragile against a throwaway temp dir. Behaviour-preserving stand-ins.
vi.mock('../../../src/main/account-profiles', () => ({
  mkdirSecure: (p: string) => fs.mkdirSync(p, { recursive: true }),
  hardenCredentialDir: () => {},
}))

const { ensureHelpWorkspace, askConductorSkillMarkdown, askConductorSkillPortableMarkdown } =
  await import('../../../src/main/help-workspace')
const { appKnowledgeMarkdown } = await import('../../../src/shared/app-knowledge')

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-help-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ensureHelpWorkspace stages the helper-skill files', () => {
  it('writes both skill templates beside CLAUDE.md and app-knowledge.md', () => {
    const dir = ensureHelpWorkspace(tmp, { appVersion: '9.9.9' })
    for (const f of ['CLAUDE.md', 'app-knowledge.md', 'ask-conductor-skill.md', 'ask-conductor-skill-portable.md']) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true)
    }
  })

  it('the local template points at THIS workspace\'s app-knowledge.md (machine-specific, never a placeholder)', () => {
    const dir = ensureHelpWorkspace(tmp, { appVersion: '9.9.9' })
    const skill = fs.readFileSync(path.join(dir, 'ask-conductor-skill.md'), 'utf-8')
    expect(skill).toContain(path.join(dir, 'app-knowledge.md'))
    // Valid skill shape: frontmatter with the fixed name and a description that
    // names the confusions it answers (that description is the invocation
    // trigger in other sessions).
    expect(skill.startsWith('---\nname: ask-conductor\n')).toBe(true)
    expect(skill).toMatch(/description: '.*settings files and which one wins.*'/)
    // The pointer body must NOT embed the knowledge -- freshness rides the
    // app's own regeneration of app-knowledge.md.
    expect(skill).not.toContain('## The status line')
  })

  it('the portable template is self-contained and version-stamped', () => {
    const dir = ensureHelpWorkspace(tmp, { appVersion: '9.9.9' })
    const portable = fs.readFileSync(path.join(dir, 'ask-conductor-skill-portable.md'), 'utf-8')
    expect(portable).toContain('v9.9.9')
    expect(portable.startsWith('---\nname: ask-conductor\n')).toBe(true)
    // Self-contained: the FULL knowledge document rides inside it.
    expect(portable).toContain(appKnowledgeMarkdown().trim())
    // ...and it says it does not update itself.
    expect(portable).toMatch(/does NOT update itself/i)
  })

  it('omitting the version falls back to a stamp, never a template hole', () => {
    const dir = ensureHelpWorkspace(tmp)
    const portable = fs.readFileSync(path.join(dir, 'ask-conductor-skill-portable.md'), 'utf-8')
    expect(portable).toContain('vunknown')
    expect(portable).not.toContain('undefined')
  })

  it('the CLAUDE.md preamble teaches the install as verbatim-copy with consent rules', () => {
    const dir = ensureHelpWorkspace(tmp, { appVersion: '9.9.9' })
    const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')
    // Both template files are named, the destination is exact, the copy is
    // verbatim, and the consent boundary is explicit.
    expect(claudeMd).toContain('ask-conductor-skill.md')
    expect(claudeMd).toContain('ask-conductor-skill-portable.md')
    expect(claudeMd).toContain('~/.claude/skills/ask-conductor')
    expect(claudeMd).toMatch(/VERBATIM/)
    expect(claudeMd).toMatch(/ONLY when the user asks/)
    expect(claudeMd).toMatch(/NEVER ask for, or handle, a password or credential/)
  })

  it('re-running refreshes in place (idempotent) and tracks a version change', () => {
    ensureHelpWorkspace(tmp, { appVersion: '1.0.0' })
    const dir = ensureHelpWorkspace(tmp, { appVersion: '2.0.0' })
    const portable = fs.readFileSync(path.join(dir, 'ask-conductor-skill-portable.md'), 'utf-8')
    expect(portable).toContain('v2.0.0')
    expect(portable).not.toContain('v1.0.0')
  })
})

describe('template generators (pure)', () => {
  it('askConductorSkillMarkdown embeds the given help dir path', () => {
    const md = askConductorSkillMarkdown('X:\\some\\help')
    expect(md).toContain(path.join('X:\\some\\help', 'app-knowledge.md'))
  })

  it('portable generator embeds the knowledge exactly once', () => {
    const md = askConductorSkillPortableMarkdown('1.2.3')
    const marker = '# AI Code Conductor: user guide'
    expect(md.indexOf(marker)).toBeGreaterThan(-1)
    expect(md.indexOf(marker)).toBe(md.lastIndexOf(marker))
  })
})
