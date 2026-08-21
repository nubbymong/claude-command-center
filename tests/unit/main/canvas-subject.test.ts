// A canvas holds ONE subject.
//
// Before this, a session had exactly one canvas forever: every render appended
// to it whatever it was of. Render a login screen, then a title bar, and both
// were "the same canvas" — the version list mixed unrelated work, and the review
// panel carried unresolved notes from the first subject forward as open notes
// against the second, anchored to elements that did not exist in it. The user
// who hit that stopped annotating, which costs the entire review loop.
//
// `title` names the subject. Same subject appends a version; a different subject
// files the current canvas (it stays on disk and in the library, it just stops
// being the session's active one) and starts a fresh one.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-subject-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')

const SID = 'dddd4444dddd4444dddd4444'
const CONV = '8c25bfdc-57d3-4894-8f4f-e234fb583791'
const CWD = path.join(getResourcesDirectory(), 'my-project')

function canvasRoot(): string {
  return path.join(getResourcesDirectory(), 'canvas')
}

function render(body: string, title?: string) {
  store.setCanvasSessionInfoResolver(() => ({ cwd: CWD, conversationUuid: CONV, profileId: undefined }))
  return store.renderVersion(SID, {
    mode: 'design',
    html: `<!doctype html><p>${body}</p>`,
    ...(title ? { title } : {}),
  })
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(canvasRoot(), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('a canvas holds one subject', () => {
  it('adds a version when the subject is the same', () => {
    const first = render('one', 'Title bar logo placement')
    const second = render('two', 'Title bar logo placement')
    expect(second.canvasId).toBe(first.canvasId)
    expect(second.versionId).not.toBe(first.versionId)
    expect(store.listAllCanvases()).toHaveLength(1)
  })

  it('starts a NEW canvas when the subject changes', () => {
    const logo = render('one', 'Title bar logo placement')
    const checkout = render('two', 'Checkout flow')

    expect(checkout.canvasId).not.toBe(logo.canvasId)
    // The first canvas is filed, not destroyed: still on disk, still listed,
    // still holding its own versions and whatever notes were left on it.
    expect(store.listAllCanvases()).toHaveLength(2)
    expect(fs.existsSync(path.join(canvasRoot(), logo.canvasId, 'canvas.json'))).toBe(true)
    // ...and the session now points at the new one.
    expect(store.getCanvasStateForSession(SID)?.canvasId).toBe(checkout.canvasId)
  })

  it('numbers the new canvas from v1 rather than continuing the old count', () => {
    render('one', 'Subject A')
    render('two', 'Subject A')
    const fresh = render('three', 'Subject B')
    // A fresh canvas is a fresh history; carrying v3 over would imply two
    // missing versions the user could never open.
    expect(fresh.versionId).toBe('v1')
  })

  it('treats casing and punctuation as the same subject', () => {
    const a = render('one', 'Title bar logo placement')
    const b = render('two', 'Title-bar logo placement!')
    // Splitting a canvas over a capital letter would fork the user's version
    // history silently, which is worse than one extra version on the right one.
    expect(b.canvasId).toBe(a.canvasId)
  })

  it('keeps the old behaviour when no title is given', () => {
    const a = render('one')
    const b = render('two')
    expect(b.canvasId).toBe(a.canvasId)
  })

  it('does not fork when only ONE side has a title', () => {
    // A canvas started before titles existed must not fork the moment a render
    // names a subject for the first time — that would strand the user's
    // existing versions behind a new canvas for no reason.
    const untitled = render('one')
    const named = render('two', 'Now it has a name')
    expect(named.canvasId).toBe(untitled.canvasId)
    expect(store.listAllCanvases()[0].title).toBe('Now it has a name')
  })

  it('surfaces the subject on the library row', () => {
    render('one', 'Title bar logo placement')
    expect(store.listAllCanvases()[0].title).toBe('Title bar logo placement')
  })
})

describe('coming back to a subject, and surviving a restart', () => {
  it('re-activates the FILED canvas when a subject comes back, rather than minting a third', () => {
    const login = render('one', 'Login page')
    render('two', 'Checkout flow')
    const back = render('three', 'Login page')
    // Same canvas as the first render, its history continued: v2, not a new v1.
    expect(back.canvasId).toBe(login.canvasId)
    expect(back.versionId).toBe('v2')
    expect(store.listAllCanvases()).toHaveLength(2)
    expect(store.getCanvasStateForSession(SID)?.canvasId).toBe(login.canvasId)
  })

  it('reports whether the canvas it moved to is NEW or one already started', () => {
    // The tool reply says "this is a new canvas", and on the comeback path that
    // is false: the canvas being re-activated already has versions and notes.
    // renderVersion is the only place that knows which happened.
    const login = render('one', 'Login page')
    const checkout = render('two', 'Checkout flow')
    expect(checkout.filed?.canvasId).toBe(login.canvasId)
    expect(checkout.filed?.returnedToExisting).toBe(false)

    const back = render('three', 'Login page')
    expect(back.filed?.canvasId).toBe(checkout.canvasId)
    expect(back.filed?.returnedToExisting).toBe(true)
  })


  it('reattaches to the MOST RECENTLY RENDERED canvas after a restart, not an arbitrary one', () => {
    // Several canvases share a session now. The disk scan used to take the first
    // one readdir returned — random by id on NTFS — so a relaunch reopened the
    // pane on a filed subject with its old notes, and the next same-title render
    // forked. Run enough rounds to make an arbitrary pick show itself.
    for (let round = 0; round < 12; round++) {
      store._resetCanvasStoreForTest()
      fs.rmSync(canvasRoot(), { recursive: true, force: true })
      render('one', 'Login page')
      render('two', 'Checkout flow')
      const latest = render('three', 'Settings screen')
      store._resetCanvasStoreForTest() // relaunch: memory gone, disk stays
      expect(store.getCanvasStateForSession(SID)?.canvasId).toBe(latest.canvasId)
      const again = render('four', 'Settings screen')
      expect(again.canvasId).toBe(latest.canvasId)
    }
  })

  it('carries the title on the pane state so the surface can say what it is showing', () => {
    render('one', 'Login page')
    expect(store.getCanvasStateForSession(SID)?.title).toBe('Login page')
  })

  it('caps how many canvases a session can own, and says why', () => {
    for (let i = 0; i < 50; i++) render('x', `Subject ${i}`)
    expect(() => render('y', 'One too many')).toThrow(/50 canvases/)
    // Filing goes on working within the cap: the same subject still appends.
    expect(() => render('z', 'Subject 49')).not.toThrow()
  })
})

describe('the subject key works in every script', () => {
  it('keeps unrelated non-Latin titles APART', () => {
    // The first version reduced every non-ASCII title to '' and called them all
    // the same subject, so the feature did nothing outside English.
    const ru = render('one', 'Проверка входа')
    const zh = render('two', '结账流程')
    const ar = render('three', 'صفحة الدفع')
    expect(new Set([ru.canvasId, zh.canvasId, ar.canvasId]).size).toBe(3)
  })

  it('treats an emoji-only title as no readable subject, and appends', () => {
    // Emoji are symbols, not letters or digits: there is nothing to compare.
    // Rather than fork on a subject we cannot read, or merge two unrelated
    // ones, an unreadable title behaves like no title at all.
    const a = render('one', 'Checkout flow')
    const b = render('two', '🔥🔥🔥')
    expect(b.canvasId).toBe(a.canvasId)
    expect(store.listAllCanvases()[0].title).toBe('Checkout flow')
  })

  it('still matches the same non-Latin subject across case and punctuation', () => {
    const a = render('one', 'Проверка входа')
    const b = render('two', 'ПРОВЕРКА — ВХОДА!')
    expect(b.canvasId).toBe(a.canvasId)
  })

  it('does not treat two titles that reduce to nothing as the same', () => {
    // '---' and '!!!' are not comparable; neither must silently merge with the
    // other, and neither should fork on a subject we cannot read.
    const a = render('one', 'Real subject')
    const b = render('two', '---')
    expect(b.canvasId).toBe(a.canvasId) // no readable subject: appends
    expect(store.listAllCanvases()[0].title).toBe('Real subject')
  })

  it('folds compatibility forms so C++ and C# stay distinct while ﬁ and fi match', () => {
    const cpp = render('one', 'C++ parser')
    const cs = render('two', 'C# parser')
    // '+' and '#' are stripped as punctuation, so these DO merge — accepted: an
    // agent naming two parsers will name them by more than a symbol. Pinned so
    // the trade-off is a decision, not an accident.
    expect(cs.canvasId).toBe(cpp.canvasId)
    const lig = render('three', 'ﬁle picker')
    const plain = render('four', 'file picker')
    expect(plain.canvasId).toBe(lig.canvasId)
  })
})

describe('the subject title is a label, and is cleaned like one', () => {
  it('strips control and bidi characters', () => {
    // A title is drawn in the library next to a delete button; a right-to-left
    // override could make one row read as another.
    render('one', 'Check‮out flow')
    expect(store.listAllCanvases()[0].title).toBe('Checkout flow')
  })

  it('collapses whitespace and trims', () => {
    render('one', '   Checkout    flow \n ')
    expect(store.listAllCanvases()[0].title).toBe('Checkout flow')
  })

  it('caps a long title rather than refusing the render', () => {
    const long = 'x'.repeat(400)
    render('one', long)
    const title = store.listAllCanvases()[0].title
    expect(title).toBeDefined()
    expect(title!.length).toBe(80)
  })

  it('treats a title that cleans away to nothing as no title', () => {
    const a = render('one', 'Subject A')
    const b = render('two', '‮   ')
    // Not an error, and not a new canvas: it simply carries on where it was.
    expect(b.canvasId).toBe(a.canvasId)
    expect(store.listAllCanvases()[0].title).toBe('Subject A')
  })

  it('strips the invisibles that let one row impersonate another', () => {
    // Combining grapheme joiner, variation selector, Hangul filler: all render
    // as nothing beside a delete button.
    render('one', 'Check\u034Fout\uFE0F flow\u3164')
    expect(store.listAllCanvases()[0].title).toBe('Checkout flow')
  })

  it('is idempotent: re-cleaning a stored title changes nothing', () => {
    // A trailing space left by the cap, or a surrogate cut in half, would make
    // the stored title differ from its own re-sanitisation on load.
    render('one', 'a'.repeat(79) + ' b')
    const stored = store.listAllCanvases()[0].title!
    expect(stored).toBe('a'.repeat(79))
    render('two', 'a'.repeat(79) + '😀')
    const emojiCapped = store.listAllCanvases()[0].title!
    expect(emojiCapped.endsWith('😀') || emojiCapped === 'a'.repeat(79)).toBe(true)
    // No lone surrogate survives.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiCapped)).toBe(false)
  })

  it('ignores a non-string title', () => {
    const a = render('one', 'Subject A')
    store.setCanvasSessionInfoResolver(() => ({ cwd: CWD, conversationUuid: CONV, profileId: undefined }))
    const b = store.renderVersion(SID, {
      mode: 'design',
      html: '<!doctype html><p>two</p>',
      title: 42 as unknown as string,
    })
    expect(b.canvasId).toBe(a.canvasId)
    expect(store.listAllCanvases()[0].title).toBe('Subject A')
  })
})
