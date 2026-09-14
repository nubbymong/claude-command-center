// @vitest-environment jsdom
//
// Testing mode's composer (M3) — the PANEL's half of the evidence seam.
//
// The pane owns the screenshot and the pause; this file is about what the note
// record ends up carrying, what survives a pane switch, and what a mockup's
// composer must go on doing exactly as before. The seam is a stub here on
// purpose: the point is which calls the composer makes and what it puts in the
// draft, not what a real capture returns.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { paneSketchProps } from './canvas-panel-harness'
import type {
  Annotation,
  CanvasAnnotationDraft,
  CanvasReviewState,
  CanvasVersion,
  ComposerDraft,
  ComposerDraftInput,
  Review,
  TrailEntry,
} from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn(async () => new Blob([new Uint8Array([1])])) }))
const PNG = 'iVBORw0KGgo='
vi.mock('../../../src/renderer/utils/canvasPasteImage', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  return { ...real, pastedImageToPng: vi.fn(async () => ({ pngBase64: PNG })) }
})

const panelModule = await import('../../../src/renderer/components/CanvasNotesPanel')
const CanvasNotesPanel = panelModule.default
type CanvasEvidenceSeam = import('../../../src/renderer/components/CanvasNotesPanel').CanvasEvidenceSeam
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')

const SID = 'session-1'
const CID = 'canvas-a'
const EVIDENCE_ID = '0123456789abcdef01234567'

const uatVersion = (over: Partial<CanvasVersion> = {}): CanvasVersion =>
  ({
    id: 'v4',
    mode: 'uat',
    createdAt: '2026-08-29T10:00:00Z',
    source: { mode: 'uat', distRoot: 'C:/build', entry: 'index.html', buildLabel: '5' },
    ...over,
  }) as CanvasVersion
const designVersion = (): CanvasVersion =>
  ({ id: 'v8', mode: 'design', createdAt: '2026-08-29T10:00:00Z', source: { mode: 'design', entry: 'index.html' } }) as CanvasVersion

const draftReview: Review = {
  id: 'R3',
  canvas: { canvasId: CID, sessionId: SID },
  versionId: 'v4',
  annotationIds: [],
  status: 'draft',
  createdAt: '2026-08-29T10:05:00Z',
}

const RUN_TRAIL: TrailEntry[] = [
  { at: '2026-08-29T16:43:58.000Z', gapMs: 0, kind: 'click', target: { role: 'button', name: 'Checkout' } },
]

let current: CanvasReviewState
let savedDrafts: ComposerDraftInput[]
let upserts: CanvasAnnotationDraft[]
let submits: Array<{ trail?: TrailEntry[] }>
let seam: CanvasEvidenceSeam
let container: HTMLDivElement
let root: Root

function note(id: string, over: Partial<Annotation> = {}): Annotation {
  return { id, reviewId: 'R3', scope: 'general', note: `text of ${id}`, versionId: 'v4', state: 'open', ...over } as Annotation
}

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => current),
    reviewMarkSeen: vi.fn(async () => ({ state: current, seen: [] })),
    evidenceRead: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,SHOT' })),
    composerDraftSet: vi.fn(async ({ draft }: { draft: ComposerDraftInput }) => {
      savedDrafts.push(draft)
      const composer: ComposerDraft = {
        versionId: draft.versionId,
        ...(draft.decision ? { decision: draft.decision } : {}),
        text: draft.text,
        ...(draft.focus ? { focus: draft.focus } : {}),
        images: [],
        ...(draft.sketch ? { sketch: draft.sketch } : {}),
        ...(draft.evidenceId ? { evidenceId: draft.evidenceId } : {}),
        updatedAt: '2026-08-29T10:06:00Z',
      }
      current = { ...current, composer }
      return current
    }),
    composerDraftClear: vi.fn(async () => {
      current = { ...current, composer: undefined }
      return current
    }),
    annotationUpsert: vi.fn(async ({ draft }: { draft: CanvasAnnotationDraft }) => {
      upserts.push(draft)
      const id = `a${upserts.length}`
      const created = note(id, { note: draft.note })
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
    reviewSubmit: vi.fn(async (args: { trail?: TrailEntry[] }) => {
      submits.push({ trail: args.trail })
      current = {
        ...current,
        reviews: current.reviews.map((r) => (r.status === 'draft' ? { ...r, status: 'submitted' as const } : r)),
      }
      return current
    }),
    versionVerdict: vi.fn(async () => ({ canvasId: CID })),
  },
}

function makeSeam(over: Partial<CanvasEvidenceSeam> = {}): CanvasEvidenceSeam {
  return {
    pending: null,
    notice: null,
    begin: vi.fn(),
    discard: vi.fn(),
    lock: vi.fn(),
    adopt: vi.fn(),
    registerCancel: vi.fn(),
    runTrail: vi.fn(() => RUN_TRAIL),
    endRun: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  savedDrafts = []
  upserts = []
  submits = []
  current = { canvasId: CID, sessionId: SID, reviews: [], annotations: [] }
  seam = makeSeam()
  useCanvasReviewStore.setState({ bySessionId: {} })
  useCanvasStore.setState({ bySessionId: { [SID]: { canvasId: CID, versions: [uatVersion()], activeVersionId: 'v4', interactionMode: 'browse', emptyView: 'intro', unseenRender: false, loaded: true } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** The string "none" is how a test says NO seam. Passing `undefined` would
 *  trigger a default parameter instead, which is exactly the mistake this
 *  spelling keeps out of the harness. */
async function render(version: CanvasVersion = uatVersion(), override?: CanvasEvidenceSeam | 'none'): Promise<void> {
  const evidence = override === 'none' ? undefined : (override ?? seam)
  await act(async () => {
    root.render(
      <CanvasNotesPanel
        sessionId={SID}
        canvasId={CID}
        version={version}
        getGlassApi={() => null}
        onReturnToTerminal={() => {}}
        isActive
        evidence={evidence}
        {...paneSketchProps()}
      />,
    )
  })
}

const q = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)
const all = (id: string): HTMLElement[] => Array.from(container.querySelectorAll(`[data-testid="${id}"]`))
const textarea = (): HTMLTextAreaElement => q('composer-textarea') as HTMLTextAreaElement

async function type(value: string): Promise<void> {
  const el = textarea()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pasteImage(): Promise<void> {
  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } })
  Object.defineProperty(event, 'target', { value: document.body })
  await act(async () => {
    window.dispatchEvent(event)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('starting a note starts the capture', () => {
  it('when the caret lands in the composer', async () => {
    await render()
    await act(async () => {
      textarea().dispatchEvent(new FocusEvent('focus', { bubbles: false }))
      textarea().focus()
    })
    expect(seam.begin).toHaveBeenCalled()
  })

  it('when a screenshot is pasted in', async () => {
    await render()
    await pasteImage()
    expect(seam.begin).toHaveBeenCalled()
  })

  it('but never while a filed note is being re-worded', async () => {
    current = {
      ...current,
      reviews: [{ ...draftReview, annotationIds: ['a1'] }],
      annotations: [note('a1')],
    }
    await render()
    await act(async () => {
      useCanvasReviewStore.getState().setEditingAnnotation(SID, 'a1')
    })
    ;(seam.begin as ReturnType<typeof vi.fn>).mockClear()
    await act(async () => {
      textarea().focus()
    })
    await pasteImage()
    expect(seam.begin).not.toHaveBeenCalled()
  })
})

describe('the note locks the capture', () => {
  it('sends the evidence id with the note, and reports the lock', async () => {
    seam = makeSeam({ pending: { evidenceId: EVIDENCE_ID, previewDataUrl: 'data:image/png;base64,PREV' } })
    await render()
    await type('Button stays disabled')
    await act(async () => {
      q('composer-add-note')!.click()
    })
    expect(upserts[0]).toMatchObject({ note: 'Button stays disabled', versionId: 'v4', evidenceId: EVIDENCE_ID })
    expect(seam.lock).toHaveBeenCalledWith('a1')
  })

  it('lets a captured screen BE the note, with no words at all', async () => {
    seam = makeSeam({ pending: { evidenceId: EVIDENCE_ID } })
    await render()
    expect((q('composer-add-note') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      q('composer-add-note')!.click()
    })
    expect(upserts[0]).toMatchObject({ note: '', evidenceId: EVIDENCE_ID })
  })

  it('an EDIT keeps the note`s own evidence — it never takes the pending one', async () => {
    seam = makeSeam({ pending: { evidenceId: EVIDENCE_ID } })
    current = { ...current, reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [note('a1')] }
    await render()
    await act(async () => {
      useCanvasReviewStore.getState().setEditingAnnotation(SID, 'a1')
    })
    await type('re-worded')
    await act(async () => {
      q('composer-add-note')!.click()
    })
    expect(upserts[0].evidenceId).toBeUndefined()
    expect(seam.lock).not.toHaveBeenCalled()
  })
})

describe('a pending capture survives a pane switch', () => {
  it('rides the persisted composer draft', async () => {
    seam = makeSeam({ pending: { evidenceId: EVIDENCE_ID } })
    await render()
    await type('half a thought')
    await act(async () => {
      await new Promise((r) => setTimeout(r, panelModule.COMPOSER_SAVE_DEBOUNCE_MS + 30))
    })
    expect(savedDrafts.at(-1)).toMatchObject({ text: 'half a thought', evidenceId: EVIDENCE_ID })
  })

  it('is adopted back — onto its OWN version, and never another', async () => {
    current = {
      ...current,
      composer: { versionId: 'v4', text: 'came back', images: [], evidenceId: EVIDENCE_ID, updatedAt: '2026-08-29T10:06:00Z' },
    }
    await render()
    expect(seam.adopt).toHaveBeenCalledWith(EVIDENCE_ID)

    // A draft written on an EARLIER version of the same run keeps its words but
    // not its screenshot: that shot is of a different build.
    ;(seam.adopt as ReturnType<typeof vi.fn>).mockClear()
    useCanvasReviewStore.setState({ bySessionId: {} })
    current = {
      ...current,
      composer: { versionId: 'v3', text: 'older', images: [], evidenceId: EVIDENCE_ID, updatedAt: '2026-08-29T10:06:00Z' },
    }
    useCanvasStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: CID,
          versions: [uatVersion({ id: 'v3' } as Partial<CanvasVersion>), uatVersion()],
          activeVersionId: 'v4',
          interactionMode: 'browse',
          emptyView: 'intro',
          unseenRender: false,
          loaded: true,
        },
      },
    })
    await act(() => root.unmount())
    root = createRoot(container)
    await render()
    expect(seam.adopt).not.toHaveBeenCalled()
  })
})

describe('cancelling a note', () => {
  it('throws the capture away with the words, and hands the pane the same button', async () => {
    seam = makeSeam({ pending: { evidenceId: EVIDENCE_ID } })
    await render()
    await type('never mind')
    expect(seam.registerCancel).toHaveBeenCalled()
    await act(async () => {
      q('composer-cancel-note')!.click()
    })
    expect(seam.discard).toHaveBeenCalled()
    expect(textarea().value).toBe('')
  })

  it('offers no Cancel when there is nothing to cancel', async () => {
    await render()
    expect(q('composer-cancel-note')).toBeNull()
  })
})

describe('this run, as a list of screens', () => {
  beforeEach(() => {
    current = {
      ...current,
      reviews: [{ ...draftReview, annotationIds: ['a1'] }],
      annotations: [
        note('a1', {
          note: 'Total ignores the discount code',
          evidence: {
            shotPath: 'reviews/evidence/a1.png',
            width: 800,
            height: 600,
            stamp: {
              capturedAt: '2026-08-29T16:41:00.000Z',
              route: '/cart',
              viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, dpr: 1, zoom: 1 },
              dialogs: [],
              fields: [],
            },
            trail: [],
          },
        } as unknown as Partial<Annotation>),
      ],
    }
  })

  it('names the run, shows the screen, and marks the route as the page`s word', async () => {
    await render()
    expect(q('canvas-run-notes')!.textContent).toContain('This run · 1 note')
    expect(q('run-note-meta')!.textContent).toContain('page-reported /cart')
    // The clock is the reader's own — asserted against the same conversion the
    // row does rather than a literal, so the suite does not depend on the
    // machine's time zone.
    const local = new Date(Date.parse('2026-08-29T16:41:00.000Z'))
    const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`
    expect(q('run-note-meta')!.textContent).toContain(hhmm)
  })

  it('reads the saved screen back for a thumbnail it did not capture itself', async () => {
    await render()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(window.electronAPI.canvas.evidenceRead).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: CID,
      path: 'reviews/evidence/a1.png',
    })
    expect(q('run-note-thumb')!.querySelector('img')).not.toBeNull()
  })
})

describe('the round the run files', () => {
  it('carries the whole run`s trail, and ends the run', async () => {
    current = {
      ...current,
      reviews: [{ ...draftReview, annotationIds: ['a1'] }],
      annotations: [note('a1')],
    }
    await render()
    await act(async () => {
      q('decision-reject')!.click()
    })
    await act(async () => {
      q('canvas-submit')!.click()
      await Promise.resolve()
    })
    expect(submits[0].trail).toEqual(RUN_TRAIL)
    expect(seam.endRun).toHaveBeenCalled()
    expect(seam.discard).toHaveBeenCalled()
  })

  it('says Pass / Fail and counts defects, not notes', async () => {
    current = { ...current, reviews: [{ ...draftReview, annotationIds: ['a1'] }], annotations: [note('a1')] }
    await render()
    await act(async () => {
      q('decision-reject')!.click()
    })
    expect(q('decision-approve')!.textContent).toBe('Pass build 5')
    expect(q('canvas-submit')!.textContent).toBe('Submit test — Fail, 1 defect')
  })
})

describe('a mockup composer is untouched', () => {
  it('has no run list, no Cancel, and still says Add note', async () => {
    useCanvasStore.setState({
      bySessionId: {
        [SID]: { canvasId: CID, versions: [designVersion()], activeVersionId: 'v8', interactionMode: 'browse', emptyView: 'intro', unseenRender: false, loaded: true },
      },
    })
    current = { ...current, reviews: [{ ...draftReview, versionId: 'v8', annotationIds: ['a1'] }], annotations: [note('a1', { versionId: 'v8' })] }
    await render(designVersion(), 'none')
    expect(q('canvas-run-notes')).toBeNull()
    expect(q('your-notes')).not.toBeNull()
    expect(q('composer-cancel-note')).toBeNull()
    expect(q('composer-add-note')!.textContent).toBe('Add note')
    expect(all('composer-evidence')).toHaveLength(0)
  })

  it('files a round with no trail on it at all', async () => {
    useCanvasStore.setState({
      bySessionId: {
        [SID]: { canvasId: CID, versions: [designVersion()], activeVersionId: 'v8', interactionMode: 'browse', emptyView: 'intro', unseenRender: false, loaded: true },
      },
    })
    current = { ...current, reviews: [{ ...draftReview, versionId: 'v8', annotationIds: ['a1'] }], annotations: [note('a1', { versionId: 'v8' })] }
    await render(designVersion(), 'none')
    await act(async () => {
      q('decision-reject')!.click()
    })
    await act(async () => {
      q('canvas-submit')!.click()
      await Promise.resolve()
    })
    expect(submits[0].trail).toBeUndefined()
  })
})
