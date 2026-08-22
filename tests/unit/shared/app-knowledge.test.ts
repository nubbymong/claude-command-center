/**
 * The rules `app-knowledge.ts` states about itself, enforced.
 *
 * This file is the SINGLE SOURCE for two user-facing surfaces: the in-app
 * Feature Guide, and the documentation folder the Ask Conductor session is
 * launched in. So its contents are read by users and pasted into a Claude
 * session's context, and its header lays down rules accordingly: user
 * documentation only, no internal paths, no build secrets, no architecture
 * internals, no em dashes. None of that was checked by anything.
 */
import { describe, it, expect } from 'vitest'
import { APP_KNOWLEDGE_SECTIONS } from '../../../src/shared/app-knowledge'

describe('app knowledge is publishable', () => {
  it('has unique, stable-looking ids and a title and body for every section', () => {
    const ids = APP_KNOWLEDGE_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.id, `${s.id} id shape`).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(s.title.trim().length, `${s.id} has a title`).toBeGreaterThan(0)
      expect(s.body.trim().length, `${s.id} has a body`).toBeGreaterThan(80)
    }
  })

  it('uses no em dashes', () => {
    // The file's own rule. They read badly in the terminal-rendered Feature
    // Guide and this text is public-facing.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(`${s.title} ${s.body}`, `${s.id} em dash`).not.toMatch(/—/)
    }
  })

  it('leaks no absolute or personal paths', () => {
    // A Windows drive path, a POSIX absolute path or a home reference here
    // would be one developer's machine, shipped to every user and pasted into
    // an agent's context.
    //
    // Checked by SEGMENT as well as by separator, because a Windows path
    // pasted into a JS string loses its backslashes to escape processing:
    // 'C:\Users\you' is the four characters C, :, U... at runtime. Matching
    // only on a separator misses exactly the mistake someone would make.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      const text = `${s.title} ${s.body}`
      expect(text, `${s.id} drive path`).not.toMatch(/[A-Za-z]:[\\/]/)
      expect(text, `${s.id} mangled drive path`).not.toMatch(/\b[A-Za-z]:[\\/]?(Users|home|Documents)/i)
      expect(text, `${s.id} home path`).not.toMatch(/(^|\s)~[\\/]/)
      expect(text, `${s.id} users path`).not.toMatch(/[\\/](home|Users)[\\/]/)
      expect(text, `${s.id} windows profile dir`).not.toMatch(/AppData|Roaming|ProgramData/i)
      // A generic POSIX absolute path, which the checks above do not cover.
      // Two segments minimum, so the slash commands this text legitimately
      // names (/config) are not false positives.
      expect(text, `${s.id} posix absolute path`).not.toMatch(/(^|\s)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/)
    }
  })

  it('names no source files or internal modules', () => {
    // "architecture internals" in practice means naming the code. A user
    // cannot act on `src/main/…`, and Ask Conductor quoting it is worse.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      const text = `${s.title} ${s.body}`
      expect(text, `${s.id} source path`).not.toMatch(/\bsrc\//)
      expect(text, `${s.id} source file`).not.toMatch(/\.tsx?\b/)
    }
  })

  it('carries no "not affiliated with Anthropic" line (#383)', () => {
    // Owner call 2026-08-22: the disclaimer is gone from the app and docs, and
    // this text is pasted into the Ask Conductor session, so it must not keep
    // repeating it from there.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(`${s.title} ${s.body}`, `${s.id} affiliation line`).not.toMatch(/affiliated|endorsed by/i)
    }
  })

  it('explains which settings file wins, and that a running session keeps its own', () => {
    // The concept behind #314: a setting that appears to do nothing is
    // usually being overridden, and a change never reaches a session that is
    // already running. Both have to be findable by asking in plain English.
    const section = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'settings-scope')
    expect(section, 'settings-scope section exists').toBeTruthy()
    const body = section!.body

    // The precedence chain, weakest to strongest, each named.
    for (const file of ['settings.local.json', 'settings.json', 'organisation']) {
      expect(body, `mentions ${file}`).toContain(file)
    }
    expect(body, 'says the nearest one wins').toMatch(/nearest|strongest|wins/i)
    expect(body, 'says /config writes the project-local file').toContain('/config')
    // Both halves of "when it takes effect", asserted separately: an
    // alternation passed here even with the running-session claim deleted,
    // because "starts" appears elsewhere in the same paragraph.
    expect(body, 'says settings are read at session start').toMatch(/when a session starts/i)
    expect(body, 'says a running session is unaffected').toMatch(/already running/i)

    // The multi-account wrinkle, which is ours and documented nowhere else.
    expect(body, 'says the personal file is copied per account').toMatch(/copied|copy/i)
    expect(body, 'says which things are shared instead').toMatch(/shared/i)
  })
})
