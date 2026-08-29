// @vitest-environment jsdom
//
// The Agent Canvas FRONT PAGE (v8, approved on the canvas 2026-08-29).
//
// The landing used to teach: an eyebrow, a headline, a canned starter prompt to
// type into the terminal, the review loop drawn as five numbered steps, corner
// registration marks and a sketchpad escape hatch. The owner rejected all of it
// — a user opening this pane is asking what is waiting on them, not what a
// canvas is. So these pin the replacement: the masthead, the three bands, and
// just as importantly the ABSENCE of everything that was removed, because
// nothing else in the suite would notice a resurrected starter prompt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { CONFIRM_GUARD_MS } from '../../../src/renderer/hooks/useArmedConfirm'
import { useCanvasStore } from '../../../src/renderer/stores/canvasStore'
import { useCanvasReviewStore } from '../../../src/renderer/stores/canvasReviewStore'
import { useCanvasTotalsStore } from '../../../src/renderer/stores/canvasTotalsStore'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import type { CanvasLibraryRow, ResumableRow } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The sketchpad view embeds the real ExcalidrawPane (heavy); the front page's
// own behaviour is what is under test.
vi.mock('../../../src/renderer/components/ExcalidrawPane', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid="sketchpad">{sessionId}</div>,
}))
// Builder F3 owns the Explained page. Mocked to its CONTRACT — props are
// exactly `{ onHome: () => void }` — so this file tests the front page's
// wiring to it without depending on its internals.
vi.mock('../../../src/renderer/components/CanvasExplainedPage', () => ({
  default: ({ onHome }: { onHome: () => void }) => (
    <div data-testid="explained-page">
      <button onClick={onHome}>Home</button>
    </div>
  ),
}))
// The Library overlay is Builder F2's; the front page's business with it is
// opening it ON THE RIGHT TAB and re-reading when it closes. The mock records
// the tab it was handed, so that contract is checkable without F2's internals.
vi.mock('../../../src/renderer/components/CanvasLibrary', () => ({
  CanvasLibrary: ({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) => (
    <div data-testid="library" data-initial-tab={initialTab ?? '(none)'}>
      <button onClick={onClose}>Done</button>
    </div>
  ),
}))

const { default: CanvasEmptyState } = await import('../../../src/renderer/components/CanvasEmptyState')

const ptyWriteMock = vi.fn()
const libraryListMock = vi.fn(async () => ({ rows: [] as CanvasLibraryRow[], truncated: false }))
const listResumablesMock = vi.fn(async () => [] as ResumableRow[])
const resumeMock = vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string })
const dismissMock = vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string })
const reclaimMock = vi.fn(async () => ({ ok: true, state: null }))
const listAllMock = vi.fn(async () => [] as unknown[])
const getStateMock = vi.fn(async () => null)
const completeReopenMock = vi.fn(async () => ({ ok: true }))

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: ptyWriteMock },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    libraryList: libraryListMock,
    listResumables: listResumablesMock,
    resume: resumeMock,
    dismiss: dismissMock,
    reclaim: reclaimMock,
    listAll: listAllMock,
    getState: getStateMock,
    completeReopen: completeReopenMock,
  },
}

const SID = 'session-1'
let container: HTMLDivElement
let root: Root

const libRow = (over: Partial<CanvasLibraryRow> = {}): CanvasLibraryRow => ({
  canvasId: 'c1',
  anchorVersionId: 'v2',
  kind: 'mockup',
  title: 'Working pill',
  verdict: 'OPEN',
  archived: false,
  completed: false,
  audit: { when: '2026-08-29T10:00:00Z' },
  versionLabel: 'v2',
  noteCount: 1,
  ownedByThisSession: true,
  readOnly: false,
  updatedAt: '2026-08-29T10:00:00Z',
  ...over,
})

const resRow = (over: Partial<ResumableRow> = {}): ResumableRow => ({
  canvasId: 'r1',
  title: 'Login flow',
  kind: 'pack',
  noteCount: 6,
  lastRenderedAt: '2026-08-28T16:42:00Z',
  expectedOwnerSessionId: 'dead-session',
  ...over,
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CanvasEmptyState sessionId={SID} onClose={() => {}} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function click(el: Element | null): void {
  expect(el, 'expected element to click').toBeTruthy()
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function clickAsync(el: Element | null): Promise<void> {
  expect(el, 'expected element to click').toBeTruthy()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const testid = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const testids = (id: string): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const buttonByText = (text: string): Element | null =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null

// #456: a freshly-armed confirm ignores activation for CONFIRM_GUARD_MS so a
// double-click cannot arm and fire in one gesture.
let nowSpy: ReturnType<typeof vi.spyOn> | null = null
function passGuard(): void {
  const later = Date.now() + 60_000
  nowSpy?.mockRestore()
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => later)
}
afterEach(() => {
  nowSpy?.mockRestore()
  nowSpy = null
  // UNMOUNT, not just detach. A left-mounted page keeps its store
  // subscriptions, and the next test's `reset()` re-fires its hydration effects
  // — with the previous test's mocks still in place, landing stale rows over
  // the fresh ones.
  act(() => root.unmount())
})

beforeEach(() => {
  ptyWriteMock.mockClear()
  reclaimMock.mockClear()
  reclaimMock.mockResolvedValue({ ok: true, state: null })
  resumeMock.mockClear()
  resumeMock.mockResolvedValue({ ok: true })
  dismissMock.mockClear()
  dismissMock.mockResolvedValue({ ok: true })
  libraryListMock.mockClear()
  libraryListMock.mockResolvedValue({ rows: [], truncated: false })
  listResumablesMock.mockClear()
  listResumablesMock.mockResolvedValue([])
  listAllMock.mockClear()
  listAllMock.mockResolvedValue([])
  useCanvasStore.getState().reset()
  useCanvasReviewStore.getState().reset()
  useCanvasTotalsStore.getState().reset()
  useSessionStore.setState({ sessions: [] as never })
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

describe('the masthead', () => {
  it('draws the staged artwork in relief beside the wordmark', async () => {
    await render()
    const art = testid('canvas-masthead-art') as HTMLImageElement | null
    expect(art, 'the masthead artwork is the page').toBeTruthy()
    // Imported as a Vite asset URL, never re-encoded base64 into the bundle.
    expect(art!.getAttribute('src')).toContain('aicc-agent-canvas')
    expect(art!.getAttribute('src')).not.toMatch(/^data:/)
    // Decorative: the wordmark beside it carries the name.
    expect(art!.getAttribute('alt')).toBe('')
    expect(testid('canvas-masthead-word')!.textContent).toBe('Agent Canvas')
  })

  it('gives the wordmark line-height 1.18 — the gradient clip eats the descender below that', () => {
    // A LOGGED DEFECT, not a taste call: `.rn-name` sets 1.05, and at that
    // value `background-clip: text` crops the tail of the "g" in "Agent".
    // Asserted against the shipped stylesheet, and through jsdom's own cascade
    // so a rule that stops applying (renamed class, dropped block) fails here.
    const css = readFileSync(resolve(__dirname, '../../../src/renderer/styles.css'), 'utf8')
    const block = /\.cfp-mast-word\s*\{([^}]*)\}/.exec(css)
    expect(block, '.cfp-mast-word must exist in styles.css').toBeTruthy()
    expect(block![1]).toMatch(/line-height:\s*1\.18/)
    // ...and it must be the gradient-clipped wordmark, not a plain heading.
    expect(block![1]).toMatch(/background-clip:\s*text/)
    expect(block![1]).toMatch(/--brand/)

    const style = document.createElement('style')
    style.textContent = `.cfp-mast-word { line-height: ${/line-height:\s*([^;]+)/.exec(block![1])![1].trim()}; }`
    document.head.appendChild(style)
    const el = document.createElement('h2')
    el.className = 'cfp-mast-word'
    document.body.appendChild(el)
    expect(getComputedStyle(el).lineHeight).toBe('1.18')
    style.remove()
    el.remove()
  })
})

describe('what the rewrite REMOVED', () => {
  // Every one of these was on the old landing and was rejected by name. They
  // have no other guard in the suite, so a re-introduction would ship silently.
  it('has no starter prompt, no review-loop diagram, no eyebrow, no sketchpad line', async () => {
    libraryListMock.mockResolvedValue({ rows: [libRow()], truncated: false })
    listResumablesMock.mockResolvedValue([resRow()])
    await render()
    const text = container.textContent ?? ''
    for (const gone of [
      'Show me a design mockup',
      'Put this in the terminal',
      'Nothing rendered yet',
      'The review loop',
      'Agent renders',
      'You annotate',
      'Agent revises',
      'You resolve',
      'Once something is rendered',
      'sketchpad',
      'Sketchpad',
      'Browse the canvas library',
      'Pick up where you left off',
      'This is a review surface, not a drawing app',
    ]) {
      expect(text, `"${gone}" is back on the front page`).not.toContain(gone)
    }
    // Nothing is typed into anyone's terminal from this page any more.
    expect(ptyWriteMock).not.toHaveBeenCalled()
    // No ordered loop track, and no corner registration marks.
    expect(container.querySelector('ol')).toBeNull()
    expect(container.querySelector('.canvas-loop-arc')).toBeNull()
  })
})

describe('in flight work', () => {
  it('shows the one thing owed: kind, version and the owed words, from main', async () => {
    libraryListMock.mockResolvedValue({
      rows: [libRow({ owed: 'v2 awaiting review' })],
      truncated: false,
    })
    await render()
    const card = testid('canvas-inflight-card')
    expect(card).toBeTruthy()
    expect(card!.textContent).toContain('Working pill')
    expect(card!.textContent).toContain('MOCKUP')
    expect(card!.textContent).toContain('v2')
    expect(testid('canvas-inflight-owed')!.textContent).toBe('v2 awaiting review')
  })

  it('does not print the note count twice when the owed line already names notes', async () => {
    // The counts rule: never the same number twice on one surface. Main's owed
    // text already says "3 notes with the agent", so the card must not add
    // "3 notes" beside it.
    libraryListMock.mockResolvedValue({
      rows: [libRow({ owed: '3 notes with the agent', noteCount: 3 })],
      truncated: false,
    })
    await render()
    const card = testid('canvas-inflight-card')!
    expect(card.textContent).toContain('3 notes with the agent')
    expect((card.textContent!.match(/3 notes/g) ?? []).length).toBe(1)
  })

  it('adds the note count when the owed line is about something else', async () => {
    libraryListMock.mockResolvedValue({
      rows: [libRow({ owed: 'v2 awaiting review', noteCount: 2 })],
      truncated: false,
    })
    await render()
    expect(testid('canvas-inflight-card')!.textContent).toContain('2 notes')
  })

  it('Open points this session at its own canvas — an index repoint, not an adoption', async () => {
    useSessionStore.setState({ sessions: [{ id: 'tile-a' }, { id: 'tile-b' }] as never })
    libraryListMock.mockResolvedValue({ rows: [libRow({ owed: 'v2 awaiting review' })], truncated: false })
    await render()
    await clickAsync(testid('canvas-inflight-open'))
    expect(reclaimMock).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: 'c1',
      openTileSessionIds: ['tile-a', 'tile-b'],
    })
    // Never the transfer path: this canvas is already ours.
    expect(resumeMock).not.toHaveBeenCalled()
  })

  it('is absent when nothing is owed, and when the owed row belongs to someone else', async () => {
    libraryListMock.mockResolvedValue({
      rows: [
        libRow({ canvasId: 'mine', owed: undefined }),
        libRow({ canvasId: 'theirs', owed: 'v3 awaiting review', ownedByThisSession: false }),
      ],
      truncated: false,
    })
    await render()
    expect(testid('canvas-inflight-card')).toBeNull()
  })

  it('is absent for a signed-off row — terminal history owes nothing', async () => {
    libraryListMock.mockResolvedValue({
      rows: [libRow({ owed: 'v2 awaiting review', completed: true })],
      truncated: false,
    })
    await render()
    expect(testid('canvas-inflight-card')).toBeNull()
  })
})

describe('the approved-plan jump', () => {
  it('appears when the project has an approved plan, beside the work in flight', async () => {
    libraryListMock.mockResolvedValue({
      rows: [
        libRow({ owed: 'v2 awaiting review' }),
        libRow({ canvasId: 'p1', kind: 'plan', title: 'Left panel redesign', verdict: 'APPROVED' }),
      ],
      truncated: false,
    })
    await render()
    const jump = testid('canvas-plan-jump')
    expect(jump).toBeTruthy()
    expect(jump!.textContent).toContain('Left panel redesign')
    expect(jump!.textContent).toContain('approved plan')

    // "View plan →" means the Plans tab, not the whole Library.
    await clickAsync(jump)
    expect(testid('library')!.getAttribute('data-initial-tab')).toBe('plan')
  })

  it('appears for an approved plan ON THE SAME CANVAS as the work in flight', async () => {
    // THE normal shape, not an edge case: one canvas accumulates artefacts, so
    // a project usually has its approved plan and its in-flight mockup on the
    // same canvasId. Excluding by canvas rather than by ROW meant the most
    // ordinary project on earth never got a "View plan" link.
    libraryListMock.mockResolvedValue({
      rows: [
        libRow({ canvasId: 'c1', anchorVersionId: 'v9', kind: 'mockup', owed: 'v9 awaiting review' }),
        libRow({ canvasId: 'c1', anchorVersionId: 'v3', kind: 'plan', title: 'Left panel redesign', verdict: 'APPROVED' }),
      ],
      truncated: false,
    })
    await render()
    expect(testid('canvas-inflight-card')).toBeTruthy()
    expect(testid('canvas-plan-jump')!.textContent).toContain('Left panel redesign')
  })

  it('does not offer the in-flight artefact back to itself', async () => {
    // The one row it must exclude: the SAME artefact run (canvas + anchor) that
    // the need-card is already showing.
    libraryListMock.mockResolvedValue({
      rows: [libRow({ canvasId: 'c1', anchorVersionId: 'v3', kind: 'plan', title: 'A plan', verdict: 'APPROVED', owed: '2 unsent notes' })],
      truncated: false,
    })
    await render()
    expect(testid('canvas-inflight-card')).toBeTruthy()
    expect(testid('canvas-plan-jump')).toBeNull()
  })

  it('appears with NO work in flight — an agreed plan is still the thing you re-read', async () => {
    libraryListMock.mockResolvedValue({
      rows: [libRow({ canvasId: 'p1', kind: 'plan', title: 'Left panel redesign', verdict: 'APPROVED' })],
      truncated: false,
    })
    await render()
    expect(testid('canvas-inflight-card'), 'nothing is owed').toBeNull()
    expect(testid('canvas-resume-card'), 'nothing is spare either').toBeNull()
    // ...and the band still draws, carrying the jump on its own.
    expect(testid('canvas-plan-jump')!.textContent).toContain('Left panel redesign')
  })

  it('does NOT appear for an open or rejected plan', async () => {
    libraryListMock.mockResolvedValue({
      rows: [
        libRow({ owed: 'v2 awaiting review' }),
        libRow({ canvasId: 'p1', kind: 'plan', title: 'Left panel redesign', verdict: 'OPEN' }),
        libRow({ canvasId: 'p2', kind: 'plan', title: 'Rejected plan', verdict: 'REJECTED' }),
      ],
      truncated: false,
    })
    await render()
    expect(testid('canvas-plan-jump')).toBeNull()
  })
})

describe('resuming ownerless work', () => {
  it('offers nothing when nothing is ownerless', async () => {
    await render()
    expect(testid('canvas-resume-card')).toBeNull()
  })

  it('names each row by kind, notes and when it was last rendered', async () => {
    listResumablesMock.mockResolvedValue([resRow()])
    await render()
    const row = testid('canvas-resume-row')!
    expect(row.textContent).toContain('Login flow')
    expect(row.textContent).toContain('test pack')
    expect(row.textContent).toContain('6 notes')
  })

  it('Resume carries the compare-and-set token main listed the row with', async () => {
    useSessionStore.setState({ sessions: [{ id: 'tile-a' }] as never })
    listResumablesMock.mockResolvedValue([resRow()])
    await render()
    await clickAsync(testid('canvas-resume-action'))
    expect(resumeMock).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: 'r1',
      expectedOwnerSessionId: 'dead-session',
      openTileSessionIds: ['tile-a'],
    })
  })

  it('a lost race says so in plain words and re-reads — the row never lingers', async () => {
    listResumablesMock.mockResolvedValue([resRow()])
    await render()
    expect(listResumablesMock).toHaveBeenCalledTimes(1)

    resumeMock.mockResolvedValueOnce({ ok: false, reason: 'changed' })
    listResumablesMock.mockResolvedValue([])
    await clickAsync(testid('canvas-resume-action'))

    expect(testid('canvas-front-page-notice')!.textContent).toContain('picked that up first')
    // Re-read on the refusal, and the row is gone with it.
    expect(listResumablesMock.mock.calls.length).toBeGreaterThan(1)
    expect(testid('canvas-resume-row')).toBeNull()
  })

  it('a live owner is refused with the same plain line — never a raw reason code', async () => {
    listResumablesMock.mockResolvedValue([resRow()])
    await render()
    resumeMock.mockResolvedValueOnce({ ok: false, reason: 'owner-live' })
    await clickAsync(testid('canvas-resume-action'))
    const notice = testid('canvas-front-page-notice')!.textContent ?? ''
    expect(notice).toContain('picked that up first')
    expect(notice).not.toContain('owner-live')
  })

  it('Dismiss arms first, and the confirm names the evidence that goes', async () => {
    listResumablesMock.mockResolvedValue([resRow()])
    await render()

    click(testid('canvas-resume-dismiss'))
    expect(dismissMock, 'arming must not delete anything').not.toHaveBeenCalled()
    const confirm = testid('canvas-resume-dismiss-confirm')!
    expect(confirm.textContent).toContain('6 notes')
    expect(confirm.textContent, 'the user must be told the evidence goes too').toContain('evidence')

    passGuard()
    await clickAsync(confirm)
    expect(dismissMock).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: 'r1',
      openTileSessionIds: [],
    })
  })

  it('a note-less pack names the canvas rather than counting to zero', async () => {
    // A pack can hold evidence with no notes written against it yet. "Delete 0
    // notes and their evidence" reads as a bug AND understates what goes.
    listResumablesMock.mockResolvedValue([resRow({ noteCount: 0 })])
    await render()
    click(testid('canvas-resume-dismiss'))
    const confirm = testid('canvas-resume-dismiss-confirm')!
    expect(confirm.textContent).toBe('Delete this canvas and its saved evidence')
    expect(confirm.textContent).not.toContain('0 note')
    expect(confirm.getAttribute('aria-label')).toContain('Login flow')
    expect(confirm.getAttribute('aria-label')).toContain('saved evidence')
  })

  it('one note is singular', async () => {
    listResumablesMock.mockResolvedValue([resRow({ noteCount: 1 })])
    await render()
    click(testid('canvas-resume-dismiss'))
    expect(testid('canvas-resume-dismiss-confirm')!.textContent).toBe('Delete 1 note and its evidence')
  })

  it('a double-click cannot arm and fire in one gesture (#456)', async () => {
    listResumablesMock.mockResolvedValue([resRow()])
    await render()

    click(testid('canvas-resume-dismiss'))
    click(testid('canvas-resume-dismiss-confirm'))
    await act(async () => { await Promise.resolve() })
    expect(dismissMock).not.toHaveBeenCalled()
    expect(testid('canvas-resume-dismiss-confirm'), 'still armed').toBeTruthy()

    // A blocked activation re-arms: only quiet makes it live.
    const realNow = Date.now.bind(Date)
    let offset = CONFIRM_GUARD_MS * 3
    nowSpy?.mockRestore()
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    await clickAsync(testid('canvas-resume-dismiss-confirm'))
    expect(dismissMock).toHaveBeenCalledTimes(1)
  })
})

describe('recent in this project', () => {
  const recents = [
    libRow({ canvasId: 'm1', kind: 'mockup', title: 'Quick Start restyle', completed: true, verdict: 'APPROVED' }),
    libRow({ canvasId: 'm2', kind: 'mockup', title: 'Command bar', verdict: 'APPROVED' }),
    libRow({ canvasId: 'p1', kind: 'plan', title: 'Canvas rework', verdict: 'OPEN' }),
    libRow({ canvasId: 't1', kind: 'pack', title: 'Onboarding flow', verdict: 'PASSED' }),
    libRow({ canvasId: 't2', kind: 'pack', title: 'SSH setup', verdict: 'FAILED' }),
  ]

  it('splits into three typed columns, counted per type', async () => {
    libraryListMock.mockResolvedValue({ rows: recents, truncated: false })
    await render()
    expect(testid('canvas-recents-mockups')!.textContent).toContain('Quick Start restyle')
    expect(testid('canvas-recents-mockups')!.textContent).toContain('Command bar')
    expect(testid('canvas-recents-plans')!.textContent).toContain('Canvas rework')
    expect(testid('canvas-recents-plans')!.textContent).not.toContain('Quick Start restyle')
    expect(testid('canvas-recents-packs')!.textContent).toContain('Onboarding flow')
    expect(testid('canvas-recents-packs')!.textContent).toContain('SSH setup')
    expect(testids('canvas-recent-row')).toHaveLength(5)
    expect(testid('canvas-recents-total')!.textContent).toContain('5 artefacts')
  })

  it('every route into the Library lands on the tab it promised', async () => {
    // A typed column's "See all" that dumped the user on All would make them
    // re-find the tab they just clicked out of. Four routes, four destinations:
    // the band link is the only one that means "everything".
    //
    // Four columns' worth of rows so each "See all" actually renders (it appears
    // only when a column has more than it shows).
    const many = [
      ...recents,
      libRow({ canvasId: 'm3', kind: 'mockup', title: 'M3' }),
      libRow({ canvasId: 'm4', kind: 'mockup', title: 'M4' }),
      libRow({ canvasId: 'p2', kind: 'plan', title: 'P2' }),
      libRow({ canvasId: 'p3', kind: 'plan', title: 'P3' }),
      libRow({ canvasId: 'p4', kind: 'plan', title: 'P4' }),
      libRow({ canvasId: 't3', kind: 'pack', title: 'T3' }),
      libRow({ canvasId: 't4', kind: 'pack', title: 'T4' }),
    ]
    const openedTab = async (el: Element | null): Promise<string | null> => {
      await clickAsync(el)
      const tab = testid('library')!.getAttribute('data-initial-tab')
      await clickAsync(buttonByText('Done'))
      return tab
    }

    libraryListMock.mockResolvedValue({ rows: many, truncated: false })
    await render()

    const seeAll = (kind: string) =>
      container.querySelector(`[data-testid="canvas-recents-see-all"][data-kind="${kind}"]`)
    expect(await openedTab(seeAll('mockup'))).toBe('mockup')
    expect(await openedTab(seeAll('plan'))).toBe('plan')
    expect(await openedTab(seeAll('pack'))).toBe('pack')
    // A row goes where its own column's link goes.
    expect(
      await openedTab(container.querySelector('[data-testid="canvas-recent-row"][data-kind="pack"]')),
    ).toBe('pack')
    // ...and the band link is the one that means everything.
    expect(await openedTab(testid('canvas-empty-library-open'))).toBe('all')
  })

  it('badges each row from its recorded state — signed off wins over the verdict', async () => {
    libraryListMock.mockResolvedValue({ rows: recents, truncated: false })
    await render()
    const badges = testids('canvas-recent-row').map((r) => r.querySelector('.cfp-vb')?.textContent)
    expect(badges).toEqual(['SIGNED OFF', 'APPROVED', 'OPEN', 'PASSED', 'FAILED'])
  })

  it('leaves archived work out — that is what the Library’s Archived filter is for', async () => {
    libraryListMock.mockResolvedValue({
      rows: [...recents, libRow({ canvasId: 'a1', title: 'Old idea', archived: true })],
      truncated: false,
    })
    await render()
    expect(container.textContent).not.toContain('Old idea')
    expect(testid('canvas-recents-total')!.textContent).toContain('5 artefacts')
  })

  it('says the count is a floor when main truncated the read', async () => {
    libraryListMock.mockResolvedValue({ rows: recents, truncated: true })
    await render()
    expect(testid('canvas-recents-total')!.textContent).toContain('5+ artefacts')
  })

  it('asks main for the project listing with the open tiles', async () => {
    useSessionStore.setState({ sessions: [{ id: 'tile-a' }] as never })
    await render()
    expect(libraryListMock).toHaveBeenCalledWith({
      sessionId: SID,
      openTileSessionIds: ['tile-a'],
      sort: 'recent',
    })
  })

  it('a broken listing shows nothing rather than inventing rows', async () => {
    libraryListMock.mockRejectedValue(new Error('ipc gone'))
    await render()
    expect(testids('canvas-recent-row')).toHaveLength(0)
    expect(testid('canvas-recents-total')!.textContent).toContain('0 artefacts')
  })

  it('re-reads when the Library overlay closes — it can archive or delete a row this page shows', async () => {
    libraryListMock.mockResolvedValue({ rows: recents, truncated: false })
    await render()
    expect(libraryListMock).toHaveBeenCalledTimes(1)

    await clickAsync(testid('canvas-empty-library-open'))
    expect(testid('library')).toBeTruthy()

    libraryListMock.mockResolvedValue({ rows: [], truncated: false })
    await clickAsync(buttonByText('Done'))
    expect(libraryListMock).toHaveBeenCalledTimes(2)
    expect(testids('canvas-recent-row')).toHaveLength(0)
  })
})

describe('Canvas Explained', () => {
  it('the card swaps the sheet for the Explained page, and Home comes back', async () => {
    await render()
    expect(testid('explained-page')).toBeNull()

    await clickAsync(testid('canvas-explained-card'))
    expect(useCanvasStore.getState().bySessionId[SID].emptyView).toBe('explained')
    expect(testid('explained-page')).toBeTruthy()
    // The page replaces the sheet, not the pane.
    expect(testid('canvas-front-page')).toBeNull()

    await clickAsync(buttonByText('Home'))
    expect(useCanvasStore.getState().bySessionId[SID].emptyView).toBe('intro')
    expect(testid('canvas-front-page')).toBeTruthy()
  })
})

describe('the sketchpad', () => {
  it('has NO entry point on the front page any more', async () => {
    await render()
    expect(buttonByText('sketchpad')).toBeNull()
    expect(testid('sketchpad')).toBeNull()
  })

  it('is still reachable as a store state, and still has its way back', async () => {
    // The union keeps the value (see CanvasEmptyView): a session already sitting
    // on it must not be stranded by the rewrite. Restoring a user-facing door
    // is an owner call, recorded as a follow-up.
    useCanvasStore.getState().setEmptyView(SID, 'sketchpad')
    await render()
    expect(testid('sketchpad')).toBeTruthy()

    click(buttonByText('Agent Canvas'))
    expect(testid('sketchpad')).toBeNull()
    expect(testid('canvas-front-page')).toBeTruthy()
  })
})

describe('the completed notice (#476)', () => {
  it('still sits above the page, with Reopen and Dismiss', async () => {
    await render()
    act(() => {
      useCanvasStore.setState((s) => ({
        bySessionId: {
          ...s.bySessionId,
          [SID]: { ...s.bySessionId[SID], completedNotice: { canvasId: 'c9', title: 'Working pill' } },
        },
      }))
    })
    expect(testid('canvas-completed-notice')!.textContent).toContain('Working pill')
    await clickAsync(testid('canvas-completed-notice-reopen'))
    expect(completeReopenMock).toHaveBeenCalledWith({ sessionId: SID, canvasId: 'c9' })
  })
})
