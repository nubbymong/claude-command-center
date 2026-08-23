// @vitest-environment jsdom
//
// The renderer review store's pure half: the focus ladder (lock → expand →
// clear), region focus, and the derivations the panel builds its sections
// from. The IPC-backed actions are exercised through the main store's own
// suite; here the electronAPI surface is a stub that must never be reached.

import { describe, it, expect, beforeEach } from 'vitest'
import type { Annotation, CanvasInspectEntry, Review } from '../../../src/shared/canvas'
import {
  draftAnnotationsOf,
  draftReviewOf,
  focusFromEntry,
  labelForEntry,
  openSubmittedNotesOf,
  useCanvasReviewStore,
} from '../../../src/renderer/stores/canvasReviewStore'

const SID = 'session-1'

function entry(overrides: Partial<CanvasInspectEntry> = {}): CanvasInspectEntry {
  return {
    role: 'button',
    name: 'Save',
    tag: 'button',
    box: { x: 10, y: 20, width: 100, height: 30 },
    fingerprint: { role: 'button', name: 'Save', ancestorPath: 'main>form', ordinal: 0 },
    ...overrides,
  }
}

beforeEach(() => {
  useCanvasReviewStore.getState().reset()
})

describe('focus construction', () => {
  it('puts the ux-id anchor ahead of the fingerprint, and skips it when absent', () => {
    const withId = focusFromEntry(entry({ uxId: 'save-btn' }), 'v2')
    expect(withId.targets.map((t) => t.kind)).toEqual(['ux-id', 'fingerprint'])
    expect(withId.label).toBe('button "Save"')
    expect(withId.versionId).toBe('v2')

    const withoutId = focusFromEntry(entry(), 'v2')
    expect(withoutId.targets.map((t) => t.kind)).toEqual(['fingerprint'])
  })

  it('labels a nameless entry by role or tag and bounds the label', () => {
    expect(labelForEntry(entry({ name: '' }))).toBe('button')
    expect(labelForEntry(entry({ role: '', name: '', tag: 'div' }))).toBe('div')
    expect(labelForEntry(entry({ name: 'x'.repeat(500) })).length).toBeLessThanOrEqual(120)
  })
})

describe('updateFocusBox (#368) — re-pointing the live lock after a zoom reflow', () => {
  it('moves ONLY the box, and only while the exact lock it was resolved for still stands', () => {
    const store = useCanvasReviewStore.getState()
    store.lockFocus(SID, [entry()], 'v3')
    const locked = useCanvasReviewStore.getState().bySessionId[SID].focus!

    store.updateFocusBox(SID, locked, { x: 5, y: 6, width: 70, height: 20 })
    const moved = useCanvasReviewStore.getState().bySessionId[SID].focus!
    expect(moved.bboxPage).toEqual({ x: 5, y: 6, width: 70, height: 20 })
    expect(moved.label).toBe(locked.label)
    expect(moved.targets).toBe(locked.targets)

    // The user re-locked while the resolve was in flight: the stale answer is
    // a claim about the OLD lock and must not land on the new one.
    store.lockFocus(SID, [entry({ name: 'Cancel' })], 'v3')
    const relocked = useCanvasReviewStore.getState().bySessionId[SID].focus!
    store.updateFocusBox(SID, moved, { x: 999, y: 999, width: 1, height: 1 })
    expect(useCanvasReviewStore.getState().bySessionId[SID].focus).toBe(relocked)

    // A cleared lock is not resurrected by a late answer.
    store.clearFocus(SID)
    store.updateFocusBox(SID, relocked, { x: 1, y: 1, width: 1, height: 1 })
    expect(useCanvasReviewStore.getState().bySessionId[SID].focus).toBeNull()
  })
})

describe('the focus ladder', () => {
  it('locks the deepest entry, expands one parent per step, and stops at the top', () => {
    const chain = [entry({ name: 'Save' }), entry({ role: 'form', name: '' }), entry({ role: 'main', name: '' })]
    const store = useCanvasReviewStore.getState()
    store.lockFocus(SID, chain, 'v3')

    let s = useCanvasReviewStore.getState().bySessionId[SID]
    expect(s.focus?.label).toBe('button "Save"')
    expect(s.focusChainIndex).toBe(0)

    store.expandFocus(SID)
    s = useCanvasReviewStore.getState().bySessionId[SID]
    expect(s.focus?.label).toBe('form')
    expect(s.focusChainIndex).toBe(1)

    store.expandFocus(SID)
    store.expandFocus(SID) // past the top: stays
    s = useCanvasReviewStore.getState().bySessionId[SID]
    expect(s.focus?.label).toBe('main')
    expect(s.focusChainIndex).toBe(2)

    store.clearFocus(SID)
    s = useCanvasReviewStore.getState().bySessionId[SID]
    expect(s.focus).toBeNull()
    expect(s.focusChain).toEqual([])
  })

  it('a region focus replaces the ladder and disarms the marquee', () => {
    const store = useCanvasReviewStore.getState()
    store.setMarqueeArmed(SID, true)
    store.setRegionFocus(SID, { x: 5, y: 6, width: 420.4, height: 180.2 }, 'v1')
    const s = useCanvasReviewStore.getState().bySessionId[SID]
    expect(s.focus?.targets).toEqual([])
    expect(s.focus?.label).toBe('region 420×180')
    expect(s.marqueeArmed).toBe(false)
  })
})

describe('derivations', () => {
  function review(id: string, status: Review['status'], annotationIds: string[]): Review {
    return { id, canvas: { sessionId: SID, canvasId: 'c1' }, versionId: 'v1', annotationIds, status, createdAt: 'now' }
  }
  function ann(id: string, reviewId: string, state: Annotation['state']): Annotation {
    return { id, reviewId, scope: 'general', note: 'n', versionId: 'v1', state }
  }

  it('splits draft notes from the open notes of submitted reviews', () => {
    useCanvasReviewStore.setState({
      bySessionId: {
        [SID]: {
          loaded: true,
          canvasId: 'c1',
          reviews: [review('R1', 'submitted', ['a1', 'a2']), review('R2', 'resolved', ['a3']), review('R3', 'draft', ['a4'])],
          annotations: [ann('a1', 'R1', 'open'), ann('a2', 'R1', 'approved'), ann('a3', 'R2', 'dismissed'), ann('a4', 'R3', 'open')],
          focus: null,
          focusChain: [],
          focusChainIndex: 0,
          marqueeArmed: false,
          editingAnnotationId: null,
          resolution: null,
          panelHighlight: null,
        },
      },
    })
    const s = useCanvasReviewStore.getState().bySessionId[SID]
    expect(draftReviewOf(s)?.id).toBe('R3')
    expect(draftAnnotationsOf(s).map((a) => a.id)).toEqual(['a4'])
    // Only R1's open note: resolved reviews contribute nothing, drafts are not "open notes".
    expect(openSubmittedNotesOf(s).map((a) => a.id)).toEqual(['a1'])
  })
})
