// [host] WP2 PR 4, P4.6 second half (row 58): the user-facing copy about a
// Codex account's chatgpt.com sign-in names no sign-in method. Which methods
// complete in the in-app window is for the owner's sign-in run (OR2) to show;
// until then the copy says "Sign in to chatgpt.com" and nothing more. Checks
// every sentence that mentions chatgpt.com in the tips (the new tip and the
// network list), the Feature Guide and Ask Conductor knowledge, and the
// changelog.
import { describe, it, expect } from 'vitest'
import { TIPS_LIBRARY } from '../../src/renderer/tips-library'
import { APP_KNOWLEDGE_SECTIONS } from '../../src/shared/app-knowledge'
import { changelog } from '../../src/renderer/changelog'

/** A sign-in method, by any name a user would read as one. */
const METHOD = /\b(google|apple|phone|sms|microsoft|passkey|magic link|one-time code|by email|with email)\b/i

function sentencesAbout(text: string, what: RegExp): string[] {
  return text.split(/(?<=[.!?])\s+|\n/).filter((s) => what.test(s))
}

const ABOUT_WEB = /chatgpt\.com/i

describe('[host] the chatgpt.com sign-in copy names no sign-in method', () => {
  it('the tip for it, and every chatgpt.com line in the tips', () => {
    const tip = TIPS_LIBRARY.find((t) => t.id === 'tip.codex-chatgpt-sign-in')
    expect(tip, 'the tip exists').toBeDefined()
    const v = tip!.variants.primary
    for (const s of [v.shortText, v.title, v.body]) expect(s, s).not.toMatch(METHOD)
    for (const t of TIPS_LIBRARY) {
      const body = t.variants.primary.body
      for (const s of sentencesAbout(body, ABOUT_WEB)) {
        // The usage check (Codex's own, signed in with ChatGPT) is not this
        // sign-in; only lines about signing in to chatgpt.com in the app count.
        if (!/sign(ed)? (a Codex account )?in to chatgpt\.com|chatgpt\.com sign-in/i.test(s)) continue
        expect(s, t.id).not.toMatch(METHOD)
      }
    }
  })

  it('the Feature Guide and Ask Conductor knowledge', () => {
    let found = 0
    for (const section of APP_KNOWLEDGE_SECTIONS) {
      for (const s of sentencesAbout(section.body, ABOUT_WEB)) {
        if (!/chatgpt\.com (inside the app|in the app)|sign(ed)? (a Codex account )?in to chatgpt\.com|Sign in to chatgpt\.com|Sign out of chatgpt\.com/i.test(s)) continue
        found++
        expect(s, section.id).not.toMatch(METHOD)
      }
    }
    expect(found, 'the knowledge describes the sign-in').toBeGreaterThan(0)
  })

  it('the changelog', () => {
    let found = 0
    for (const entry of changelog) {
      for (const c of entry.changes) {
        if (!/chatgpt\.com inside the app|Sign in to chatgpt\.com/i.test(c.description)) continue
        found++
        expect(c.description, entry.version).not.toMatch(METHOD)
      }
    }
    expect(found, 'the changelog describes the sign-in').toBeGreaterThan(0)
  })
})
