// canvas_pick, store half (#373 follow-on): the user names the winning variant
// in CHAT and the agent records it. What this file pins:
//
//  - The write is the narrowest agent write in the store: one addressed note,
//    one key, and only among variants the agent attached when it addressed the
//    note. Every other position fails closed with its own message.
//  - Provenance is structural: 'approved' + closedBy 'agent' exists ONLY with
//    pickSource 'chat', and pickSource 'chat' exists ONLY in that position —
//    the validator refuses a hand-edited record wearing either half alone, so
//    a chat pick can never be mistaken for (or forged into) a click-approval.
//  - Reopen is the undo: the note returns to 'addressed', the choice and its
//    chat stamp die, the variants survive.
//  - The serializer says which kind of pick it was: `(picked in chat)`.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-chat-pick-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const store = await import('../../../src/main/canvas/canvas-review-store')
const { serializeReviewPayload } = await import('../../../src/shared/canvas-review-serialize')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

function renderCanvas(): { canvasId: string; versionId: string } {
  return canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>page</p>' })
}

function noteOf(state: import('../../../src/shared/canvas').CanvasReviewState, id: string) {
  return state.annotations.find((a) => a.id === id)!
}

/** Two open notes on a submitted R1: a1 and a2. */
function submittedRound(): { versionId: string } {
  const { versionId } = renderCanvas()
  store.upsertAnnotation(SID, { scope: 'general', note: 'first', versionId })
  store.upsertAnnotation(SID, { scope: 'general', note: 'second', versionId })
  store.submitReview(SID, 'R1', [])
  return { versionId }
}

/** One-note round, addressed with two variants — the smallest pickable board. */
function pickableNote(labels: string[] = ['thin rule', 'no rule']): void {
  const { versionId } = renderCanvas()
  store.upsertAnnotation(SID, { scope: 'general', note: 'only', versionId })
  store.submitReview(SID, 'R1', [])
  store.markAnnotationsAddressed(SID, 'R1', ['a1'], { a1: labels })
}

beforeEach(() => {
  store._resetCanvasReviewStoreForTest()
  canvasStore._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('recordChatPick — the write', () => {
  it('approves the note with the chosen key and full chat-pick provenance', () => {
    submittedRound()
    store.markAnnotationsAddressed(SID, 'R1', ['a1', 'a2'], { a1: ['thin rule', 'no rule'] })
    const r = store.recordChatPick(SID, 'R1', 'a1', 'B')
    expect(r.pickedLabel).toBe('no rule')
    const a1 = noteOf(r.state, 'a1')
    expect(a1.state).toBe('approved')
    expect(a1.chosenVariantKey).toBe('B')
    expect(a1.closedBy).toBe('agent')
    expect(a1.closedFrom).toBe('addressed')
    expect(a1.pickSource).toBe('chat')
    // a2 was untouched, and still live — so the round stays open.
    expect(noteOf(r.state, 'a2').state).toBe('addressed')
    expect(r.reviewClosed).toBe(false)
  })

  it('closes the round when the pick ends its last live note', () => {
    pickableNote()
    const r = store.recordChatPick(SID, 'R1', 'a1', 'A')
    expect(r.reviewClosed).toBe(true)
    expect(r.state.reviews.find((rv) => rv.id === 'R1')?.status).toBe('resolved')
  })

  it('does NOT require the user to have seen the addressed note first (the chat message is the evidence)', () => {
    // Unlike closeAnnotationsByAgent: no markAddressedNotesSeen anywhere in
    // this test, and the pick still lands.
    pickableNote()
    const r = store.recordChatPick(SID, 'R1', 'a1', 'B')
    expect(noteOf(r.state, 'a1').state).toBe('approved')
  })
})

describe('recordChatPick — every gate fails closed', () => {
  it('refuses malformed ids and keys before reading anything', () => {
    pickableNote()
    expect(() => store.recordChatPick(SID, 'nope', 'a1', 'A')).toThrow(/invalid review id/)
    expect(() => store.recordChatPick(SID, 'R1', 'nope', 'A')).toThrow(/invalid annotation id/)
    for (const bad of ['E', 'AB', 'a', 'b', '1', '', ' A']) {
      expect(() => store.recordChatPick(SID, 'R1', 'a1', bad)).toThrow(/invalid variant key/)
    }
  })

  it('refuses a round that does not exist on this canvas', () => {
    pickableNote()
    expect(() => store.recordChatPick(SID, 'R7', 'a1', 'A')).toThrow(/review not on this canvas/)
  })

  it('refuses a draft round', () => {
    const { versionId } = renderCanvas()
    store.upsertAnnotation(SID, { scope: 'general', note: 'unsubmitted', versionId })
    expect(() => store.recordChatPick(SID, 'R1', 'a1', 'A')).toThrow(/review is still a draft/)
  })

  it('refuses a note that is not on the named round (and an unknown note)', () => {
    submittedRound()
    store.markAnnotationsAddressed(SID, 'R1', ['a1', 'a2'], { a1: ['one', 'two'] })
    // A second round with its own note.
    const versionId = canvasStore.getCanvasStateForSession(SID)!.activeVersionId!
    store.upsertAnnotation(SID, { scope: 'general', note: 'third', versionId })
    store.submitReview(SID, 'R2', [])
    expect(() => store.recordChatPick(SID, 'R2', 'a1', 'A')).toThrow(/note not on this review/)
    expect(() => store.recordChatPick(SID, 'R1', 'a3', 'A')).toThrow(/note not on this review/)
    expect(() => store.recordChatPick(SID, 'R1', 'a99', 'A')).toThrow(/note not on this review/)
  })

  it('refuses an OPEN note — variants only exist once the agent addressed it', () => {
    submittedRound()
    expect(() => store.recordChatPick(SID, 'R1', 'a1', 'A')).toThrow(/note is still open/)
  })

  it('refuses a note already ruled on', () => {
    pickableNote()
    const canvasId = store.getReviewStateForSession(SID)!.canvasId
    store.resolveAnnotation(SID, 'a1', 'approve', canvasId, 'A')
    expect(() => store.recordChatPick(SID, 'R1', 'a1', 'B')).toThrow(/note is already ruled on/)
  })

  it('refuses an addressed note with no variants', () => {
    submittedRound()
    store.markAnnotationsAddressed(SID, 'R1', ['a1'])
    expect(() => store.recordChatPick(SID, 'R1', 'a1', 'A')).toThrow(/note has no variants/)
  })

  it('refuses a key the note does not offer', () => {
    pickableNote(['one', 'two'])
    expect(() => store.recordChatPick(SID, 'R1', 'a1', 'C')).toThrow(/variant not offered on this note/)
    // Nothing landed.
    expect(noteOf(store.getReviewStateForSession(SID)!, 'a1').state).toBe('addressed')
  })
})

describe('reopen is the undo', () => {
  it('returns the note to addressed; the choice and the chat stamp die, the variants survive', () => {
    pickableNote(['left', 'right'])
    store.recordChatPick(SID, 'R1', 'a1', 'B')
    const state = store.reopenAnnotation(SID, 'a1')
    const a1 = noteOf(state, 'a1')
    expect(a1.state).toBe('addressed')
    expect(a1.chosenVariantKey).toBeUndefined()
    expect(a1.pickSource).toBeUndefined()
    expect(a1.closedBy).toBeUndefined()
    expect(a1.variants).toEqual([
      { key: 'A', label: 'left' },
      { key: 'B', label: 'right' },
    ])
    // And the round is live again, so a fresh pick can land.
    const r2 = store.recordChatPick(SID, 'R1', 'a1', 'A')
    expect(noteOf(r2.state, 'a1').chosenVariantKey).toBe('A')
  })
})

describe('restart round-trip and the file validator', () => {
  function reviewsPathFor(): string {
    const canvasId = store.getReviewStateForSession(SID)!.canvasId
    return path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
  }

  function mutateOnDisk(mutate: (rec: any) => void) {
    const p = reviewsPathFor()
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'))
    mutate(rec)
    fs.writeFileSync(p, JSON.stringify(rec))
    store._resetCanvasReviewStoreForTest()
  }

  it('a chat pick survives a restart with its provenance intact', () => {
    pickableNote(['thin rule', 'no rule'])
    store.recordChatPick(SID, 'R1', 'a1', 'B')
    store._resetCanvasReviewStoreForTest()
    canvasStore._resetCanvasStoreForTest()
    const a1 = noteOf(store.getReviewStateForSession(SID)!, 'a1')
    expect(a1.state).toBe('approved')
    expect(a1.chosenVariantKey).toBe('B')
    expect(a1.closedBy).toBe('agent')
    expect(a1.pickSource).toBe('chat')
  })

  it('still refuses a forged click-approval: approved + agent WITHOUT the chat stamp', () => {
    pickableNote()
    store.recordChatPick(SID, 'R1', 'a1', 'A')
    mutateOnDisk((rec) => {
      delete rec.annotations[0].pickSource
    })
    // The record is refused whole, and writes are latched off.
    expect(store.getReviewStateForSession(SID)!.annotations).toEqual([])
    expect(() => store.recordChatPick(SID, 'R1', 'a1', 'A')).toThrow(/review store unreadable/)
  })

  it('refuses the chat stamp anywhere but an agent-recorded pick', () => {
    const forge = (mutate: (a: any) => void) => {
      store._resetCanvasReviewStoreForTest()
      canvasStore._resetCanvasStoreForTest()
      fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
      pickableNote()
      store.recordChatPick(SID, 'R1', 'a1', 'A')
      mutateOnDisk((rec) => mutate(rec.annotations[0]))
      expect(store.getReviewStateForSession(SID)!.annotations).toEqual([])
    }
    // On a USER-closed note: would launder the pick into "the user clicked".
    forge((a) => {
      a.closedBy = 'user'
    })
    // Without a choice: provenance describing a pick that is not there.
    forge((a) => {
      delete a.chosenVariantKey
    })
    // A value outside the vocabulary.
    forge((a) => {
      a.pickSource = 'click'
    })
    // On a non-approved state.
    forge((a) => {
      a.state = 'dismissed'
    })
  })
})

describe('the serializer says which kind of pick it was', () => {
  it('emits (picked in chat) for a chat pick and nothing extra for a click', () => {
    const base = {
      id: 'a1',
      reviewId: 'R1',
      scope: 'general' as const,
      note: 'n',
      versionId: 'v1',
      state: 'approved' as const,
      variants: [
        { key: 'A', label: 'one' },
        { key: 'B', label: 'two' },
      ],
      chosenVariantKey: 'B',
    }
    const chat = serializeReviewPayload(
      { reviewId: 'R1', versionId: 'v1', annotations: [], generalNotes: [{ ...base, closedBy: 'agent', pickSource: 'chat' }] } as any,
      [],
    )
    expect(chat.text).toContain('chosen-variant: B (picked in chat)')
    const click = serializeReviewPayload(
      { reviewId: 'R1', versionId: 'v1', annotations: [], generalNotes: [{ ...base, closedBy: 'user' }] } as any,
      [],
    )
    expect(click.text).toContain('chosen-variant: B')
    expect(click.text).not.toContain('picked in chat')
  })
})
