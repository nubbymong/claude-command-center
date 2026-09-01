// @vitest-environment jsdom
//
// Canvas Explained (M4, W33/W46): the front page's card opens a full explainer
// of the review model. These pin the page's contract: the five sections and
// their headings, the header back control, the owner-agreed copy rules (speaks
// in "artefact", the never-loses-notes caption, the two W46 terminology
// sentences in place rather than in a glossary), no raw internal ids in copy,
// and accessible diagrams (every SVG either labelled or explicitly
// decorative). The training step and app-knowledge section that ship with the
// page are checked in the same file because the three land as one unit.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import CanvasExplainedPage from '../../../src/renderer/components/CanvasExplainedPage'
import FeatureGuidePage from '../../../src/renderer/components/FeatureGuidePage'
import { APP_KNOWLEDGE_SECTIONS } from '../../../src/shared/app-knowledge'
import { trainingSteps, SECTION_LABELS } from '../../../src/renderer/training-steps'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const onHome = vi.fn()

function render(): void {
  act(() => {
    root.render(<CanvasExplainedPage onHome={onHome} />)
  })
}

beforeEach(() => {
  onHome.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('CanvasExplainedPage', () => {
  it('renders all five sections with their headings', () => {
    render()
    const h1 = container.querySelector('h1')
    expect(h1?.textContent).toBe('How the Canvas works')
    const h2s = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)
    expect(h2s).toEqual(['The artefact', 'Mockup', 'Plan', 'Testing'])
    // Each mode section is a real <section> named by its heading, not a div pile.
    expect(container.querySelectorAll('section[aria-labelledby]')).toHaveLength(4)
  })

  it('fires onHome from the header back control', () => {
    render()
    const back = container.querySelector('[data-testid="canvas-explained-home"]')
    expect(back).toBeTruthy()
    expect(back!.textContent).toContain('Home')
    act(() => {
      back!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onHome).toHaveBeenCalledTimes(1)
  })

  it('keeps the owner-agreed copy: artefact spelling, the never-loses caption, and both W46 terminology sentences in place', () => {
    render()
    const text = container.textContent ?? ''
    // The surface speaks in "artefact" — the ae spelling is the agreed voice.
    expect(text).toContain('artefact')
    expect(text.toLowerCase()).not.toContain('artifact')
    // The storage guarantee stays, verbatim.
    expect(text).toContain('Rejecting a version never loses them')
    // W46: one sentence per term, inside the anatomy prose (no glossary section).
    expect(text).toMatch(/resolved once the agent has acted on it/)
    expect(text).toMatch(/settled once every note in it is closed/)
    expect(text).not.toMatch(/glossary/i)
  })

  it('draws the PLAN loop with the shipped model: Submit Revisions, no Reject, Approve gated on open questions', () => {
    // The page shipped a plan loop offering "Reject — plan v2 answers your
    // notes", which the plan review panel does not have and never did:
    // decisionLabels() returns 'Submit Revisions' for mode 'plan', and
    // planApproveBlock() holds Approve back while a question is open or a note
    // is unsent. A user following the Feature Guide to this page met a diagram
    // that disagreed with the buttons in front of them.
    render()
    const plan = container.querySelector('section[aria-labelledby="cxp-plan"]')
    expect(plan, 'the Plan section is named by its heading id').toBeTruthy()
    const text = plan!.textContent ?? ''

    // The back arc carries the plan's own word for sending a version back, and
    // the button that does not exist on a plan is offered nowhere on the
    // diagram itself, in any casing — not on the arc, not inside a node.
    expect(text).toContain('Submit Revisions')
    const visible = text.replace(/Plan loop:[^]*/g, '')
    expect(visible).not.toMatch(/reject/i)

    // The accessible name is the one place the word may appear, because saying
    // the affordance is ABSENT is exactly what a screen-reader user needs.
    const planAria = Array.from(plan!.querySelectorAll('svg[role="img"]'))
      .map((s) => s.getAttribute('aria-label') ?? '')
    expect(planAria.length, 'both orientations render').toBe(2)
    for (const label of planAria) {
      expect(label).toMatch(/no Reject on a plan/i)
      expect(label).toMatch(/submit revisions/i)
    }

    // The approval gate is drawn, not merely implied by the arrow.
    expect(text).toContain('Approve blocked while one is open')

    // Guard the other direction: a mockup DOES reject, so a change that simply
    // deletes the word everywhere cannot pass this test.
    const mockup = container.querySelector('section[aria-labelledby="cxp-mockup"]')
    expect(mockup!.textContent ?? '').toMatch(/Reject/)
  })

  it('shows the Testing evidence record with its parts, including the never-what-you-typed state rule', () => {
    render()
    const evidence = container.querySelector('[data-testid="canvas-explained-evidence"]')
    expect(evidence).toBeTruthy()
    const text = evidence!.textContent ?? ''
    expect(text).toContain('screenshot + your drawings')
    expect(text).toContain('never what you typed')
    expect(text).toContain('route /checkout')
    expect(text).toContain('how you got here')
    expect(text).toContain('your words')
    expect(text).toContain('Image 1, 2')
  })

  it('never leaks raw annotation/review ids into the copy', () => {
    render()
    // a1/R1-style ids are storage keys, not language a user should meet.
    // Versions (v1, v2 …) and "Review #1" are the product's own vocabulary
    // and deliberately excluded from the pattern.
    expect(container.textContent ?? '').not.toMatch(/\b(?:a|R)\d+\b/)
  })

  it('gives every SVG an aria-label (as role="img") or marks it decorative', () => {
    render()
    const svgs = Array.from(container.querySelectorAll('svg'))
    expect(svgs.length).toBeGreaterThan(0)
    for (const svg of svgs) {
      const hidden = svg.getAttribute('aria-hidden') === 'true'
      const label = svg.getAttribute('aria-label')
      const labelled = svg.getAttribute('role') === 'img' && !!label && label.length > 0
      expect(hidden || labelled, `svg without aria-hidden or role=img+aria-label: ${svg.outerHTML.slice(0, 120)}`).toBe(true)
    }
    // The four diagrams (rail + three loops) each render two labelled
    // orientations — the narrow variant is the same diagram, so it carries
    // the same accessible name, never a second one.
    const labelled = svgs.filter((s) => s.getAttribute('role') === 'img')
    expect(labelled).toHaveLength(8)
    expect(new Set(labelled.map((s) => s.getAttribute('aria-label'))).size).toBe(4)
  })
})

describe('app-knowledge: the canvas review model section', () => {
  const section = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'canvas-review-model')

  it('exists and covers the agreed ground in user words', () => {
    expect(section).toBeTruthy()
    const body = section!.body
    expect(body).toContain('artefact')
    expect(body).toContain('version')
    // Reworded at the rc.10 surface sweep. "owes you nothing" read as a claim
    // about the USER; the promise the state machine actually makes is about the
    // AGENT -- notes sent with an approval are recorded as observations rather
    // than work. Both halves are asserted so the sentence cannot lose one.
    expect(body).toContain('owes the agent nothing')
    expect(body).toContain('observations')
    expect(body).toContain('test pack')
    expect(body).toContain('resume')
  })

  it('honours the file rule: no em (or en) dashes anywhere in the knowledge', () => {
    // The rule is on the whole file (public-facing doc); asserting all bodies
    // keeps the next section honest too, not just this one.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.body, `em/en dash in app-knowledge section '${s.id}'`).not.toMatch(/[–—]/)
      expect(s.title, `em/en dash in app-knowledge title '${s.id}'`).not.toMatch(/[–—]/)
    }
  })
})

describe('training step: canvas-explained', () => {
  const step = trainingSteps.find((s) => s.id === 'canvas-explained')

  it('is well-formed: unique id, valid section, screenshot present, rc.10 version', () => {
    expect(step).toBeTruthy()
    expect(trainingSteps.filter((s) => s.id === 'canvas-explained')).toHaveLength(1)
    expect(step!.section && step!.section in SECTION_LABELS).toBe(true)
    // The file's convention is a real screenshot on every step (a stand-in
    // from the nearest surface when no dedicated capture exists yet).
    expect(typeof step!.screenshotFilename).toBe('string')
    expect(step!.screenshotFilename.length).toBeGreaterThan(0)
    expect(step!.sinceVersion).toBe('2.1.0-rc.10')
  })

  it('names BOTH routes in: the front-page card and the guide embed', () => {
    const triggers = (step!.howToTrigger ?? []).map((t) => t.value).join(' ')
    expect(triggers).toContain('Canvas Explained card')
    expect(triggers).toContain('View Canvas Explained')
  })
})

// ── The alternate route (owner request): the guide EMBEDS the page ───────────
// The front-page card exists only inside an open session's canvas pane; the
// Feature Guide is global and must open the same page with zero sessions open.
describe('FeatureGuidePage: alternate route into Canvas Explained', () => {
  const onNavigateToSessions = vi.fn()
  const onStartTour = vi.fn()

  function renderGuide(): void {
    act(() => {
      root.render(<FeatureGuidePage onNavigateToSessions={onNavigateToSessions} onStartTour={onStartTour} />)
    })
  }

  function click(el: Element | null): void {
    expect(el, 'expected element to click').toBeTruthy()
    act(() => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('offers View Canvas Explained on the canvas-explained card', () => {
    renderGuide()
    click(container.querySelector('[data-ux-id="rail-integrations"]'))
    const card = container.querySelector('[data-ux-id="card-canvas-explained"]')
    expect(card).toBeTruthy()
    const affordance = card!.querySelector('[data-ux-id="view-canvas-explained"]')
    expect(affordance).toBeTruthy()
    expect(affordance!.textContent).toBe('View Canvas Explained')
    // Only that card carries the door — it is a route, not a card decoration.
    expect(container.querySelectorAll('[data-ux-id="view-canvas-explained"]')).toHaveLength(1)
  })

  it('clicking it swaps the content area to the Explained page while the rail stays', () => {
    renderGuide()
    click(container.querySelector('[data-ux-id="rail-integrations"]'))
    click(container.querySelector('[data-ux-id="view-canvas-explained"]'))
    expect(container.querySelector('[data-testid="canvas-explained-page"]')).toBeTruthy()
    const h2s = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)
    expect(h2s).toContain('The artefact')
    // An embed, not a navigation away: the guide's rail is still there.
    expect(container.querySelector('[data-ux-id="rail"]')).toBeTruthy()
    expect(container.querySelector('[data-ux-id="card-canvas-explained"]')).toBeNull()
  })

  it('the Explained page’s Home control returns to the guide card list', () => {
    renderGuide()
    click(container.querySelector('[data-ux-id="rail-integrations"]'))
    click(container.querySelector('[data-ux-id="view-canvas-explained"]'))
    click(container.querySelector('[data-testid="canvas-explained-home"]'))
    expect(container.querySelector('[data-testid="canvas-explained-page"]')).toBeNull()
    expect(container.querySelector('[data-ux-id="card-canvas-explained"]')).toBeTruthy()
    // The embed never rides the session-navigation callbacks.
    expect(onNavigateToSessions).not.toHaveBeenCalled()
    expect(onStartTour).not.toHaveBeenCalled()
  })

  it('search outranks the open embed, and clearing the query returns to it', () => {
    renderGuide()
    click(container.querySelector('[data-ux-id="rail-integrations"]'))
    click(container.querySelector('[data-ux-id="view-canvas-explained"]'))
    expect(container.querySelector('[data-testid="canvas-explained-page"]')).toBeTruthy()

    // Type into the header search — React reads controlled-input changes off
    // the native `input` event, so set the value via the prototype setter.
    const search = container.querySelector('[data-ux-id="search"]') as HTMLInputElement
    expect(search).toBeTruthy()
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(search, 'canvas')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Typing must always show results: the embed yields to search…
    expect(container.querySelector('[data-testid="canvas-explained-page"]')).toBeNull()
    expect(container.querySelector('[data-ux-id="card-canvas-explained"]')).toBeTruthy()

    // …and clearing the query hands the content area back to the embed.
    click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Clear') ?? null)
    expect(container.querySelector('[data-testid="canvas-explained-page"]')).toBeTruthy()
  })

  it('a rail click while the Explained page is open closes it instead of going dead', () => {
    renderGuide()
    click(container.querySelector('[data-ux-id="rail-integrations"]'))
    click(container.querySelector('[data-ux-id="view-canvas-explained"]'))
    click(container.querySelector('[data-ux-id="rail-getting-started"]'))
    expect(container.querySelector('[data-testid="canvas-explained-page"]')).toBeNull()
    expect(container.querySelector('[data-ux-id="card-session-options"]')).toBeTruthy()
  })
})
