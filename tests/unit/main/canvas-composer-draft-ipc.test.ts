// The composer-draft channels at the SEAM (W14).
//
// The payload here is unlike every other canvas write: it carries free user
// prose, base64 image bytes, and an Excalidraw scene main never parses. So the
// question this file answers is not "does the store do the right thing" (that is
// canvas-note-images) but "does a malformed or oversized payload die at the
// boundary, before the store is touched at all".

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import { MAX_NOTE_IMAGES, MAX_NOTE_CHARS, MAX_SKETCH_SCENE_BYTES, MAX_SKETCH_SCENE_ELEMENTS } from '../../../src/shared/canvas'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {},
  },
  BrowserWindow: vi.fn(),
}))

const reviewMock = vi.hoisted(() => ({
  setComposerDraft: vi.fn(() => ({ canvasId: 'canvas-a', sessionId: 'x', reviews: [], annotations: [] })),
  clearComposerDraft: vi.fn(() => ({ canvasId: 'canvas-a', sessionId: 'x', reviews: [], annotations: [] })),
}))

vi.mock('../../../src/main/canvas/canvas-review-store', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  return { ...real, setComposerDraft: reviewMock.setComposerDraft, clearComposerDraft: reviewMock.clearComposerDraft }
})

const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const CID = 'c1c2c3c4c5c6c7c8c9c0d1d2'
const invoke = (ch: string, args: unknown) => handlers.get(ch)!({} as never, args)

const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('body'),
]).toString('base64')

/** A payload the seam should accept, so each rejection below differs from it in
 *  exactly one way. */
function goodDraft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { versionId: 'v3', text: 'half a thought', images: [], ...over }
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerCanvasHandlers(() => null)
})

describe('registration', () => {
  it('registers both composer channels', () => {
    expect(handlers.has(IPC.CANVAS_COMPOSER_DRAFT_SET)).toBe(true)
    expect(handlers.has(IPC.CANVAS_COMPOSER_DRAFT_CLEAR)).toBe(true)
  })
})

describe('the set channel accepts what the composer really sends', () => {
  it('passes a full draft through to the store, unaltered', async () => {
    const draft = goodDraft({
      decision: 'reject',
      focus: { targets: [{ kind: 'ux-id', id: 'save' }], bboxPage: { x: 1, y: 2, width: 3, height: 4 }, label: 'button "Save"', versionId: 'v3' },
      images: [{ pngBase64: PNG_B64 }, 'keep', { keepIndex: 0 }],
      sketch: { scene: '[{"id":"e1"}]', versions: { e1: 'v3' } },
    })
    await invoke(IPC.CANVAS_COMPOSER_DRAFT_SET, { sessionId: SID, canvasId: CID, draft })
    expect(reviewMock.setComposerDraft).toHaveBeenCalledWith(SID, CID, draft)
  })

  it('accepts an empty text and an empty image list — a draft can be just a target', async () => {
    await invoke(IPC.CANVAS_COMPOSER_DRAFT_SET, { sessionId: SID, canvasId: CID, draft: goodDraft({ text: '' }) })
    expect(reviewMock.setComposerDraft).toHaveBeenCalledTimes(1)
  })
})

describe('a malformed draft dies at the boundary, never in the store', () => {
  const refused = async (draft: unknown): Promise<void> => {
    await expect(invoke(IPC.CANVAS_COMPOSER_DRAFT_SET, { sessionId: SID, canvasId: CID, draft })).rejects.toThrow()
    expect(reviewMock.setComposerDraft).not.toHaveBeenCalled()
  }

  it('refuses a version id that is not the shape the store mints', () => refused(goodDraft({ versionId: '../../etc' })))

  it('refuses a decision that is not one of the two', () => refused(goodDraft({ decision: 'maybe' })))

  it('refuses text past the note cap', () => refused(goodDraft({ text: 'x'.repeat(MAX_NOTE_CHARS + 1) })))

  it('refuses more images than a note may carry', () =>
    refused(goodDraft({ images: Array.from({ length: MAX_NOTE_IMAGES + 1 }, () => 'keep') })))

  it('refuses a keep index outside the list', () => refused(goodDraft({ images: [{ keepIndex: MAX_NOTE_IMAGES }] })))

  it('refuses a scene past the byte cap — main never parses it, so this is the only bound', () =>
    refused(goodDraft({ sketch: { scene: 'a'.repeat(MAX_SKETCH_SCENE_BYTES + 1), versions: {} } })))

  it('refuses a version STAMP that is not a version id — the map is not a free key/value store', () =>
    refused(goodDraft({ sketch: { scene: '[]', versions: { e1: 'not-a-version' } } })))

  it('refuses an unknown field rather than dropping it silently', () => refused(goodDraft({ surprise: 1 })))

  it('refuses more drawing stamps than the element cap, at the seam', async () => {
    const versions: Record<string, string> = {}
    for (let i = 0; i <= MAX_SKETCH_SCENE_ELEMENTS; i++) versions['e' + i] = 'v3'
    await refused(goodDraft({ sketch: { scene: '[]', versions } }))
  })

  it('accepts a stamps map far larger than any single note may carry', async () => {
    // The count is bounded by what it actually bounds — glass elements — so a
    // legitimate large drawing is not refused by a per-note limit it has nothing
    // to do with.
    const versions: Record<string, string> = {}
    for (let i = 0; i < 900; i++) versions['e' + i] = 'v3'
    await invoke(IPC.CANVAS_COMPOSER_DRAFT_SET, { sessionId: SID, canvasId: CID, draft: goodDraft({ sketch: { scene: '[]', versions } }) })
    expect(reviewMock.setComposerDraft).toHaveBeenCalledTimes(1)
  })


  it('refuses a canvas id shaped like a path', async () => {
    await expect(
      invoke(IPC.CANVAS_COMPOSER_DRAFT_SET, { sessionId: SID, canvasId: '../other', draft: goodDraft() }),
    ).rejects.toThrow()
    expect(reviewMock.setComposerDraft).not.toHaveBeenCalled()
  })

  it('refuses a call that names no canvas — the ownership check has nothing to check', async () => {
    await expect(invoke(IPC.CANVAS_COMPOSER_DRAFT_SET, { sessionId: SID, draft: goodDraft() })).rejects.toThrow()
    expect(reviewMock.setComposerDraft).not.toHaveBeenCalled()
  })
})

describe('the clear channel', () => {
  it('passes the session and canvas through', async () => {
    await invoke(IPC.CANVAS_COMPOSER_DRAFT_CLEAR, { sessionId: SID, canvasId: CID })
    expect(reviewMock.clearComposerDraft).toHaveBeenCalledWith(SID, CID)
  })

  it('refuses anything else', async () => {
    await expect(invoke(IPC.CANVAS_COMPOSER_DRAFT_CLEAR, { sessionId: SID })).rejects.toThrow()
    await expect(invoke(IPC.CANVAS_COMPOSER_DRAFT_CLEAR, { sessionId: SID, canvasId: CID, draft: {} })).rejects.toThrow()
    expect(reviewMock.clearComposerDraft).not.toHaveBeenCalled()
  })
})
