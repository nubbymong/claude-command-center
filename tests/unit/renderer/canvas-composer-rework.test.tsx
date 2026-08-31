// @vitest-environment jsdom
//
// The reworked composer and decision bar (M2: W11–W16).
//
// Four live repros drove this file, and each has a test:
//
//  1. a second Ctrl+V silently REPLACED the first — the user pasted three
//     screenshots and the agent was handed one;
//  2. the composer lived only in React state, so a pane switch threw away the
//     note, the target, the images and the drawing without asking;
//  3. after a reject the compose area sat there offering a second submit,
//     saying nothing about what was now happening;
//  4. a drawing needed an "Attach selected sketch" click nobody found, so
//     strokes on the glass never reached the note beside them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { paneSketchProps, type PaneSketchProps } from './canvas-panel-harness'
import { MAX_SKETCH_SCENE_BYTES, MAX_SKETCH_SCENE_ELEMENTS } from '../../../src/shared/canvas'
import type { Annotation, CanvasAnnotationDraft, CanvasReviewState, CanvasVersion, ComposerDraft, ComposerDraftInput, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const PNG = 'iVBORw0KGgo='

// The clipboard→PNG conversion is DOM-bound (createImageBitmap, a 2d canvas,
// toBlob) and jsdom has none of it. Its own ladder is covered in
// canvas-paste-image.test.ts; here the panel's behaviour AFTER a successful
// conversion is what matters, so only that seam is stubbed — the clipboard
// sniffing stays real, because "which paste does the panel take" is part of
// what this file pins.
vi.mock('../../../src/renderer/utils/canvasPasteImage', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  return { ...real, pastedImageToPng: vi.fn(async () => ({ pngBase64: PNG })) }
})

const panelModule = await import('../../../src/renderer/components/CanvasNotesPanel')
const CanvasNotesPanel = panelModule.default
const {
  insertImageMarker,
  renumberImageMarkers,
  submitLabel,
  decisionLabels,
  nextVersionLabel,
  answeringVersion,
  sketchFitsDraft,
  COMPOSER_SAVE_DEBOUNCE_MS,
} = panelModule
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')

const SID = 'session-1'
const CID = 'canvas-a'

const designVersion = (id = 'v8'): CanvasVersion =>
  ({ id, mode: 'design', createdAt: '2026-08-29T10:00:00Z', source: { mode: 'design', entry: 'index.html' } }) as CanvasVersion
const planVersion = (): CanvasVersion =>
  ({ id: 'v2', mode: 'plan', createdAt: '2026-08-29T10:00:00Z', source: { mode: 'design', entry: 'index.html' } }) as CanvasVersion
const uatVersion = (buildLabel?: string): CanvasVersion =>
  ({
    id: 'v4',
    mode: 'uat',
    createdAt: '2026-08-29T10:00:00Z',
    source: { mode: 'uat', distRoot: 'C:/build', entry: 'index.html', buildLabel },
  }) as CanvasVersion

const draftReview: Review = {
  id: 'R3',
  canvas: { canvasId: CID, sessionId: SID },
  versionId: 'v8',
  annotationIds: [],
  status: 'draft',
  createdAt: '2026-08-29T10:05:00Z',
}

const note = (id: string, over: Partial<Annotation> = {}): Annotation => ({
  id,
  reviewId: 'R3',
  scope: 'general',
  note: `text of ${id}`,
  versionId: 'v8',
  state: 'open',
  ...over,
})

let current: CanvasReviewState
let container: HTMLDivElement
let root: Root
let savedDrafts: ComposerDraftInput[]
let clears: number
let upserts: CanvasAnnotationDraft[]
let attached: string[][]
let persistedScenes: number
/** The image list MAIN holds, resolved the way the store does: an entry names
 *  a SOURCE in the previous list, never a destination. */
let mainImages: string[]

function emptyState(over: Partial<CanvasReviewState> = {}): CanvasReviewState {
  return { canvasId: CID, sessionId: SID, reviews: [], annotations: [], ...over }
}

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => current),
    reviewMarkSeen: vi.fn(async () => ({ state: current, seen: [] })),
    composerDraftSet: vi.fn(async ({ draft }: { draft: ComposerDraftInput }) => {
      savedDrafts.push(draft)
      // The store's own resolution, in miniature: each entry names a SOURCE in
      // the list main already holds, and the survivors are then renamed by
      // destination. A mock that just counted entries would pass while the
      // renderer and main quietly held different pictures.
      const before = mainImages
      const resolved = draft.images.map((entry, k) => {
        if (entry === 'keep') return before[k]
        if ('keepIndex' in entry) return before[entry.keepIndex]
        return 'fresh'
      })
      if (resolved.some((p) => p === undefined)) throw new Error('composer image reference is gone')
      mainImages = resolved.map((_, k) => `reviews/composer/img-${k}.png`)
      const composer: ComposerDraft = {
        versionId: draft.versionId,
        ...(draft.decision ? { decision: draft.decision } : {}),
        text: draft.text,
        ...(draft.focus ? { focus: draft.focus } : {}),
        images: mainImages.map((pngPath) => ({ pngPath })),
        ...(draft.sketch ? { sketch: draft.sketch } : {}),
        updatedAt: '2026-08-29T10:06:00Z',
      }
      current = { ...current, composer }
      return current
    }),
    composerDraftClear: vi.fn(async () => {
      clears++
      mainImages = []
      current = { ...current, composer: undefined }
      return current
    }),
    annotationUpsert: vi.fn(async ({ draft }: { draft: CanvasAnnotationDraft }) => {
      upserts.push(draft)
      const id = `a${upserts.length}`
      const created = note(id, { note: draft.note, ...(draft.sketch ? { sketch: { ...draft.sketch, pngPath: '' } } : {}) })
      current = {
        ...current,
        reviews: current.reviews.length > 0 ? current.reviews : [draftReview],
        annotations: [...current.annotations, created],
      }
      current = {
        ...current,
        reviews: current.reviews.map((r) => (r.status === 'draft' ? { ...r, annotationIds: [...r.annotationIds, id] } : r)),
      }
      return { state: current, annotationId: id }
    }),
    reviewSubmit: vi.fn(async () => {
      current = {
        ...current,
        reviews: current.reviews.map((r) => (r.status === 'draft' ? { ...r, status: 'submitted' as const } : r)),
      }
      return current
    }),
    versionVerdict: vi.fn(async () => ({ canvasId: CID })),
  },
}

async function render(version: CanvasVersion = designVersion(), props: Partial<PaneSketchProps> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel
        sessionId={SID}
        version={version}
        getGlassApi={() => null}
        onReturnToTerminal={() => {}}
        isActive
        {...paneSketchProps({
          getAllSketchElements: () => [{ id: 's1', x: 4, y: 6, width: 10, height: 20 }] as never,
          ...props,
        })}
        canvasId={CID}
      />,
    )
  })
}

const q = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)
const textarea = (): HTMLTextAreaElement => q('composer-textarea') as HTMLTextAreaElement

async function type(value: string): Promise<void> {
  const el = textarea()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A clipboard paste of one PNG, as the window listener sees it. */
async function pasteImage(): Promise<void> {
  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
  })
  Object.defineProperty(event, 'target', { value: document.body })
  await act(async () => {
    window.dispatchEvent(event)
    // The conversion is async (createImageBitmap → canvas → toBlob), mocked
    // below; two microtask turns is enough for the panel's own chain.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  savedDrafts = []
  clears = 0
  upserts = []
  attached = []
  persistedScenes = 0
  mainImages = []
  // The electronAPI mocks are module-level, so their call counts survive a test
  // unless they are cleared here.
  vi.clearAllMocks()
  current = emptyState()
  useCanvasReviewStore.getState().reset()
  useCanvasStore.setState({ bySessionId: {} } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

// ── The words ───────────────────────────────────────────────────────────────

describe('the decision says what the user is deciding on (W11)', () => {
  it('names the version, the plan, or the build', () => {
    expect(decisionLabels(designVersion())).toEqual({ approve: 'Approve v8', reject: 'Reject v8' })
    // A plan has no Reject (owner spec, 2026-08-31) — the other button asks for
    // another turn of the loop. The DECISION underneath is still 'reject'.
    expect(decisionLabels(planVersion())).toEqual({ approve: 'Approve plan', reject: 'Submit Revisions' })
    expect(decisionLabels(uatVersion('2026.8.29'))).toEqual({ approve: 'Pass build 2026.8.29', reject: 'Fail build 2026.8.29' })
    // No build label: the version id is the honest fallback, never a blank.
    expect(decisionLabels(uatVersion())).toEqual({ approve: 'Pass build v4', reject: 'Fail build v4' })
  })

  it('Submit states what it FILES, with the mode`s own nouns', () => {
    expect(submitLabel(designVersion(), null, 0)).toBe('Submit')
    expect(submitLabel(designVersion(), 'approve', 0)).toBe('Submit — Approve v8')
    expect(submitLabel(designVersion(), 'reject', 3)).toBe('Submit — Reject v8, 3 notes')
    expect(submitLabel(planVersion(), 'approve', 0)).toBe('Submit — Approve plan')
    expect(submitLabel(planVersion(), 'reject', 2)).toBe('Submit revisions — 2 notes')
    expect(submitLabel(planVersion(), 'reject', 1)).toBe('Submit revisions — 1 note')
    expect(submitLabel(uatVersion(), 'reject', 3)).toBe('Submit test — Fail, 3 defects')
    expect(submitLabel(uatVersion(), 'approve', 2)).toBe('Submit test — Pass, 2 observations')
    expect(submitLabel(uatVersion(), 'approve', 0)).toBe('Submit test — Pass')
    // Singular reads as singular — a count that says "1 notes" is a machine talking.
    expect(submitLabel(designVersion(), 'reject', 1)).toBe('Submit — Reject v8, 1 note')
  })

  it('predicts the next version from the canvas`s own monotonic ids', () => {
    expect(nextVersionLabel([designVersion('v1'), designVersion('v8')])).toBe('v9')
    expect(nextVersionLabel([])).toBeNull()
  })
})

describe('the decision bar', () => {
  it('arms Submit RED on a reject, and green on an approve', async () => {
    current = emptyState({ reviews: [draftReview], annotations: [note('a1')] })
    current = { ...current, reviews: [{ ...draftReview, annotationIds: ['a1'] }] }
    await render()
    await act(async () => q('decision-reject')!.click())
    expect((q('canvas-submit') as HTMLElement).style.background).toContain('--color-red')
    expect(q('canvas-submit')!.textContent).toBe('Submit — Reject v8, 1 note')
    await act(async () => q('decision-approve')!.click())
    expect((q('canvas-submit') as HTMLElement).style.background).toContain('--color-green')
  })

  it('warns BEFORE the click that notes on an approval become observations', async () => {
    current = emptyState({ reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [note('a1')] })
    await render()
    expect(q('canvas-approve-observations-warning')).toBeNull()
    await act(async () => q('decision-approve')!.click())
    expect(q('canvas-approve-observations-warning')!.textContent).toContain('recorded as observations')
  })

  it('keeps Submit dead until a decision is made', async () => {
    await render()
    expect((q('canvas-submit') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => q('decision-approve')!.click())
    expect((q('canvas-submit') as HTMLButtonElement).disabled).toBe(false)
  })
})

// ── W12: never a dead compose area ──────────────────────────────────────────

describe('after a reject the panel says what is happening (W12)', () => {
  it('replaces the composer with the wait, naming the round and the version owed', async () => {
    useCanvasStore.setState({
      bySessionId: {
        [SID]: { canvasId: CID, versions: [designVersion('v8')], activeVersionId: 'v8', loaded: true },
      },
    } as never)
    current = emptyState({ reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [note('a1')] })
    await render()
    await act(async () => q('decision-reject')!.click())
    await act(async () => {
      ;(q('canvas-submit') as HTMLElement).click()
      await Promise.resolve()
    })
    const waiting = q('canvas-filed-waiting')!
    expect(waiting.textContent).toContain('Review #3 filed')
    expect(waiting.textContent).toContain('waiting on the agent to render v9')
    // No second submit to press, and no dead textarea sitting under it.
    expect(q('canvas-submit')).toBeNull()
    expect(q('composer-textarea')).toBeNull()
    expect(q('canvas-return-to-terminal')).not.toBeNull()
  })
})

// ── W15: multi-image paste ──────────────────────────────────────────────────

describe('pasting images (W15)', () => {
  it('inserts "Image N" at the caret and renumbers when one is removed', () => {
    // Pure helpers, because the numbering is a contract with the SERIALIZER:
    // "Image 2" in the note text is the second image block for that note.
    expect(insertImageMarker('', 0, 0, 1)).toEqual({ text: 'Image 1', caret: 7 })
    expect(insertImageMarker('look at', 7, 7, 1)).toEqual({ text: 'look at Image 1', caret: 15 })
    expect(insertImageMarker('look at here', 7, 7, 2)).toEqual({ text: 'look at Image 2 here', caret: 15 })
    // Removing image 2: its own marker goes with it (a marker pointing at
    // nothing is worse than silence), and later ones shift down.
    expect(renumberImageMarkers('see Image 1, Image 2 and Image 3', 2)).toBe('see Image 1, and Image 2')
    expect(renumberImageMarkers('Image 1 then Image 2', 1)).toBe('then Image 1')
  })

  it('APPENDS on a second paste — it does not replace the first', async () => {
    await render()
    await pasteImage()
    await pasteImage()
    const tiles = container.querySelectorAll('[data-testid^="composer-image-"]:not([data-testid*="remove"])')
    expect(tiles).toHaveLength(2)
    expect(textarea().value).toContain('Image 1')
    expect(textarea().value).toContain('Image 2')
  })

  it('persists immediately on a paste — an image is the expensive thing to lose', async () => {
    await render()
    await pasteImage()
    expect(savedDrafts).toHaveLength(1)
    expect(savedDrafts[0].images).toEqual([{ pngBase64: PNG }])
  })

  it('sends a POSITION, not bytes, once main is holding the image', async () => {
    await render()
    await pasteImage()
    await pasteImage()
    // The second save keeps the first image by naming where it already is.
    expect(savedDrafts[1].images).toEqual([{ keepIndex: 0 }, { pngBase64: PNG }])
  })

  it('renumbers the note`s markers when an image is removed', async () => {
    await render()
    await pasteImage()
    await pasteImage()
    await act(async () => (q('composer-image-remove-1') as HTMLElement).click())
    expect(textarea().value).not.toContain('Image 2')
    expect(textarea().value).toContain('Image 1')
    // …and the surviving image is the SECOND one, named by its source index.
    expect(savedDrafts[savedDrafts.length - 1].images).toEqual([{ keepIndex: 1 }])
  })

  it('refuses a ninth image and says why', async () => {
    await render()
    for (let i = 0; i < 9; i++) await pasteImage()
    expect(container.querySelectorAll('[data-testid^="composer-image-"]:not([data-testid*="remove"])')).toHaveLength(8)
    expect(q('composer-paste-error')!.textContent).toContain('at most 8 images')
  })

  it('tells the user what Ctrl+V will do next', async () => {
    await render()
    expect(q('composer-paste-hint')!.textContent).toBe('Ctrl+V adds images — Image 1, Image 2…')
    await pasteImage()
    await pasteImage()
    expect(q('composer-paste-hint')!.textContent).toBe('Ctrl+V pastes another image — inserts Image 3 here')
  })
})

// ── W14: the persisted composer ─────────────────────────────────────────────

describe('the composer survives leaving the pane (W14)', () => {
  it('restores text, decision and images from what main holds', async () => {
    current = emptyState({
      composer: {
        versionId: 'v8',
        decision: 'reject',
        text: 'half a thought about Image 1',
        images: [{ pngPath: 'reviews/composer/img-0.png' }],
        updatedAt: '2026-08-29T10:06:00Z',
      },
    })
    await render()
    expect(textarea().value).toBe('half a thought about Image 1')
    expect(q('canvas-submit')!.textContent).toContain('Reject v8')
    // The image comes back as a POSITION — the renderer never held its bytes.
    expect(container.querySelectorAll('[data-testid^="composer-image-"]:not([data-testid*="remove"])')).toHaveLength(1)
    await type('half a thought about Image 1, more')
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS + 100))
    expect(savedDrafts[savedDrafts.length - 1].images).toEqual([{ keepIndex: 0 }])
  })

  it('gives the drawing back to the glass', async () => {
    const restored: Array<{ scene: string }> = []
    // True: this restore MOVED the glass, so the pane will bump the revision.
    current = emptyState({
      composer: {
        versionId: 'v8',
        text: '',
        images: [],
        sketch: { scene: '[{"id":"s1"}]', versions: { s1: 'v8' } },
        updatedAt: '2026-08-29T10:06:00Z',
      },
    })
    await render(designVersion(), {
      restoreSketchScene: (s) => {
        restored.push(s)
        return true
      },
    })
    expect(restored).toEqual([{ scene: '[{"id":"s1"}]', versions: { s1: 'v8' } }])
  })

  it('debounces typing rather than writing per keystroke', async () => {
    await render()
    await type('a')
    await type('ab')
    await type('abc')
    expect(savedDrafts).toHaveLength(0)
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS + 100))
    expect(savedDrafts).toHaveLength(1)
    expect(savedDrafts[0].text).toBe('abc')
  })

  it('persists the glass on unmount — the moment the old model lost everything', async () => {
    await render(designVersion(), {
      getSketchSceneForPersist: () => {
        persistedScenes++
        return { scene: '[{"id":"s1"}]', versions: { s1: 'v8' } }
      },
    })
    await type('unsent')
    await act(async () => root.unmount())
    expect(savedDrafts[savedDrafts.length - 1]).toMatchObject({
      text: 'unsent',
      sketch: { scene: '[{"id":"s1"}]', versions: { s1: 'v8' } },
    })
    expect(persistedScenes).toBeGreaterThan(0)
    // Re-mounted by afterEach's unmount guard being a no-op; render a fresh root.
    root = createRoot(container)
  })

  it('drops a draft written on ANOTHER artefact rather than carrying it across', async () => {
    useCanvasStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: CID,
          versions: [
            { ...designVersion('v1'), mode: 'plan' } as CanvasVersion,
            designVersion('v8'),
          ],
          activeVersionId: 'v8',
          loaded: true,
        },
      },
    } as never)
    current = emptyState({
      composer: { versionId: 'v1', text: 'about the PLAN', images: [], updatedAt: '2026-08-29T10:06:00Z' },
    })
    await render()
    expect(clears).toBe(1)
    expect(textarea().value).toBe('')
  })
})

// ── W16: the drawing rides the note ─────────────────────────────────────────

describe('a drawing rides the note (W16)', () => {
  it('says how many strokes are about to go with it', async () => {
    await render(designVersion(), { getUnattachedSketchElementIds: () => ['s1', 's2'] })
    expect(q('composer-strokes-ride')!.textContent).toContain('2 strokes will ride this note')
    // The button that used to be needed is gone.
    expect(container.textContent).not.toContain('Attach selected sketch')
  })

  it('attaches them on Add note and tells the pane they are taken', async () => {
    await render(designVersion(), {
      getUnattachedSketchElementIds: () => ['s1'],
      markSketchElementsAttached: (ids) => attached.push(ids),
    })
    await type('the header is heavy')
    await act(async () => {
      ;(q('composer-add-note') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(upserts[0].sketch).toEqual({ excalidrawElementIds: ['s1'], bboxPage: { x: 4, y: 6, width: 10, height: 20 } })
    expect(attached).toEqual([['s1']])
  })

  it('lets a drawing BE the note — no text needed', async () => {
    await render(designVersion(), { getUnattachedSketchElementIds: () => ['s1'] })
    expect((q('composer-add-note') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps Add note dead when there is nothing at all', async () => {
    await render()
    expect((q('composer-add-note') as HTMLButtonElement).disabled).toBe(true)
  })

  it('EDITING a note keeps its drawing and its images rather than stripping them', async () => {
    // Re-wording a note used to send no attachments at all, which main reads as
    // "remove them" — so fixing a typo threw away the circle the user drew round
    // the thing the note was about.
    const drawn = note('a1', {
      note: 'this bit',
      sketch: { excalidrawElementIds: ['s9'], pngPath: '', bboxPage: { x: 1, y: 2, width: 3, height: 4 } },
      images: [{ pngPath: 'reviews/pasted/a1-0.png' }],
    })
    current = emptyState({ reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [drawn] })
    await render(designVersion(), {
      getUnattachedSketchElementIds: () => ['s1'],
      markSketchElementsAttached: (ids) => attached.push(ids),
    })
    await act(async () => (q('draft-note-edit') as HTMLElement).click())
    await type('this bit, reworded')
    await act(async () => {
      ;(q('composer-add-note') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(upserts[0]).toMatchObject({
      annotationId: 'a1',
      note: 'this bit, reworded',
      sketch: { excalidrawElementIds: ['s9'], bboxPage: { x: 1, y: 2, width: 3, height: 4 } },
      images: [{ fromNote: 0 }],
    })
    // The loose stroke on the glass is NOT swallowed by an edit — it belongs to
    // whatever note is written next.
    expect(attached).toEqual([])
  })
})

// ── Item 1: the glass is not reactive without the revision ──────────────────

describe('a drawing made AFTER mount reaches the panel (W16)', () => {
  it('arms Add note and counts the strokes once the revision bumps', async () => {
    // getUnattachedSketchElementIds is a plain call into the pane, so the count
    // was read once per render and nothing re-rendered when the user drew: Add
    // note stayed dead with a finished drawing sitting on the glass.
    let strokes: string[] = []
    await render(designVersion(), { getUnattachedSketchElementIds: () => strokes })
    expect((q('composer-add-note') as HTMLButtonElement).disabled).toBe(true)
    expect(q('composer-strokes-ride')).toBeNull()

    strokes = ['s1', 's2']
    await render(designVersion(), { getUnattachedSketchElementIds: () => strokes, sketchRevision: 1 })
    expect((q('composer-add-note') as HTMLButtonElement).disabled).toBe(false)
    expect(q('composer-strokes-ride')!.textContent).toContain('2 strokes will ride this note')
  })

  it('persists a DRAWING-ONLY draft — the revision is what makes it dirty', async () => {
    const scene = { scene: '[{"id":"s1"}]', versions: { s1: 'v8' } }
    let asked = 0
    const props = {
      getUnattachedSketchElementIds: () => ['s1'],
      getSketchSceneForPersist: () => {
        asked++
        return scene
      },
    }
    await render(designVersion(), props)
    await render(designVersion(), { ...props, sketchRevision: 1 })
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS + 50))
    expect(asked).toBeGreaterThan(0)
    expect(savedDrafts).toHaveLength(1)
    expect(savedDrafts[0]).toMatchObject({ text: '', images: [], sketch: scene })
  })

  it('does NOT re-save a scene it has just restored', async () => {
    // The restore puts the scene back and the glass reports a change; that is
    // the panel's own doing, so it must not mark the draft dirty.
    current = emptyState({
      composer: { versionId: 'v8', text: '', images: [], sketch: { scene: '[]', versions: {} }, updatedAt: 'x' },
    })
    const props = { restoreSketchScene: () => true }
    await render(designVersion(), props)
    await render(designVersion(), { ...props, sketchRevision: 1 })
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS + 50))
    expect(savedDrafts).toHaveLength(0)
  })
  it('marks the draft dirty when the restore was a NO-OP and the user then draws', async () => {
    // A restore that changed nothing (the scene was already on the glass — a
    // quick pane toggle restoring from the in-memory stash) sends no revision
    // bump. Arming the one-shot suppression anyway leaves it waiting, and the
    // bump it eventually eats is the user's FIRST REAL STROKE.
    const scene = { scene: '[{"id":"s1"}]', versions: { s1: 'v8' } }
    current = emptyState({ composer: { versionId: 'v8', text: '', images: [], sketch: scene, updatedAt: 'x' } })
    const props = { restoreSketchScene: () => false, getSketchSceneForPersist: () => scene }
    await render(designVersion(), props)
    await render(designVersion(), { ...props, sketchRevision: 1 })
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS + 50))
    expect(savedDrafts).toHaveLength(1)
    expect(savedDrafts[0].sketch).toEqual(scene)
  })
})

// ── Item 2: a debounced save must not outlive the submit ────────────────────

describe('submitting closes the composer down first', () => {
  it('does not resurrect the draft with a save armed a keystroke earlier', async () => {
    current = emptyState({ reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [note('a1')] })
    await render()
    await type('almost done')
    // Inside the debounce window — the save is armed and has not fired.
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS - 100))
    expect(savedDrafts).toHaveLength(0)
    await act(async () => q('decision-reject')!.click())
    await act(async () => {
      ;(q('canvas-submit') as HTMLElement).click()
      await Promise.resolve()
    })
    const setsBefore = savedDrafts.length
    await act(async () => vi.advanceTimersByTime(2000))
    expect(savedDrafts).toHaveLength(setsBefore)
    expect((window as any).electronAPI.canvas.reviewSubmit).toHaveBeenCalledTimes(1)
  })

  it('lets the composer work again when the verdict was REFUSED', async () => {
    ;(window as any).electronAPI.canvas.versionVerdict.mockResolvedValueOnce({ error: 'that version is already decided' })
    await render()
    await act(async () => q('decision-approve')!.click())
    await act(async () => {
      ;(q('canvas-submit') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(q('canvas-submit-error')!.textContent).toContain('already decided')
    await type('trying again')
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS + 50))
    expect(savedDrafts[savedDrafts.length - 1].text).toBe('trying again')
  })
})

// ── Item 3: an edit is not the composer ─────────────────────────────────────

describe('editing a filed draft note never touches the composer', () => {
  const withNote = (): void => {
    current = emptyState({
      reviews: [{ ...draftReview, annotationIds: ['a1'] }],
      annotations: [note('a1', { note: 'the header' })],
    })
  }

  it('persists nothing at all while an edit is open', async () => {
    withNote()
    await render()
    await act(async () => (q('draft-note-edit') as HTMLElement).click())
    await type('the header, reworded')
    await act(async () => vi.advanceTimersByTime(2000))
    expect(savedDrafts).toHaveLength(0)
  })

  it('Cancel leaves no phantom composer behind', async () => {
    withNote()
    await render()
    await act(async () => (q('draft-note-edit') as HTMLElement).click())
    await type('words the user never composed')
    await act(async () => (q('composer-cancel-edit') as HTMLElement).click())
    expect(textarea().value).toBe('')
    await act(async () => vi.advanceTimersByTime(2000))
    expect(savedDrafts).toHaveLength(0)
  })

  it('keeps the composer own words while an edit is open, and gives them back', async () => {
    withNote()
    await render()
    await type('my half-written note')
    await act(async () => (q('draft-note-edit') as HTMLElement).click())
    expect(textarea().value).toBe('the header')
    await act(async () => (q('composer-cancel-edit') as HTMLElement).click())
    expect(textarea().value).toBe('my half-written note')
  })
})

// ── Item 4: a ceiling the user can hit is a sentence, not silence ───────────

describe('a drawing too large to persist', () => {
  it('saves the draft WITHOUT it and says so, rather than failing the whole save', async () => {
    await render(designVersion(), {
      getSketchSceneForPersist: () => ({ scene: 'a'.repeat(MAX_SKETCH_SCENE_BYTES + 1), versions: {} }),
    })
    await type('the words must survive')
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS + 50))
    expect(savedDrafts).toHaveLength(1)
    expect(savedDrafts[0].text).toBe('the words must survive')
    expect(savedDrafts[0].sketch).toBeUndefined()
    expect(q('composer-sketch-too-large')!.textContent).toContain('drawing too large to keep with the draft')
  })

  it('refuses on the element count as well as the bytes', () => {
    const versions: Record<string, string> = {}
    for (let i = 0; i <= MAX_SKETCH_SCENE_ELEMENTS; i++) versions['e' + i] = 'v8'
    expect(sketchFitsDraft({ scene: '[]', versions })).toBe(false)
    expect(sketchFitsDraft({ scene: '[]', versions: { e1: 'v8' } })).toBe(true)
  })
})

// ── Item 5: two removes in a row ────────────────────────────────────────────

describe('rapid removes keep the renderer and main agreeing', () => {
  it('serialises the saves and names the SOURCE of each survivor', async () => {
    await render()
    await pasteImage()
    await pasteImage()
    await pasteImage()
    savedDrafts.length = 0
    // Two removes back to back, in one tick — the shape that used to send two
    // saves computed from the same stale list.
    await act(async () => {
      ;(q('composer-image-remove-1') as HTMLElement).click()
      ;(q('composer-image-remove-1') as HTMLElement).click()
    })
    await act(async () => vi.advanceTimersByTime(2000))
    expect(container.querySelectorAll('[data-testid^="composer-image-"]:not([data-testid*="remove"])')).toHaveLength(1)
    // Main ends holding exactly one image, and it is the one that was FIRST.
    expect(mainImages).toEqual(['reviews/composer/img-0.png'])
    expect(savedDrafts[savedDrafts.length - 1].images).toEqual([{ keepIndex: 0 }])
  })
})

// ── Item 6: a canvas switch must not cross the streams ──────────────────────

describe('the composer is scoped to the canvas the PANE is showing', () => {
  it('does not restore, or save, while the mirror still describes another canvas', async () => {
    current = {
      canvasId: 'canvas-somewhere-else',
      sessionId: SID,
      reviews: [],
      annotations: [],
      composer: { versionId: 'v8', text: 'another canvas half-written note', images: [], updatedAt: 'x' },
    }
    await render()
    expect(textarea().value).toBe('')
    await type('typed on THIS canvas')
    await act(async () => vi.advanceTimersByTime(2000))
    expect(savedDrafts).toHaveLength(0)
    expect(clears).toBe(0)
  })
})

// ── Item 8: the pane moves to another artefact while we are mounted ─────────

describe('the draft follows the ARTEFACT, not the mount', () => {
  it('drops it when the displayed version switches to a different artefact', async () => {
    const plan = { ...designVersion('v1'), mode: 'plan' } as CanvasVersion
    useCanvasStore.setState({
      bySessionId: { [SID]: { canvasId: CID, versions: [plan, designVersion('v8')], activeVersionId: 'v8', loaded: true } },
    } as never)
    current = emptyState({ composer: { versionId: 'v8', text: 'about the mockup', images: [], updatedAt: 'x' } })
    await render(designVersion('v8'))
    expect(textarea().value).toBe('about the mockup')
    expect(clears).toBe(0)
    // The pane switches to the PLAN while this panel stays mounted.
    await render(plan)
    expect(clears).toBe(1)
    expect(textarea().value).toBe('')
  })

  it('keeps it across a new version of the SAME artefact', async () => {
    useCanvasStore.setState({
      bySessionId: {
        [SID]: { canvasId: CID, versions: [designVersion('v8'), designVersion('v9')], activeVersionId: 'v9', loaded: true },
      },
    } as never)
    current = emptyState({ composer: { versionId: 'v8', text: 'still relevant', images: [], updatedAt: 'x' } })
    await render(designVersion('v8'))
    await render(designVersion('v9'))
    expect(clears).toBe(0)
    expect(textarea().value).toBe('still relevant')
  })
})

// ── Item 7 + 20: the lines the user reads when the version is not open ──────

describe('a version that is not open says why, in plain words', () => {
  const decided = (state: 'approved' | 'rejected'): CanvasVersion =>
    ({ ...designVersion('v7'), verdict: { state, by: 'user', at: 'x' } }) as CanvasVersion

  it('names the version that ANSWERED a rejection, not max+1', () => {
    // v8 exists, so "the agent is working on v9" names a version nobody has
    // heard of and hides the one the user could go and look at.
    const versions = [designVersion('v7'), designVersion('v8')]
    expect(answeringVersion(versions, 'v7')?.id).toBe('v8')
    expect(answeringVersion([designVersion('v7')], 'v7')).toBeNull()
    // A DRAFT is not an answer — the user has not been shown it.
    const withDraft = [designVersion('v7'), { ...designVersion('v8'), draft: true } as CanvasVersion]
    expect(answeringVersion(withDraft, 'v7')).toBeNull()
  })

  it('renders that line, with no composer under it', async () => {
    useCanvasStore.setState({
      bySessionId: {
        [SID]: { canvasId: CID, versions: [decided('rejected'), designVersion('v8')], activeVersionId: 'v8', loaded: true },
      },
    } as never)
    await render(decided('rejected'))
    expect(q('canvas-version-closed-line')!.textContent).toBe('v7 was rejected — v8 answers it.')
    expect(q('composer-textarea')).toBeNull()
    expect(q('canvas-submit')).toBeNull()
  })

  it('falls back to the wait when the answer does not exist yet', async () => {
    useCanvasStore.setState({
      bySessionId: { [SID]: { canvasId: CID, versions: [decided('rejected')], activeVersionId: 'v7', loaded: true } },
    } as never)
    await render(decided('rejected'))
    expect(q('canvas-version-closed-line')!.textContent).toContain('the agent is working on the next version')
  })
})

// ── Item 20: what the panel shows after a submit ────────────────────────────

describe('after a submit the round is still readable above the wait', () => {
  it('draws the OPEN card above the waiting line', async () => {
    useCanvasStore.setState({
      bySessionId: { [SID]: { canvasId: CID, versions: [designVersion('v8')], activeVersionId: 'v8', loaded: true } },
    } as never)
    current = emptyState({ reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [note('a1')] })
    await render()
    await act(async () => q('decision-reject')!.click())
    await act(async () => {
      ;(q('canvas-submit') as HTMLElement).click()
      await Promise.resolve()
    })
    const card = container.querySelector('[data-testid="review-group"]')!
    const waiting = q('canvas-filed-waiting')!
    expect(card).toBeTruthy()
    expect(q('round-open-pill')!.textContent).toBe('OPEN')
    expect(card.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('names what is still owed when an approval did NOT sign the subject off', async () => {
    // Another artefact on the same canvas is still with the agent, so the pane
    // did not go to its front page — and without this line the only signal
    // would be the absence of one.
    useCanvasStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: CID,
          versions: [
            { ...designVersion('v2'), mode: 'plan', verdict: { state: 'rejected', by: 'user', at: 'x' } } as CanvasVersion,
            designVersion('v8'),
          ],
          activeVersionId: 'v8',
          loaded: true,
        },
      },
    } as never)
    current = emptyState({
      reviews: [
        { id: 'R1', canvas: { canvasId: CID, sessionId: SID }, versionId: 'v2', annotationIds: ['a9'], status: 'submitted', createdAt: 'x' },
      ],
      annotations: [{ ...note('a9'), reviewId: 'R1', versionId: 'v2' }],
    })
    await render()
    await act(async () => q('decision-approve')!.click())
    await act(async () => {
      ;(q('canvas-submit') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(q('canvas-filed-waiting')!.textContent).toBe('Approved v8 · another round is still with the agent')
  })
})

// ── Item 11: a note row tile is not the composer's ──────────────────────────

describe('image tiles say which list they belong to', () => {
  it('numbers a note images under their own testid', async () => {
    current = emptyState({
      reviews: [{ ...draftReview, annotationIds: ['a1'] }],
      annotations: [
        note('a1', { images: [{ pngPath: 'reviews/pasted/a1-0.png' }, { pngPath: 'reviews/pasted/a1-1.png' }] }),
      ],
    })
    await render()
    expect(q('note-image-1')!.textContent).toContain('Image 1')
    expect(q('note-image-2')!.textContent).toContain('Image 2')
    // …and the composer's own list is empty, so nothing answers to its family.
    expect(q('composer-image-1')).toBeNull()
  })
})

// ── Items 13 + 14: what survives Add note, and what a target belongs to ─────

describe('Add note empties the words, not the decision or the drawing', () => {
  it('re-persists the draft with its decision and scene instead of clearing it', async () => {
    const scene = { scene: '[{"id":"s1"}]', versions: { s1: 'v8' } }
    await render(designVersion(), { getSketchSceneForPersist: () => scene })
    await act(async () => q('decision-reject')!.click())
    await type('the header is heavy')
    await act(async () => {
      ;(q('composer-add-note') as HTMLElement).click()
      await Promise.resolve()
    })
    // Never cleared outright: the user's decision about the version has not
    // changed and the glass still holds what they drew.
    expect(clears).toBe(0)
    const last = savedDrafts[savedDrafts.length - 1]
    expect(last).toMatchObject({ text: '', images: [], decision: 'reject', sketch: scene })
    expect(textarea().value).toBe('')
  })
})

describe('a restored target belongs to the version it was locked on', () => {
  const focusOn = (versionId: string) => ({
    targets: [{ kind: 'ux-id' as const, id: 'save' }],
    bboxPage: { x: 1, y: 2, width: 3, height: 4 },
    label: 'button "Save"',
    versionId,
  })

  it('comes back on its own version', async () => {
    current = emptyState({
      composer: { versionId: 'v8', text: 'about the button', images: [], focus: focusOn('v8'), updatedAt: 'x' },
    })
    await render(designVersion('v8'))
    expect(useCanvasReviewStore.getState().bySessionId[SID]?.focus?.label).toBe('button "Save"')
  })

  it('is NOT re-pointed onto a later render — a box measured on v8 is elsewhere on v9', async () => {
    useCanvasStore.setState({
      bySessionId: {
        [SID]: { canvasId: CID, versions: [designVersion('v8'), designVersion('v9')], activeVersionId: 'v9', loaded: true },
      },
    } as never)
    current = emptyState({
      composer: { versionId: 'v8', text: 'about the button', images: [], focus: focusOn('v8'), updatedAt: 'x' },
    })
    await render(designVersion('v9'))
    // The words come back; the target does not, and the note simply starts
    // untargeted rather than pointing somewhere nobody chose.
    expect(textarea().value).toBe('about the button')
    expect(useCanvasReviewStore.getState().bySessionId[SID]?.focus).toBeNull()
  })
})

// ── N1: strokes are taken ONCE ─────────────────────────────────────────────

describe('a drawing cannot ride two notes', () => {
  it('disarms Add note once the strokes are on a note, so a second click files no duplicate', async () => {
    // Taking strokes onto a note changes nothing about the GLASS — no revision
    // bump, so nothing re-rendered the stroke count. "1 stroke will ride this
    // note" stayed armed and a second click filed a duplicate carrying the same
    // drawing.
    await render(designVersion(), { getUnattachedSketchElementIds: () => ['s1'] })
    expect(q('composer-strokes-ride')).not.toBeNull()
    await act(async () => {
      ;(q('composer-add-note') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(upserts).toHaveLength(1)
    expect(upserts[0].sketch?.excalidrawElementIds).toEqual(['s1'])
    // The stroke is now on a draft note, so nothing offers it again…
    expect(q('composer-strokes-ride')).toBeNull()
    expect((q('composer-add-note') as HTMLButtonElement).disabled).toBe(true)
    // …and a second click cannot file anything at all.
    await act(async () => {
      ;(q('composer-add-note') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(upserts).toHaveLength(1)
  })
})

// ── N2: a refused submit does not take the words with it ───────────────────

describe('a refused submit leaves the composer where it was', () => {
  it('puts the text and the decision back when the verdict is refused', async () => {
    ;(window as any).electronAPI.canvas.versionVerdict.mockResolvedValueOnce({ error: 'that version is already decided' })
    await render()
    await type('words I have not sent anywhere else')
    await act(async () => q('decision-approve')!.click())
    await act(async () => {
      ;(q('canvas-submit') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(q('canvas-submit-error')!.textContent).toContain('already decided')
    // The only copy of those words was on screen.
    expect(textarea().value).toBe('words I have not sent anywhere else')
    expect(q('canvas-submit')!.textContent).toContain('Approve v8')
  })

  it('puts them back when the ROUND submit is refused', async () => {
    ;(window as any).electronAPI.canvas.reviewSubmit.mockRejectedValueOnce(new Error('disk is full'))
    current = emptyState({ reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [note('a1')] })
    await render()
    await type('still being written')
    await act(async () => q('decision-reject')!.click())
    await act(async () => {
      ;(q('canvas-submit') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(q('canvas-submit-error')).not.toBeNull()
    expect(textarea().value).toBe('still being written')
    // …and it saves again from there, rather than sitting un-persisted.
    await act(async () => vi.advanceTimersByTime(COMPOSER_SAVE_DEBOUNCE_MS + 50))
    expect(savedDrafts[savedDrafts.length - 1].text).toBe('still being written')
  })
})


// ── N5: nothing reaches disk while a submit is in flight ───────────────────

describe('a paste landing mid-submit does not resurrect the composer', () => {
  it('never reaches composerDraftSet while the round is being filed', async () => {
    // The reviewer's repro, and the one the debounce cancel alone does NOT
    // cover: a paste persists IMMEDIATELY, so it skips the timer entirely and
    // races the submit's own awaits. Remove the submittingRef bail in
    // persistComposer and this test fails.
    let releaseSubmit: (v: unknown) => void = () => {}
    ;(window as any).electronAPI.canvas.reviewSubmit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSubmit = resolve
        }),
    )
    current = emptyState({ reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [note('a1')] })
    await render()
    await act(async () => q('decision-reject')!.click())
    savedDrafts.length = 0
    // Submit, and leave it hanging.
    await act(async () => {
      ;(q('canvas-submit') as HTMLElement).click()
      await Promise.resolve()
    })
    expect((window as any).electronAPI.canvas.reviewSubmit).toHaveBeenCalledTimes(1)
    // A screenshot arrives while the round is in flight.
    await pasteImage()
    expect(savedDrafts).toHaveLength(0)
    // Let the submit land; still nothing written back.
    await act(async () => {
      releaseSubmit(current)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => vi.advanceTimersByTime(2000))
    expect(savedDrafts).toHaveLength(0)
  })
})
