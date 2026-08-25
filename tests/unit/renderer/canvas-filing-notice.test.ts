// @vitest-environment jsdom
/**
 * Filing, given a voice.
 *
 * A canvas holds one subject, so a render naming a DIFFERENT subject moves the
 * current canvas aside and repoints the session at a new one — taking any
 * unresolved notes out of view. Correct behaviour, done in silence: the pane
 * could always SEE it (the canvas id underneath changed) and had nowhere to
 * say so.
 *
 * Two things have to be true or the strip is worse than nothing:
 *   - a switch the USER asked for changes the same id and must NOT be announced
 *     as something that happened to them;
 *   - the note counts have to be read from the mirror as it stands BEFORE the
 *     refresh follows the session to its new canvas. That is the only moment
 *     the renderer knows what was left behind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Annotation, CanvasChangedEvent, Review } from '../../../src/shared/canvas'

let emit: (e: CanvasChangedEvent) => void = () => {}

const getState = vi.fn(() => Promise.resolve(null))
;(globalThis as any).window.electronAPI = {
  canvas: {
    onChanged: (cb: (e: CanvasChangedEvent) => void) => { emit = cb; return () => {} },
    onReviewChanged: () => () => {},
    getState,
  },
}

const { useCanvasStore, setupCanvasListener } = await import('../../../src/renderer/stores/canvasStore')
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')
const { useExcalidrawStore } = await import('../../../src/renderer/stores/excalidrawStore')

setupCanvasListener()

const review = (id: string, status: Review['status'], annotationIds: string[] = []): Review => ({
  id, canvas: { canvasId: 'c-old' } as Review['canvas'], versionId: 'v1',
  annotationIds, status, createdAt: '2026-08-20T10:00:00.000Z',
})
const note = (id: string, reviewId: string, state: Annotation['state']): Annotation => ({
  id, reviewId, scope: 'general', note: id, versionId: 'v1', state,
})

function seedCanvas(canvasId: string, title?: string) {
  useCanvasStore.setState({
    bySessionId: {
      s1: {
        canvasId, title, versions: [], activeVersionId: 'v1',
        interactionMode: 'browse', emptyView: 'intro', unseenRender: false,
        filedNotice: null, loaded: true,
      },
    },
  })
}

function seedReviews(canvasId: string, reviews: Review[], annotations: Annotation[]) {
  useCanvasReviewStore.setState({
    bySessionId: {
      s1: {
        loaded: true, canvasId, reviews, annotations,
        focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
        editingAnnotationId: null, resolution: null, panelHighlight: null, helpDismissed: false,
      },
    },
  })
}

describe('filing notice', () => {
  beforeEach(() => {
    seedCanvas('c-old', 'Checkout flow')
    seedReviews('c-old', [], [])
    useExcalidrawStore.setState({ bySessionId: { s1: { isOpen: true } } } as never)
    getState.mockClear()
  })

  it('announces the canvas that was moved aside, by its subject', () => {
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    const notice = useCanvasStore.getState().bySessionId.s1.filedNotice
    expect(notice).toBeTruthy()
    expect(notice!.canvasId).toBe('c-old')
    expect(notice!.title).toBe('Checkout flow')
  })

  it('counts what went with it: unsubmitted notes and open notes, kept apart', () => {
    seedReviews(
      'c-old',
      [review('R1', 'submitted', ['a1', 'a2']), review('R2', 'draft', ['a3', 'a4', 'a5'])],
      [
        note('a1', 'R1', 'open'),
        note('a2', 'R1', 'addressed'),
        note('a3', 'R2', 'open'),
        note('a4', 'R2', 'open'),
        note('a5', 'R2', 'open'),
      ],
    )
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    const notice = useCanvasStore.getState().bySessionId.s1.filedNotice!
    expect(notice.draftNotes).toBe(3)
    expect(notice.openNotes).toBe(2)
  })

  it('says nothing when the SAME canvas gets another version', () => {
    emit({ sessionId: 's1', canvasId: 'c-old', activeVersionId: 'v2' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeFalsy()
  })

  it('says nothing when the USER asked for the switch', () => {
    useCanvasStore.getState().expectSwitch('s1')
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeFalsy()
  })

  it('consumes the user-switch flag, so the NEXT filing is still announced', () => {
    useCanvasStore.getState().expectSwitch('s1')
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeFalsy()
    seedCanvas('c-new', 'Order confirmation')
    emit({ sessionId: 's1', canvasId: 'c-third', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice?.canvasId).toBe('c-new')
  })

  it('a switch that never happened does not silence the next real filing', () => {
    // The flag is consumed by the change push, so a switch that FAILS never
    // consumes it. Refusals are ordinary on this path — a canvas belonging to
    // another account is one — and a stale flag would swallow the next genuine
    // filing notice for that session, which is the one case the notice exists
    // for. Every expectSwitch caller cancels on failure.
    useCanvasStore.getState().expectSwitch('s1')
    useCanvasStore.getState().cancelExpectedSwitch('s1')
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice?.canvasId).toBe('c-old')
  })

  it('a failed switch does not cancel a CONCURRENT one that succeeded', () => {
    // Both the filed strip and the subject picker are mounted, with their own
    // busy state, so two attempts can be in flight. With a flag rather than a
    // count, the failing one's cancel took the succeeding one's announcement
    // with it and the user was told their own switch was a filing.
    useCanvasStore.getState().expectSwitch('s1')
    useCanvasStore.getState().expectSwitch('s1')
    useCanvasStore.getState().cancelExpectedSwitch('s1')
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeFalsy()
  })

  it('an ordinary new version does not eat the expectation', () => {
    // Only an identity change consumes one. The agent rendering another version
    // of the canvas you are already on used to consume it, so the switch you
    // had asked for then arrived looking like a filing.
    useCanvasStore.getState().expectSwitch('s1')
    emit({ sessionId: 's1', canvasId: 'c-old', activeVersionId: 'v2' })
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeFalsy()
  })

  it('cancelling is per session and leaves another session\'s expectation alone', () => {
    useCanvasStore.setState({
      bySessionId: {
        ...useCanvasStore.getState().bySessionId,
        s2: {
          canvasId: 'c-two', versions: [], activeVersionId: 'v1',
          interactionMode: 'browse', emptyView: 'intro', unseenRender: false,
          filedNotice: null, loaded: true,
        },
      },
    })
    useCanvasStore.getState().expectSwitch('s1')
    useCanvasStore.getState().expectSwitch('s2')
    useCanvasStore.getState().cancelExpectedSwitch('s1')
    emit({ sessionId: 's2', canvasId: 'c-two-new', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s2.filedNotice).toBeFalsy()
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice?.canvasId).toBe('c-old')
  })

  it('says nothing on the FIRST canvas a session ever gets', () => {
    useCanvasStore.setState({
      bySessionId: {
        s1: {
          canvasId: null, versions: [], activeVersionId: null,
          interactionMode: 'browse', emptyView: 'intro', unseenRender: false,
          filedNotice: null, loaded: true,
        },
      },
    })
    emit({ sessionId: 's1', canvasId: 'c-first', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeFalsy()
  })

  it('does not attribute another canvas\'s notes when the review mirror is stale', () => {
    // The mirror is still on some third canvas: its counts are not evidence
    // about what was just filed, so nothing is claimed.
    seedReviews('c-somewhere-else', [review('R1', 'submitted', ['a1'])], [note('a1', 'R1', 'open')])
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    const notice = useCanvasStore.getState().bySessionId.s1.filedNotice!
    expect(notice.openNotes).toBe(0)
    expect(notice.draftNotes).toBe(0)
  })

  it('is dismissable', () => {
    emit({ sessionId: 's1', canvasId: 'c-new', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeTruthy()
    useCanvasStore.getState().dismissFiled('s1')
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeNull()
  })
})

describe('completion stand-downs (#476)', () => {
  beforeEach(() => {
    seedCanvas('c-old', 'Checkout flow')
    seedReviews('c-old', [], [])
    // Pane CLOSED here, unlike above — the pulse cases need the closed shape.
    useExcalidrawStore.setState({ bySessionId: { s1: { isOpen: false } } } as never)
    getState.mockClear()
  })

  it('a REOPEN naming another canvas raises no filing strip and no pulse', () => {
    emit({ sessionId: 's1', canvasId: 'c-done', activeVersionId: 'v1', reopened: true })
    const s = useCanvasStore.getState().bySessionId.s1
    expect(s.filedNotice).toBeNull()
    expect(s.unseenRender).toBe(false)
  })

  it('a render while VIEWING a completed canvas starts fresh with no filing strip', () => {
    // The dead-end fix mints a fresh canvas from a viewed completed one; the
    // strip would claim "I filed <subject> when the agent started a different
    // subject" — false twice over (already in the library; can be the same
    // subject).
    useCanvasStore.setState({
      bySessionId: {
        s1: {
          ...useCanvasStore.getState().bySessionId.s1,
          completed: { at: 'now', by: 'user' as const },
        },
      },
    })
    emit({ sessionId: 's1', canvasId: 'c-fresh', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeNull()
  })

  it('an announced switch AWAY FROM a completed canvas still consumes its expectation', () => {
    // The stand-down must not leak the switch expectation: View a completed
    // canvas, ask for a switch (picker/queue/strip all announce), and the
    // expectation must be CONSUMED by that identity change even though no
    // strip shows — or it lingers and swallows the next GENUINE filing.
    useCanvasStore.setState({
      bySessionId: {
        s1: {
          ...useCanvasStore.getState().bySessionId.s1,
          completed: { at: 'now', by: 'user' as const },
        },
      },
    })
    useCanvasStore.getState().expectSwitch('s1')
    emit({ sessionId: 's1', canvasId: 'c-next', activeVersionId: 'v1' })
    expect(useCanvasStore.getState().bySessionId.s1.filedNotice).toBeNull()

    // Now a REAL filing on the new canvas must still announce.
    seedCanvas('c-next', 'Next subject')
    emit({ sessionId: 's1', canvasId: 'c-third', activeVersionId: 'v1' })
    const notice = useCanvasStore.getState().bySessionId.s1.filedNotice
    expect(notice?.canvasId).toBe('c-next')
  })

  it('a sign-off event sets the acknowledgment, not the pulse or the strip', () => {
    emit({ sessionId: 's1', canvasId: 'c-old', activeVersionId: 'v1', completed: true })
    const s = useCanvasStore.getState().bySessionId.s1
    expect(s.completedNotice).toEqual({ canvasId: 'c-old', title: 'Checkout flow' })
    expect(s.unseenRender).toBe(false)
    expect(s.filedNotice).toBeNull()
  })
})
