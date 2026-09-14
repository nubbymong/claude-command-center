// @vitest-environment jsdom
//
// The PLAN review state machine (owner spec, 2026-08-31).
//
// A plan is iterative, so it has no Reject: the buttons are Approve and Submit
// Revisions. Approve is the exceptional one — it means "this is perfect", so it
// is unavailable while the plan still asks a question, and unavailable the
// moment the user has anything to say. Answers travel back as revisions; the
// NEXT version, written knowing them, is the one that can be approved.
//
// Every gate here is asserted in both directions — blocked, then unblocked by
// the one fact that is supposed to unblock it — because a gate that cannot be
// shown to open is indistinguishable from a broken button.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

import { paneSketchProps } from './canvas-panel-harness'
const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { planApproveBlock, decisionLabels, deliverAgentMarker } = await import('../../../src/renderer/components/CanvasNotesPanel')
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const CID = 'canvas-a'

const plan = (over: Partial<CanvasVersion> = {}): CanvasVersion =>
  ({
    id: 'v3',
    mode: 'plan',
    createdAt: '2026-08-31T10:00:00Z',
    source: { mode: 'design', entry: 'index.html' },
    ...over,
  }) as CanvasVersion

const mockup = (over: Partial<CanvasVersion> = {}): CanvasVersion =>
  ({ ...plan(over), mode: 'design' }) as CanvasVersion

function draftState(canvasId: string, noteTexts: string[], versionId = 'v3'): CanvasReviewState {
  const reviews: Review[] = []
  const annotations: Annotation[] = []
  if (noteTexts.length > 0) {
    reviews.push({
      id: 'R1',
      canvas: { canvasId, versionId } as Review['canvas'],
      versionId,
      annotationIds: noteTexts.map((_, i) => `a${i + 1}`),
      status: 'draft',
      createdAt: '2026-08-31T10:05:00Z',
    })
    noteTexts.forEach((text, i) => {
      annotations.push({ id: `a${i + 1}`, reviewId: 'R1', scope: 'general', note: text, versionId, state: 'open' })
    })
  }
  return { canvasId, sessionId: SID, reviews, annotations }
}

let current: CanvasReviewState = draftState(CID, [])
const versionVerdict = vi.fn(async () => ({ canvasId: CID }))
const reviewSubmit = vi.fn(async () => ({ id: 'R1', annotationIds: ['a1'] }))

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => current),
    versionVerdict,
    reviewSubmit,
  },
}

let container: HTMLDivElement
let root: Root

async function render(version: CanvasVersion): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel
        sessionId={SID}
        version={version}
        getGlassApi={() => null}
        onReturnToTerminal={() => {}}
        {...paneSketchProps()}
        canvasId={CID}
        isActive={false}
      />,
    )
  })
}

/** Push a new mirror state into the store the way a refresh would, without
 *  re-mounting: the panel has to react to notes arriving, not to a fresh mount. */
async function pushNotes(noteTexts: string[]): Promise<void> {
  current = draftState(CID, noteTexts)
  await act(async () => {
    useCanvasReviewStore.setState((s) => ({
      bySessionId: { ...s.bySessionId, [SID]: { ...s.bySessionId[SID], ...current } },
    }))
  })
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const approve = () => q('decision-approve') as HTMLButtonElement
const revise = () => q('decision-reject') as HTMLButtonElement
const submit = () => q('canvas-submit') as HTMLButtonElement

beforeEach(() => {
  current = draftState(CID, [])
  versionVerdict.mockClear()
  reviewSubmit.mockClear()
  useCanvasReviewStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

// ── The rule, as a function ─────────────────────────────────────────────────

describe('planApproveBlock', () => {
  it('is null for a clean plan — Approve is available', () => {
    expect(planApproveBlock(plan(), 0)).toBeNull()
    expect(planApproveBlock(plan({ openQuestions: 0 }), 0)).toBeNull()
  })

  it('blocks on an open question, and says how many', () => {
    expect(planApproveBlock(plan({ openQuestions: 1 }), 0)).toContain('1 open question')
    expect(planApproveBlock(plan({ openQuestions: 3 }), 0)).toContain('3 open questions')
  })

  it('blocks on any note at all', () => {
    expect(planApproveBlock(plan(), 1)).toContain('1 note')
    expect(planApproveBlock(plan(), 4)).toContain('4 notes')
  })

  it('names the QUESTION first when both stand — it is the one the user cannot clear', () => {
    expect(planApproveBlock(plan({ openQuestions: 2 }), 5)).toContain('open questions')
  })

  it('governs plans ONLY — a mockup still approves with observations', () => {
    expect(planApproveBlock(mockup({ openQuestions: 3 }), 4)).toBeNull()
    expect(planApproveBlock({ ...mockup(), mode: 'uat' } as CanvasVersion, 4)).toBeNull()
  })
})

// ── The buttons ─────────────────────────────────────────────────────────────

describe('the plan decision bar', () => {
  it('offers Approve and Submit Revisions — never Reject', async () => {
    await render(plan())
    expect(decisionLabels(plan()).reject).toBe('Submit Revisions')
    expect(revise().textContent).toBe('Submit Revisions')
    expect(container.textContent).not.toContain('Reject')
  })

  it('leaves Approve live on a clean plan, and files the verdict', async () => {
    await render(plan())
    expect(approve().disabled).toBe(false)
    expect(q('canvas-approve-blocked')).toBeNull()
    act(() => approve().click())
    expect(submit().disabled).toBe(false)
    await act(async () => {
      submit().click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(versionVerdict).toHaveBeenCalledWith({ sessionId: SID, versionId: 'v3', state: 'approved' })
  })
})

describe('gate 1 — an open question', () => {
  it('kills Approve and says why', async () => {
    await render(plan({ openQuestions: 2 }))
    expect(approve().disabled).toBe(true)
    expect(q('canvas-approve-blocked')!.textContent).toContain('2 open questions')
  })

  it('does not touch Submit Revisions — answering IS the revision', async () => {
    await render(plan({ openQuestions: 2 }))
    await pushNotes(['Q1: use the ladder. Q2: no.'])
    act(() => revise().click())
    expect(submit().disabled).toBe(false)
    expect(submit().textContent).toBe('Submit revisions — 1 note')
  })

  it('a NEW VERSION with no open questions is what unlocks Approve', async () => {
    await render(plan({ openQuestions: 2 }))
    expect(approve().disabled).toBe(true)
    // The agent answers them and renders v4. Same panel, new version.
    await render(plan({ id: 'v4' }))
    expect(approve().disabled).toBe(false)
    expect(q('canvas-approve-blocked')).toBeNull()
  })

  it('comes back when the revision raises NEW questions', async () => {
    await render(plan({ id: 'v4' }))
    expect(approve().disabled).toBe(false)
    await render(plan({ id: 'v5', openQuestions: 1 }))
    expect(approve().disabled).toBe(true)
    expect(q('canvas-approve-blocked')!.textContent).toContain('1 open question')
  })
})

describe('gate 2 — any note', () => {
  it('kills Approve the moment a note exists', async () => {
    await render(plan())
    expect(approve().disabled).toBe(false)
    await pushNotes(['phase 3 is too big'])
    expect(approve().disabled).toBe(true)
    expect(q('canvas-approve-blocked')!.textContent).toContain('1 note')
  })

  it('disarms an ALREADY-ARMED Approve rather than leaving a decision the user cannot file', async () => {
    await render(plan())
    act(() => approve().click())
    expect(submit().textContent).toBe('Submit — Approve plan')
    await pushNotes(['actually, phase 3 is too big'])
    // The decision is gone, not merely un-submittable.
    expect(submit().disabled).toBe(true)
    expect(submit().textContent).toBe('Submit')
    expect(approve().disabled).toBe(true)
  })

  it('re-opens when the note goes away', async () => {
    await render(plan())
    await pushNotes(['phase 3 is too big'])
    expect(approve().disabled).toBe(true)
    await pushNotes([])
    expect(approve().disabled).toBe(false)
    expect(q('canvas-approve-blocked')).toBeNull()
  })

  it('never offers the observations line — a plan note is not an observation', async () => {
    await render(plan())
    await pushNotes(['phase 3 is too big'])
    expect(q('canvas-approve-observations-warning')).toBeNull()
  })

  it('leaves a MOCKUP alone: Approve with notes still files observations', async () => {
    await render(mockup())
    await pushNotes(['the tagline is off'])
    expect(approve().disabled).toBe(false)
    act(() => approve().click())
    expect(q('canvas-approve-observations-warning')).not.toBeNull()
    expect(submit().disabled).toBe(false)
  })
})

describe('the revision words', () => {
  it('asks for a note before it will send revisions, in the plan`s own words', async () => {
    await render(plan())
    act(() => revise().click())
    expect(submit().disabled).toBe(true)
    expect(q('reject-needs-note')!.textContent).toContain('Revisions need a note')
  })

  it('a settled plan round reads REVISIONS, never REJECTED — the badge`s own word', async () => {
    const { roundOutcomeLabel } = await import('../../../src/renderer/components/CanvasNotesPanel')
    const { verdictLabel } = await import('../../../src/shared/canvas')
    const group = {
      review: { id: 'R1', versionId: 'v3', decision: 'reject' as const },
      closedNotes: [],
    } as never
    expect(roundOutcomeLabel(group, [plan()])).toBe('REVISIONS')
    expect(roundOutcomeLabel(group, [mockup()])).toBe('REJECTED')
    // One fact, one word: the panel row and the History/Library badge agree.
    const rejected = { verdict: { state: 'rejected' as const, by: 'user' as const, at: 'x' } }
    expect(roundOutcomeLabel(group, [plan()])).toBe(verdictLabel(plan(rejected)))
    expect(roundOutcomeLabel(group, [mockup()])).toBe(verdictLabel(mockup(rejected)))
  })

  it('a closed plan version says it went back for revisions', async () => {
    await render(plan({ verdict: { state: 'rejected', by: 'user', at: '2026-08-31T11:00:00Z' } }))
    const line = q('canvas-version-closed-line')!.textContent ?? ''
    expect(line).toContain('went back for revisions')
    expect(line).not.toContain('rejected')
  })
})

// ── Phase 7 item C — Submit vs Submit Revisions hierarchy ────────────────────
//
// Live report: users could not tell which of the plan bar's three buttons was
// actionable. A dead dark "Submit" sat under a live red "Submit Revisions" and
// a blocked "Approve" whose reason was in a `title` that a disabled button can
// never display. So: the dead ones must LOOK dead (no borrowed status colour,
// dashed edge, aria-disabled), the reason must be reachable (wrapper title +
// an on-surface line), and the one live control must read as the primary.

describe('the actionable button is unmistakable', () => {
  const approveWrap = () => q('decision-approve-wrap')!
  const submitWrap = () => q('canvas-submit-wrap')!

  it('a blocked Approve wears the dead recipe, not a dimmed green', async () => {
    await render(plan({ openQuestions: 1 }))
    expect(approve().disabled).toBe(true)
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(approve().dataset.blocked).toBe('true')
    expect(approve().style.borderStyle).toBe('dashed')
    expect(approve().style.color).toContain('--text-muted')
    expect(approve().style.background).toBe('transparent')
  })

  it('the reason a blocked Approve is dead is REACHABLE — on the wrapper, which can be hovered', async () => {
    await render(plan({ openQuestions: 2 }))
    // The title cannot live on the button: a disabled button swallows the
    // hover, so the tooltip never opens. It rides the wrapper instead.
    expect(approveWrap().getAttribute('title')).toContain('2 open questions')
    expect(approve().getAttribute('title')).toBeNull()
  })

  it('Submit Revisions is promoted to THE primary while it is the only live move', async () => {
    await render(plan({ openQuestions: 1 }))
    expect(revise().dataset.primary).toBe('true')
    expect(revise().style.background).toContain('--color-red')
    expect(revise().style.boxShadow).toContain('--color-red')
    expect(revise().getAttribute('title')).toContain('Submit Revisions')
  })

  it('...and demoted again once a decision is picked, or once Approve is live', async () => {
    await render(plan({ openQuestions: 1 }))
    expect(revise().dataset.primary).toBe('true')
    act(() => revise().click())
    // Picked: it is now the solid selected fill, not the promoted outline.
    expect(revise().dataset.primary).toBeUndefined()
    // A clean plan needs no promotion — Approve is available, so there is a
    // real choice and neither side may shout.
    await render(plan({ id: 'v4' }))
    expect(revise().dataset.primary).toBeUndefined()
    expect(approve().disabled).toBe(false)
  })

  it('a dead Submit is legibly dead and says why, in the tooltip AND on the surface', async () => {
    await render(plan({ openQuestions: 1 }))
    expect(submit().disabled).toBe(true)
    expect(submit().getAttribute('aria-disabled')).toBe('true')
    expect(submit().dataset.blocked).toBe('true')
    expect(submit().style.borderStyle).toBe('dashed')
    // Never a dimmed green/red: a disabled control must not borrow the colour
    // that means "this one".
    expect(submit().style.background).toBe('transparent')
    expect(submitWrap().getAttribute('title')).toBe('Choose Approve or Submit Revisions first')
    expect(q('canvas-submit-blocked')!.textContent).toContain('Choose Approve or Submit Revisions first')
  })

  it('a LIVE Submit keeps its filled colour and loses the blocked line', async () => {
    await render(plan())
    act(() => approve().click())
    expect(submit().disabled).toBe(false)
    expect(submit().getAttribute('aria-disabled')).toBeNull()
    expect(submit().style.background).toContain('--color-green')
    expect(submit().style.borderStyle).not.toBe('dashed')
    expect(q('canvas-submit-blocked')).toBeNull()
    expect(submitWrap().getAttribute('title')).toBe('Send this review to the agent')
  })

  it('does not double up: the note gate speaks once, not twice', async () => {
    await render(plan())
    act(() => revise().click())
    expect(q('reject-needs-note')).not.toBeNull()
    expect(q('canvas-submit-blocked')).toBeNull()
  })

  it('the handlers and testids survive the restyle', async () => {
    await render(plan())
    act(() => approve().click())
    expect(submit().textContent).toBe('Submit — Approve plan')
    act(() => approve().click())
    expect(submit().textContent).toBe('Submit')
    act(() => revise().click())
    expect(submit().textContent).toBe('Submit revisions — 0 notes')
  })
})

// ── Phase 7 item E (#580) — the marker must not be written blind at the PTY ──
//
// Live: a clean APPROVAL filed while the agent was mid-turn delivered NOTHING.
// The panel wrote the marker straight into the terminal, which Claude Code is
// not reading while it streams. A clean approval creates no review record for
// canvas_review to fetch either, so the marker IS the whole delivery.

describe('the agent marker leaves through the queue', () => {
  it('a clean approval sends its marker via canvas.agentMarker, not pty.write', async () => {
    const agentMarker = vi.fn(async () => ({ delivery: 'queued' as const }))
    const api = (globalThis as any).window.electronAPI
    api.canvas.agentMarker = agentMarker
    api.pty.write.mockClear()

    await render(plan())
    act(() => approve().click())
    await act(async () => {
      submit().click()
      await new Promise((r) => setTimeout(r, 0))
    })

    // The CANVAS rides the marker (adversarial review, 2026-09-01): main refuses
    // a marker whose session does not own the named canvas, and it can only ask
    // that question if the payload names one. Mutation to prove this can fail:
    // drop `canvasId` from the deliverAgentMarker call in CanvasNotesPanel.
    expect(agentMarker).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: CID,
      line: 'Approved v3 on the canvas · canvas_version_verdict recorded',
    })
    // No CR: what travels is a LINE. Main appends the submit key, so the queue
    // holds messages rather than keystrokes.
    expect(agentMarker.mock.calls[0][0].line).not.toContain('\r')
    expect(api.pty.write).not.toHaveBeenCalled()
    delete api.canvas.agentMarker
  })

  it('never throws, and never leaves an unhandled rejection, if delivery fails', async () => {
    const api = (globalThis as any).window.electronAPI
    api.canvas.agentMarker = vi.fn(async () => { throw new Error('IPC gone') })
    expect(() => deliverAgentMarker(SID, CID, 'anything')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    delete api.canvas.agentMarker
  })

  it('falls back to the pre-#580 direct write when the channel is absent', async () => {
    const api = (globalThis as any).window.electronAPI
    delete api.canvas.agentMarker
    api.pty.write.mockClear()
    deliverAgentMarker(SID, CID, 'Review #1 — 1 notes · canvas_review R1')
    expect(api.pty.write).toHaveBeenCalledWith(SID, 'Review #1 — 1 notes · canvas_review R1\r')
  })
})
