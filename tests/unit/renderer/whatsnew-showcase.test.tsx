// @vitest-environment jsdom
/**
 * The What's New feature showcase (owner design, 2026-08-24): the summary is
 * page 0 and each flagship feature of the line gets a full page behind it,
 * paged by footer dots / Next, escapable by Skip, with the harness CTA only on
 * the last page.
 *
 * What this file holds shut:
 *  - the harness contract is untouched: onNext fires exactly when the run is
 *    left (last-page CTA, or Skip), never on internal paging;
 *  - the "See it" chips only render for items whose showcase page exists, so
 *    the two curated files cannot drift into a dead button;
 *  - a line with no showcase (2.0) collapses to exactly the old single-page
 *    step — no dots, no skip, the incoming CTA label.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__APP_VERSION__ = '2.1.0-rc.1'

const metaState: any = { meta: { lastSeenVersion: '2.1.0-beta.17' } }
vi.mock('../../../src/renderer/stores/appMetaStore', () => {
  const useAppMetaStore: any = (sel: any) => sel(metaState)
  useAppMetaStore.getState = () => metaState
  return { useAppMetaStore }
})

const settingsState: any = { settings: { updateChannel: 'stable' } }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore }
})

const { WhatsNewV2Step, sectionsFor, showRenamePageFor } = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
const { SHOWCASES_21, showcasesFor } = await import('../../../src/renderer/onboarding/showcase-pages')
const { ShowcaseVignette } = await import('../../../src/renderer/onboarding/ShowcaseVignette')

let container: HTMLDivElement
let root: Root
let nexts: number

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  nexts = 0
  metaState.meta = { lastSeenVersion: '2.1.0-beta.17' }
  settingsState.settings = { updateChannel: 'stable' }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const q = (id: string) => container.querySelector(`[data-ux-id="${id}"]`)
const click = (el: Element | null) => act(() => { (el as HTMLElement).click() })

function render(props: Partial<React.ComponentProps<typeof WhatsNewV2Step>> = {}) {
  act(() => {
    root.render(<WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="Nothing to set up." {...props} />)
  })
}

// ── the curated data ───────────────────────────────────────────────
describe('showcase-pages — the curated set', () => {
  it('the 2.1 line has pages; the 2.0 line has none; a future line falls back to the newest set', () => {
    expect(showcasesFor('2.1.0-rc.1').length).toBeGreaterThan(0)
    expect(showcasesFor('2.0.5')).toEqual([])
    expect(showcasesFor('2.2.0')).toEqual(SHOWCASES_21)
  })

  it('page ids are unique and every page keeps to 3-4 points', () => {
    const ids = SHOWCASES_21.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of SHOWCASES_21) {
      expect(p.points.length, p.id).toBeGreaterThanOrEqual(3)
      expect(p.points.length, p.id).toBeLessThanOrEqual(4)
    }
  })

  it('every seeIt on the summary resolves to a real showcase page — no dead chips', () => {
    // undefined lastSeen yields the widest summary (both section sets), and
    // the page set is the one the COMPONENT consumes (showcasesFor), not the
    // raw constant — so this pins the pair that actually renders together.
    const items = sectionsFor(undefined, '2.1.0').flatMap((s) => s.items)
    const pageIds = new Set(showcasesFor('2.1.0').map((p) => p.id))
    for (const it of items) {
      if (it.seeIt) expect(pageIds.has(it.seeIt), `seeIt "${it.seeIt}" on "${it.title}"`).toBe(true)
    }
    // And the flagships are actually linked, not merely linkable.
    const linked = items.filter((i) => i.seeIt).map((i) => i.seeIt)
    expect(linked).toContain('canvas')
    expect(linked).toContain('watchdog')
    expect(linked).toContain('oneRow')
  })

  it('P3.4 (row 14): with Claude Code off, what needs Claude Code in this release is not shown', () => {
    // P3.6 lifted the accounts page and the Switch mid-session line (a Codex
    // account switches mid-session too); claude.ai in the app stays Claude's.
    // P3.10 lifted the watchdog page and its line (the Watchdog arms for Codex).
    // WP2 PR 4, P4.1 lifted the canvas page and its line (the Agent Canvas
    // works in Codex sessions).
    // P4.3 lifted the Ask Conductor page and its line (Ask runs on Codex).
    const CLAUDE_ONLY_PAGES = ['remoteResume']
    // The two remote lines (VM round, M1): SSH Persistent keeps the remote
    // session alive by wrapping the remote claude command, and the only agent
    // an SSH session runs in this release is Claude Code, so both go with the
    // remote resume page.
    const REMOTE_ITEMS = ['SSH Persistent.', 'Remote Resumable.']
    const CLAUDE_ONLY_ITEMS = ['claude.ai in the app.', 'Insights.', ...REMOTE_ITEMS]
    // Claude Code on: everything, as before.
    render()
    expect(container.textContent).toContain('Working with Claude')
    for (const t of CLAUDE_ONLY_ITEMS) expect(container.textContent, t).toContain(t)
    expect(q('see-remoteResume')).not.toBeNull()
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${1 + SHOWCASES_21.length}`)
    const claudeOnlyText = container.textContent
    act(() => root.unmount())
    root = createRoot(container)
    // Both on: what Claude Code alone shows, but the heading over the canvas,
    // Watchdog and Ask lines names both (P4.11, INT-7: each works for both).
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: true, codexEnabled: true }
    render()
    expect(container.textContent).toBe(claudeOnlyText.replace('Working with Claude', 'Working with Claude and Codex'))
    act(() => root.unmount())
    root = createRoot(container)
    // Claude Code off: those items and pages go; a section left empty goes too.
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render()
    expect(container.textContent).not.toContain('Working with Claude')
    // The section stays for the switch line (P3.6).
    expect(container.textContent).toContain('Accounts & usage')
    expect(container.textContent).toContain('Switch mid-session.')
    for (const t of CLAUDE_ONLY_ITEMS) expect(container.textContent, t).not.toContain(t)
    const shown = SHOWCASES_21.filter((p: { id: string }) => !CLAUDE_ONLY_PAGES.includes(p.id))
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${1 + shown.length}`)
    // The Sessions section stays for the lines that do not need Claude Code;
    // the remote resume page and its chip go with the two remote lines.
    expect(q('section-sessions')).not.toBeNull()
    expect(q('section-sessions')!.textContent).toContain('Partner terminal.')
    expect(q('see-remoteResume')).toBeNull()
    expect(q('see-oneRow')).not.toBeNull()
    const all21 = sectionsFor('2.1.0-beta.17', '2.1.0').flatMap((s) => s.items)
    for (const t of REMOTE_ITEMS) expect(all21.find((i) => i.title === t)?.needsClaude, t).toBe(true)
    // The 2.0 set's guide line promises Ask ("a session that has read the
    // docs"), which runs on Codex too since P4.3; the partner terminal works
    // beside a Codex session too. Both stay.
    const all20 = sectionsFor(undefined, '2.1.0').flatMap((s) => s.items)
    expect(all20.find((i) => i.title === 'A guide that answers back.')?.needsClaude).toBeUndefined()
    expect(all20.find((i) => i.title === 'Partner terminal.')?.needsClaude).toBeUndefined()
    // ...and names no provider (row 64 did the same for the strip and tips).
    expect(all20.find((i) => i.title === 'Partner terminal.')?.desc).toBe('A plain shell beside your session, labelled so you always know which is which.')
  })

  it('WP2 PR 4, P4.1 (row 51): the Agent Canvas is told for both providers, and shows with Claude Code off', () => {
    const lines = sectionsFor('2.1.0-beta.17', '2.1.0').flatMap((s) => s.items)
    const canvas = lines.find((i) => i.title === 'Agent Canvas.')!
    expect(canvas.needsClaude).toBeUndefined()
    expect(canvas.seeIt).toBe('canvas')
    expect(canvas.desc).not.toMatch(/claude|codex/i)
    const page = SHOWCASES_21.find((p: { id: string }) => p.id === 'canvas')!
    expect(page.needsClaude).toBeUndefined()
    expect(`${page.heading} ${page.tagline} ${page.where.pre}${page.where.em}${page.where.post}`).not.toMatch(/claude|codex/i)
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render()
    expect(container.textContent).toContain('Agent Canvas.')
    expect(q('see-canvas')).not.toBeNull()
  })

  it('P4.3 (row 53): Ask Conductor is told for both providers, and shows with Claude Code off', () => {
    const lines = sectionsFor('2.1.0-beta.17', '2.1.0').flatMap((s) => s.items)
    const ask = lines.find((i) => i.title === 'Ask Conductor.')!
    expect(ask.needsClaude).toBeUndefined()
    expect(ask.seeIt).toBe('askConductor')
    const page = SHOWCASES_21.find((p: { id: string }) => p.id === 'askConductor')!
    expect(page.needsClaude).toBeUndefined()
    for (const pt of page.points) expect(pt.needsClaude, pt.lead).toBeUndefined()
    // No point says it is Claude's alone.
    expect(page.points.map((pt: { lead: string; rest: string }) => `${pt.lead} ${pt.rest}`).join(' ')).not.toMatch(/every Claude session|Claude Code itself/)
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render()
    expect(container.textContent).toContain('Ask Conductor.')
    click(q('see-askConductor'))
    expect(q('showcase-page-askConductor')).not.toBeNull()
  })

  it('P3.10 (row 43): the Watchdog is told for both providers, and shows with Claude Code off', () => {
    const lines = sectionsFor('2.1.0-beta.17', '2.1.0').flatMap((s) => s.items)
    const wd = lines.find((i) => i.title === 'Session Watchdog.')!
    expect(wd.needsClaude).toBeUndefined()
    expect(wd.seeIt).toBe('watchdog')
    expect(wd.desc).not.toMatch(/claude|codex/i)
    const page = SHOWCASES_21.find((p: { id: string }) => p.id === 'watchdog')!
    expect(page.needsClaude).toBeUndefined()
    expect(`${page.heading} ${page.tagline} ${page.where.pre}${page.where.em}${page.where.post}`).not.toMatch(/claude|codex/i)
    for (const pt of page.points) expect(pt.needsClaude, pt.lead).toBeUndefined()
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render()
    expect(container.textContent).toContain('Session Watchdog.')
    // Its section no longer says Claude with Claude Code off.
    expect(container.textContent).toContain('Working with Codex')
    expect(container.textContent).not.toContain('Working with Claude')
    click(q('see-watchdog'))
    expect(q('showcase-page-watchdog')).not.toBeNull()
  })

  it('P3.6 (row 22): the switch is told for both providers; with Claude Code off, nothing about Claude\'s own services', () => {
    const lines = sectionsFor('2.1.0-beta.17', '2.1.0').flatMap((s) => s.items)
    const sw = lines.find((i) => i.title === 'Switch mid-session.')!
    expect(sw.needsClaude).toBeUndefined()
    expect(sw.seeIt).toBe('accounts')
    expect(sw.desc).not.toMatch(/claude/i)
    expect(lines.find((i) => i.title === 'claude.ai in the app.')?.needsClaude).toBe(true)
    const page = SHOWCASES_21.find((p: { id: string }) => p.id === 'accounts')!
    expect(page.needsClaude).toBeUndefined()
    expect(`${page.heading} ${page.tagline} ${page.where.pre}${page.where.em}${page.where.post}`).not.toMatch(/claude|insights/i)
    // Its Claude-only point is marked, and the page keeps three or more without it.
    for (const pt of page.points) {
      const claudeOnly = /insights|claude/i.test(`${pt.lead} ${pt.rest}`)
      expect(pt.needsClaude, pt.lead).toBe(claudeOnly ? true : undefined)
    }
    expect(page.points.filter((pt: { needsClaude?: boolean }) => !pt.needsClaude).length).toBeGreaterThanOrEqual(3)
    // Codex only: the page shows, without its Claude-only point.
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render()
    click(q('see-accounts'))
    expect(q('showcase-heading')!.textContent).toBe('Every account, one app')
    expect(q('showcase-points')!.textContent).toContain('Switch mid-session.')
    expect(q('showcase-points')!.textContent).not.toMatch(/insights/i)
    act(() => root.unmount())
    root = createRoot(container)
    // Claude Code on: the Insights point is there.
    settingsState.settings = { updateChannel: 'stable' }
    render()
    click(q('see-accounts'))
    expect(q('showcase-points')!.textContent).toContain('Insights across accounts.')
  })

  it('P3.4 (row 14): a run that goes on with Codex only (setup found no Claude Code) reads it the same way', async () => {
    const { noteClaudeMissingAtSetup, resetProviderChoiceForTests } = await import('../../../src/renderer/onboarding/provider-choice')
    noteClaudeMissingAtSetup()
    try {
      render()
      expect(container.textContent).toContain('One row.') // the summary page is the one shown
      expect(container.textContent).not.toContain('Working with Claude')
      // WP2 PR 4, P4.1: the Agent Canvas line stays (the canvas works in Codex sessions).
      expect(container.textContent).toContain('Agent Canvas.')
      expect(container.textContent).not.toContain('SSH Persistent.')
      expect(container.textContent).not.toContain('Remote Resumable.')
    } finally {
      resetProviderChoiceForTests()
    }
  })
})

// ── the paged step ─────────────────────────────────────────────────
describe('WhatsNewV2Step — multi-page showcase', () => {
  it('opens on the summary, with dots and a positional hint', () => {
    render()
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(q('showcase-heading')).toBeNull()
    expect(q('whatsnew-dots')).not.toBeNull()
    // Derived, not hardcoded: 1 summary + one page per flagship.
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${1 + SHOWCASES_21.length}`)
  })

  it('Next pages inward without leaving the run; the last page carries the harness CTA', () => {
    render()
    const cta = () => q('whatsnew-cta')!
    expect(cta().textContent).toContain('Next')
    click(cta()) // -> the first flagship
    expect(nexts).toBe(0)
    expect(q(`showcase-page-${SHOWCASES_21[0].id}`)).not.toBeNull()
    expect(q('showcase-eyebrow')!.textContent).toContain(`1 of ${SHOWCASES_21.length}`)
    for (let i = 1; i < SHOWCASES_21.length; i++) click(cta()) // -> walk to the last
    expect(q(`showcase-page-${SHOWCASES_21[SHOWCASES_21.length - 1].id}`)).not.toBeNull()
    expect(cta().textContent).toBe('Continue')
    expect(q('whatsnew-hint')!.textContent).toBe('Nothing to set up.')
    expect(q('whatsnew-skip'), 'skip duplicates the CTA on the last page').toBeNull()
    expect(nexts).toBe(0)
    click(cta())
    expect(nexts).toBe(1)
  })

  it('a "See it" chip jumps straight to its page', () => {
    render()
    click(q('see-watchdog'))
    expect(q('showcase-page-watchdog')).not.toBeNull()
    const ix = SHOWCASES_21.findIndex((pg: { id: string }) => pg.id === 'watchdog')
    expect(q('showcase-eyebrow')!.textContent).toContain(`${ix + 1} of ${SHOWCASES_21.length}`)
    expect(nexts).toBe(0)
  })

  it('the dots jump anywhere, including back to the summary', () => {
    render()
    click(q('whatsnew-dot-oneRow'))
    expect(q('showcase-page-oneRow')).not.toBeNull()
    click(q('whatsnew-dot-summary'))
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(nexts).toBe(0)
  })

  it('Skip leaves the run from an inner page', () => {
    render()
    click(q('whatsnew-cta')) // -> canvas
    click(q('whatsnew-skip'))
    expect(nexts).toBe(1)
  })

  it('each showcase page draws its vignette', () => {
    render()
    click(q('whatsnew-dot-canvas'))
    expect(q('showcase-art-canvas')).not.toBeNull()
    click(q('whatsnew-dot-watchdog'))
    expect(q('showcase-art-watchdog')).not.toBeNull()
    click(q('whatsnew-dot-oneRow'))
    expect(q('showcase-art-oneRow')).not.toBeNull()
  })

  it('a chip renders ONLY when its showcase page exists — the anti-drift guard', async () => {
    // Serve a page set holding only the canvas page: the summary still carries
    // seeIt ids for watchdog and oneRow, so an unguarded chip would render for
    // pages that cannot be jumped to. Deleting the `showcases.some` guard in
    // WhatsNewV2Step fails this test.
    vi.resetModules()
    vi.doMock('../../../src/renderer/onboarding/showcase-pages', async (importOriginal) => {
      const real: any = await importOriginal()
      return { ...real, showcasesFor: () => real.SHOWCASES_21.filter((p: any) => p.id === 'canvas') }
    })
    try {
      const fresh = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
      act(() => {
        root.render(<fresh.WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="h" />)
      })
      expect(container.querySelector('[data-ux-id="see-canvas"]')).not.toBeNull()
      expect(container.querySelector('[data-ux-id="see-watchdog"]')).toBeNull()
      expect(container.querySelector('[data-ux-id="see-oneRow"]')).toBeNull()
    } finally {
      // resetModules does NOT clear the mock registry — without the unmock a
      // failed assertion above would leak the reduced page set into the next
      // test's fresh import and fail it with a misleading message.
      vi.doUnmock('../../../src/renderer/onboarding/showcase-pages')
      vi.resetModules()
    }
  })

  it('a line with no showcase collapses to the old single-page step', async () => {
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = '2.0.5'
    const fresh = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
    act(() => {
      root.render(<fresh.WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="Nothing to set up." />)
    })
    expect(container.querySelector('[data-ux-id="whatsnew-dots"]')).toBeNull()
    expect(container.querySelector('[data-ux-id="whatsnew-skip"]')).toBeNull()
    const cta = container.querySelector('[data-ux-id="whatsnew-cta"]')!
    expect(cta.textContent).toBe('Continue')
    click(cta)
    expect(nexts).toBe(1)
    ;(globalThis as any).__APP_VERSION__ = '2.1.0-rc.1'
    vi.resetModules()
  })
})

// ── #463: the showcase tours everything since 2.0, for both audiences ──
describe('#463 — since-2.0 coverage and the first-run cohort', () => {
  it('the flagship set covers the full 2.1-over-2.0 story, canvas first', () => {
    const ids = SHOWCASES_21.map((p) => p.id)
    for (const flagship of ['canvas', 'oneRow', 'panel', 'accounts', 'watchdog']) {
      expect(ids, `missing flagship page "${flagship}"`).toContain(flagship)
    }
    expect(ids[0]).toBe('canvas')
  })

  it('no heading or tagline uses upgrade-only diff framing a first-runner cannot parse', () => {
    // "Three rows became one" reads as gibberish to someone who never saw
    // three rows. A tripwire, not a proof: it catches the phrasings that have
    // actually slipped in ("became", "grew", "used to", "no longer", "now X"
    // comparatives) — review still owns the judgment call.
    for (const p of SHOWCASES_21) {
      const copy = `${p.heading} ${p.tagline}`.toLowerCase()
      for (const phrase of ['became', 'grew', 'used to', 'no longer', 'renamed']) {
        expect(copy, `${p.id}: "${phrase}"`).not.toContain(phrase)
      }
    }
  })

  it('every showcase page\'s art kind renders a drawn vignette', () => {
    for (const p of SHOWCASES_21) {
      act(() => { root.render(<ShowcaseVignette kind={p.art} />) })
      expect(
        container.querySelector(`[data-ux-id="showcase-art-${p.art}"]`),
        `no vignette rendered for art kind "${p.art}"`,
      ).toBeTruthy()
    }
  })

  it('the fresh cohort gets an introduction heading and the FULL story, not a diff', () => {
    metaState.meta = {}
    render({ fresh: true })
    // #525: fresh installs open on the rename/roadmap page too, under a
    // "Welcome to" lead-in; the summary sits one Next behind it.
    expect(q('rename-page')).not.toBeNull()
    expect(q('rename-lead-line')!.textContent).toContain('Welcome to')
    expect(q('rename-lead-line')!.textContent).not.toContain('is now')
    click(q('whatsnew-cta'))
    expect(q('whatsnew-heading')!.textContent).toContain("What you're getting")
    expect(q('whatsnew-heading')!.textContent).not.toContain("What's new")
    const text = container.textContent!
    // One item from the 2.0 set and one from the 2.1 set — both present,
    // because a first-runner missed everything.
    expect(text).toContain('Guided setup.')
    expect(text).toContain('Agent Canvas.')
    // ...but a line that only makes sense against a BEFORE stays out.
    expect(text).not.toContain('New name.')
  })

  it('[host] P4.11 (row 54): no line carries a Beta tag, the 2.0 Codex support line included', () => {
    const all = [...sectionsFor(undefined, '2.1.0'), ...sectionsFor(undefined, '2.0.5')].flatMap((s2) => s2.items)
    expect(all.some((it2) => it2.title === 'Codex support.')).toBe(true)
    for (const it2 of all) expect('beta' in it2, it2.title).toBe(false)
  })

  it('no upgrade-only line carries a See-it link — the fresh page count must not desync', () => {
    // The sub-line says "N of them have a page of their own"; an upgradeOnly
    // item with a seeIt would make that true for upgraders and false for the
    // fresh cohort, silently.
    for (const s2 of sectionsFor(undefined, '2.1.0')) {
      for (const it2 of s2.items) {
        expect(!(it2.upgradeOnly && it2.seeIt), `${it2.title} is upgradeOnly with a seeIt`).toBe(true)
      }
    }
  })

  it('the upgrader still sees the upgrade-only lines', () => {
    render()
    expect(container.textContent).toContain('New name.')
  })

  it('an upgrader keeps the diff heading — fresh framing never leaks', () => {
    render()
    expect(q('whatsnew-heading')!.textContent).toContain("What's new in 2.1")
  })
})

// ── #525: the rename/roadmap prelude ──────────────────────────────────
describe('#525 — the rename/roadmap page', () => {
  // A 2.0 stable user: knew the app as Claude Command Center.
  const fromCCC = () => { metaState.meta = { lastSeenVersion: '2.0.5' } }

  it('a 2.0 upgrader opens on the rename page; Next reaches the summary without leaving the run', () => {
    fromCCC()
    render()
    expect(q('rename-page')).not.toBeNull()
    expect(q('rename-lead-line')!.textContent).toContain('is now')
    expect(q('rename-heading')!.textContent).toContain('AI Code Conductor')
    expect(q('whatsnew-heading')).toBeNull()
    // Derived denominator: rename + summary + one page per flagship.
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${2 + SHOWCASES_21.length}`)
    click(q('whatsnew-cta'))
    expect(nexts).toBe(0)
    expect(q('rename-page')).toBeNull()
    expect(q('whatsnew-heading')).not.toBeNull()
  })

  it('the roadmap band names every 2.2 agent, badges the cohorts, and confines 2.2 to itself', () => {
    fromCCC()
    render()
    for (const id of ['tile-claude', 'tile-codex', 'tile-copilot', 'tile-antigravity', 'tile-qwen', 'tile-opencode', 'tile-ollama']) {
      expect(q(id), id).not.toBeNull()
    }
    expect(q('tile-claude')!.textContent).toContain('NOW')
    // P4.11 (row 54): Codex is live like Claude Code, so its tile reads NOW.
    expect(q('tile-codex')!.textContent).toContain('NOW')
    expect(q('tile-codex')!.textContent).not.toContain('BETA')
    expect(q('tile-copilot')!.textContent).toContain('2.2')
    expect(q('roadmap-pill')!.textContent).toContain('2.2 IN DEVELOPMENT')
    // Owner call R5: this is a 2.1 install — the tagline speaks to today,
    // and "2.2" appears only inside the labelled roadmap band.
    expect(q('rename-tagline')!.textContent).not.toContain('2.2')
    // Owner calls R7/R8 (canvas v8): the approved one-liner, the deep strip
    // cut, and exactly one reassurance bullet for upgraders.
    expect(q('rename-tagline')!.textContent).toContain('Same application, exciting new roadmap (tentative preview below).')
    expect(q('rm-deep')).toBeNull()
    expect(q('rename-pt-nothing')!.textContent).toContain('Nothing changes.')
    expect(q('rename-pt-why')).toBeNull()
    expect(q('rename-where')).toBeNull()
  })

  it('stable-channel post-rename upgraders never see it; fresh installs DO, under a Welcome lead-in', () => {
    render() // default meta: 2.1.0-beta.17 — lived through the rename
    expect(q('rename-page')).toBeNull()
    expect(q('whatsnew-dot-rename')).toBeNull()
    // Owner call R1: the roadmap is the introduction — fresh installs get
    // the page too, without the "is now" diff framing.
    metaState.meta = {}
    render({ fresh: true })
    expect(q('rename-page')).not.toBeNull()
    expect(q('rename-lead-line')!.textContent).toContain('Welcome to')
    expect(q('rename-lead-line')!.textContent).not.toContain('is now')
    // Spec-review F1/F2: no "Same application" without a before, and no
    // carry-over bullet for someone with nothing to carry over.
    expect(q('rename-tagline')!.textContent).toBe('Exciting new roadmap (tentative preview below).')
    expect(q('rename-tagline')!.textContent).not.toContain('Same application')
    expect(q('rename-points')).toBeNull()
  })

  it('a See-it chip still lands on its page with the prelude in front', () => {
    fromCCC()
    render()
    click(q('whatsnew-cta')) // -> summary
    click(q('see-watchdog'))
    expect(q('showcase-page-watchdog')).not.toBeNull()
    const ix = SHOWCASES_21.findIndex((pg: { id: string }) => pg.id === 'watchdog')
    expect(q('showcase-eyebrow')!.textContent).toContain(`${ix + 1} of ${SHOWCASES_21.length}`)
  })

  it('the dots gain a rename dot that jumps home, and the walk ends on the harness CTA', () => {
    fromCCC()
    render()
    click(q('whatsnew-dot-oneRow'))
    expect(q('showcase-page-oneRow')).not.toBeNull()
    click(q('whatsnew-dot-rename'))
    expect(q('rename-page')).not.toBeNull()
    const cta = () => q('whatsnew-cta')!
    for (let i = 0; i < 1 + SHOWCASES_21.length; i++) click(cta()) // rename -> summary -> ... -> last flagship
    expect(cta().textContent).toBe('Continue')
    expect(nexts).toBe(0)
    click(cta())
    expect(nexts).toBe(1)
  })

  it('the 2.0 line never shows the page for either cohort', async () => {
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = '2.0.5'
    const fresh = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
    metaState.meta = {}
    act(() => {
      root.render(<fresh.WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="h" fresh />)
    })
    expect(container.querySelector('[data-ux-id="rename-page"]')).toBeNull()
    ;(globalThis as any).__APP_VERSION__ = '2.1.0-rc.1'
    vi.resetModules()
  })

  it('showRenamePageFor — the upgrader gate in one place', () => {
    expect(showRenamePageFor(undefined, '2.1.0')).toBe(false) // fresh installs are gated by `fresh`
    expect(showRenamePageFor('2.0.5', '2.1.0')).toBe(true)
    expect(showRenamePageFor('1.9.0', '2.1.0')).toBe(true)
    expect(showRenamePageFor('2.1.0-beta.5', '2.1.0')).toBe(true) // pre-rename beta tester
    expect(showRenamePageFor('2.1.0-beta.6', '2.1.0')).toBe(false) // the rename build itself
    expect(showRenamePageFor('2.1.0-beta.17', '2.1.0')).toBe(false)
    expect(showRenamePageFor('2.0.1', '2.0.5')).toBe(false) // a 2.0-line build predates the rename
    expect(showRenamePageFor('2.0.5', '2.2.0')).toBe(true) // straight 2.0 -> 2.2 is still owed the why
  })

  it('showRenamePageFor — beta-channel testers see it on every prerelease (owner call, canvas R2)', () => {
    const beta = { channel: 'beta' }
    // Post-rename tester on an rc: the cohort gate would hide it; the tester arm shows it.
    expect(showRenamePageFor('2.1.0-rc.4', '2.1.0-rc.5', beta)).toBe(true)
    expect(showRenamePageFor('2.1.0-beta.17', '2.1.0-beta.18', beta)).toBe(true)
    // Stable build: testers rejoin the ordinary cohort gate the moment the suffix drops.
    expect(showRenamePageFor('2.1.0-rc.5', '2.1.0', beta)).toBe(false)
    // Stable channel is untouched by the arm.
    expect(showRenamePageFor('2.1.0-rc.4', '2.1.0-rc.5', { channel: 'stable' })).toBe(false)
    expect(showRenamePageFor('2.1.0-rc.4', '2.1.0-rc.5')).toBe(false)
    // The 2.0-line guard still wins over the tester arm.
    expect(showRenamePageFor('2.0.1', '2.0.5-beta.1', beta)).toBe(false)
    // Fresh installs stay gated by `fresh`, tester arm or not.
    expect(showRenamePageFor(undefined, '2.1.0-rc.5', beta)).toBe(false)
  })

  it('beta-channel prerelease build opens on the rename page for a post-rename upgrader', async () => {
    settingsState.settings = { updateChannel: 'beta' } // build is 2.1.0-rc.1, lastSeen beta.17
    await act(async () => {
      root.render(<WhatsNewV2Step onNext={() => { nexts += 1 }} />)
    })
    expect(container.querySelector('[data-ux-id="rename-page"]')).not.toBeNull()
  })
})
