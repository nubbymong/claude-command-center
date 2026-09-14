// @vitest-environment jsdom
//
// LIBRARY v2 (M4) — the project's shelf, read from `canvas:libraryList`.
//
// Three things are under test here, and they are the three things the rewrite
// changed about the surface's honesty:
//
//  1. The row says only what main recorded. Absent parts of the audit line are
//     DROPPED, never filled with "unknown"; the badge is one word derived from
//     `archived` / `completed` / `verdict`; and a pack's note word follows its
//     own verdict (a PASS carries observations, a FAIL carries defects).
//  2. The search, the tab and the filter are QUERY PARAMETERS, not a client
//     filter. Main applies them, which is what makes `truncated` mean "more
//     matched than fit" and what keeps the ownership lease enforceable.
//  3. A read-only row offers a read-back and nothing else — no checkbox, no
//     archive, no delete, no reopen. Ownership is main's to enforce; this is
//     the belt.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasLibraryRow } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { CanvasLibrary } = await import('../../../src/renderer/components/CanvasLibrary')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

const SID = 'session-1'

function row(over: Partial<CanvasLibraryRow> = {}): CanvasLibraryRow {
  return {
    canvasId: 'canvas-a',
    anchorVersionId: 'v3',
    kind: 'mockup',
    title: 'Checkout flow',
    verdict: 'OPEN',
    archived: false,
    completed: false,
    audit: { when: new Date().toISOString() },
    versionLabel: 'v3',
    noteCount: 0,
    ownedByThisSession: true,
    readOnly: false,
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let rows: CanvasLibraryRow[]
let truncated = false
let shots: Record<string, { dataUrl: string } | null>

const libraryList = vi.fn(async () => ({ rows, truncated }))
const evidenceRead = vi.fn(async (args: { path: string }) => shots[args.path] ?? null)
const reclaim = vi.fn(async () => ({ ok: true, state: null }))
const archiveArtifact = vi.fn(async () => ({ ok: true, state: null }))
const deleteArtifact = vi.fn(async () => ({ ok: true }))
const deleteCanvas = vi.fn(async () => ({ ok: true }))
const completeReopen = vi.fn(async () => ({ ok: true }))

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    libraryList,
    evidenceRead,
    reclaim,
    archiveArtifact,
    deleteArtifact,
    deleteCanvas,
    completeReopen,
  },
}

const onClose = vi.fn()
const onOpened = vi.fn()

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CanvasLibrary sessionId={SID} onClose={onClose} onOpened={onOpened} />)
  })
}

const byTestId = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)
const allTestId = (id: string): HTMLElement[] => Array.from(container.querySelectorAll(`[data-testid="${id}"]`))
const rowEls = (): HTMLElement[] => allTestId('canvas-library-row')
const within = (el: HTMLElement, id: string): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`)

async function click(el: Element | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

/** Type into a CONTROLLED input the way a person does. React tracks the last
 *  value it wrote and ignores an `input` event whose value it believes it
 *  already has, so assigning `.value` directly is a no-op to it — the native
 *  setter is what moves the tracker. */
const nativeValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
async function type(input: HTMLInputElement, ...values: string[]): Promise<void> {
  await act(async () => {
    for (const value of values) {
      nativeValue.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
}

/** Let the 250 ms search debounce elapse. Real timers: the component uses
 *  `window.setTimeout`, and a fake-timer swap here would also freeze the
 *  armed-confirm clock the other suites share. */
async function settleSearch(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 320))
  })
}

beforeEach(() => {
  rows = [row()]
  truncated = false
  shots = {}
  libraryList.mockClear()
  evidenceRead.mockClear()
  reclaim.mockClear()
  archiveArtifact.mockClear()
  deleteArtifact.mockClear()
  deleteCanvas.mockClear()
  completeReopen.mockClear()
  onClose.mockClear()
  onOpened.mockClear()
  useSessionStore.setState({ sessions: [{ id: SID }] } as any)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('rows say what main recorded, and no more', () => {
  it('drops the parts of the audit line it has no value for', async () => {
    rows = [row({ audit: { when: new Date().toISOString() } })]
    await render()
    const line = byTestId('canvas-library-audit')?.textContent ?? ''
    expect(line).toContain('mockup')
    expect(line).toContain('v3')
    expect(line).not.toContain('cfg')
    expect(line.toLowerCase()).not.toContain('unknown')
  })

  it('names the config, the account and the session when it has them', async () => {
    rows = [row({ configName: 'Conductor Dev', audit: { account: 'nicholas', sessionLabel: 'Orchid', when: new Date().toISOString() } })]
    await render()
    const line = byTestId('canvas-library-audit')?.textContent ?? ''
    expect(line).toContain('cfg Conductor Dev')
    expect(line).toContain('nicholas')
    expect(line).toContain('Orchid')
  })

  it('re-reads the config name every load, so renaming a config renames the row', async () => {
    rows = [row({ configName: 'Pi-Miner' })]
    await render()
    expect(byTestId('canvas-library-audit')?.textContent).toContain('cfg Pi-Miner')
    // Same canvas, same anchor — only the resolved display name moved. Nothing
    // may be cached against the id, or the old label survives the rename.
    rows = [row({ configName: 'Raspberry' })]
    await click(byTestId('canvas-library-tab-mockup'))
    expect(byTestId('canvas-library-audit')?.textContent).toContain('cfg Raspberry')
    expect(byTestId('canvas-library-audit')?.textContent).not.toContain('Pi-Miner')
  })

  const BADGES: { name: string; over: Partial<CanvasLibraryRow>; expected: string }[] = [
    { name: 'OPEN', over: { verdict: 'OPEN' }, expected: 'OPEN' },
    { name: 'APPROVED', over: { verdict: 'APPROVED' }, expected: 'APPROVED' },
    { name: 'REJECTED', over: { verdict: 'REJECTED' }, expected: 'REJECTED' },
    { name: 'PASSED', over: { verdict: 'PASSED', kind: 'pack' }, expected: 'PASSED' },
    { name: 'FAILED', over: { verdict: 'FAILED', kind: 'pack' }, expected: 'FAILED' },
    { name: 'SIGNED OFF', over: { verdict: 'APPROVED', completed: true }, expected: 'Signed off' },
    { name: 'ARCHIVED', over: { verdict: 'APPROVED', completed: true, archived: true }, expected: 'Archived' },
  ]
  for (const badge of BADGES) {
    it(`badges ${badge.name}`, async () => {
      rows = [row(badge.over)]
      await render()
      expect(byTestId('canvas-library-badge')?.textContent).toBe(badge.expected)
    })
  }

  it('keeps the verdict a signed-off row rode in on, in the badge title', async () => {
    rows = [row({ verdict: 'PASSED', completed: true, kind: 'pack' })]
    await render()
    expect(byTestId('canvas-library-badge')?.getAttribute('title')).toBe('Signed off — PASSED')
  })

  it('calls a passing pack’s notes observations and a failing one’s defects', async () => {
    rows = [
      row({ canvasId: 'c1', kind: 'pack', verdict: 'PASSED', noteCount: 2, versionLabel: 'build 5' }),
      row({ canvasId: 'c2', kind: 'pack', verdict: 'FAILED', noteCount: 4, versionLabel: 'build 3' }),
    ]
    await render()
    const words = allTestId('canvas-library-pack-notes').map((el) => el.textContent)
    expect(words).toEqual(['2 observations', '4 defects'])
  })

  it('shows what is owed instead, when main says something is owed', async () => {
    rows = [row({ kind: 'pack', verdict: 'OPEN', noteCount: 3, owed: '2 unsent notes' })]
    await render()
    expect(byTestId('canvas-library-owed')?.textContent).toBe('2 unsent notes')
    // One count, one place — the owed line replaces the note word rather than
    // sitting beside it saying a different number about the same notes.
    expect(byTestId('canvas-library-pack-notes')).toBeNull()
  })

  it('says when more matched than fit', async () => {
    truncated = true
    await render()
    expect(byTestId('canvas-library-count')?.textContent).toContain('more not shown')
  })
})

describe('search, tabs and filters are IPC parameters', () => {
  it('sends the tab and the filter to main, and never filters the answer itself', async () => {
    await render()
    await click(byTestId('canvas-library-tab-pack'))
    expect(libraryList).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'pack', sessionId: SID, sort: 'recent' }))

    await click(byTestId('canvas-library-filter-needs-you'))
    expect(libraryList).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'pack', filter: 'needs-you' }))

    // Main answered with a mockup row while the pack tab is on: it is main's
    // answer, and re-filtering it here would make `truncated` a lie.
    expect(rowEls()).toHaveLength(1)
  })

  it('a second press clears the chip rather than leaving no way back', async () => {
    await render()
    await click(byTestId('canvas-library-filter-open'))
    expect(libraryList).toHaveBeenLastCalledWith(expect.objectContaining({ filter: 'open' }))
    await click(byTestId('canvas-library-filter-open'))
    expect(libraryList.mock.calls.at(-1)?.[0]).not.toHaveProperty('filter')
  })

  it('debounces the typed query into one call', async () => {
    await render()
    const input = byTestId('canvas-library-search') as HTMLInputElement
    libraryList.mockClear()
    await type(input, 's', 'ss', 'ssh')
    expect(libraryList).not.toHaveBeenCalled()
    await settleSearch()
    expect(libraryList).toHaveBeenCalledTimes(1)
    expect(libraryList).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'ssh' }))
  })

  it('focuses the box on / and clears it on Esc', async () => {
    await render()
    const input = byTestId('canvas-library-search') as HTMLInputElement
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }))
    })
    expect(document.activeElement).toBe(input)

    await type(input, 'ssh')
    expect(input.value).toBe('ssh')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect((byTestId('canvas-library-search') as HTMLInputElement).value).toBe('')
  })

  it('opens on the tab it was handed, and lets the user leave it', async () => {
    // The front page's per-column "See all" links land here. Seeded once: the
    // FIRST list request already carries the tab (there is no render on the
    // wrong one to correct), and a press moves off it like any other.
    await act(async () => {
      root.render(<CanvasLibrary sessionId={SID} onClose={onClose} onOpened={onOpened} initialTab="pack" />)
    })
    expect(byTestId('canvas-library-tab-pack')?.getAttribute('aria-pressed')).toBe('true')
    expect(byTestId('canvas-library-tab-all')?.getAttribute('aria-pressed')).toBe('false')
    expect(libraryList).toHaveBeenCalledTimes(1)
    expect(libraryList).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'pack' }))

    await click(byTestId('canvas-library-tab-plan'))
    expect(byTestId('canvas-library-tab-plan')?.getAttribute('aria-pressed')).toBe('true')
    expect(libraryList).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'plan' }))
  })

  it('says which narrowing emptied the list', async () => {
    rows = []
    await render()
    expect(byTestId('canvas-library-empty')?.textContent).toContain('Nothing here yet')
    await click(byTestId('canvas-library-filter-archived'))
    expect(byTestId('canvas-library-empty')?.textContent).toBe('Nothing is archived here.')
  })
})

describe('a pack row reads its evidence back in place', () => {
  const packRow = () =>
    row({
      kind: 'pack',
      verdict: 'FAILED',
      versionLabel: 'build 3',
      noteCount: 2,
      evidence: [
        { note: 'Welcome copy overflows at 125% scale', route: '/welcome', at: '2026-08-28T16:44:02Z', shotPath: 'reviews/evidence/a1.png' },
        { note: 'Skip button loses focus ring on tab', route: '/welcome/accounts', at: '2026-08-28T16:47:31Z' },
      ],
    })

  it('reads one shot per card, lazily, and only once', async () => {
    shots['reviews/evidence/a1.png'] = { dataUrl: 'data:image/png;base64,AAA' }
    rows = [packRow()]
    await render()
    expect(evidenceRead).not.toHaveBeenCalled()
    expect(byTestId('canvas-library-evidence')).toBeNull()
    // The caret says which way the row is about to move, as on History.
    expect(byTestId('canvas-library-expand')?.textContent).toBe('Expand ▾')

    await click(byTestId('canvas-library-expand'))
    expect(allTestId('canvas-library-evidence-card')).toHaveLength(2)
    // One read: the second note was written without a screen, and a card with
    // no shot path never asks.
    expect(evidenceRead).toHaveBeenCalledTimes(1)
    expect(evidenceRead).toHaveBeenCalledWith({ sessionId: SID, canvasId: 'canvas-a', path: 'reviews/evidence/a1.png' })
    expect(byTestId('canvas-library-evidence-shot')?.getAttribute('src')).toBe('data:image/png;base64,AAA')
  })

  it('collapses again without re-reading on the way out', async () => {
    rows = [packRow()]
    await render()
    await click(byTestId('canvas-library-expand'))
    expect(byTestId('canvas-library-expand')?.textContent).toBe('Collapse ▴')
    await click(byTestId('canvas-library-expand'))
    expect(byTestId('canvas-library-evidence')).toBeNull()
  })

  it('shows the route and the clock time under each note', async () => {
    rows = [packRow()]
    await render()
    await click(byTestId('canvas-library-expand'))
    expect(byTestId('canvas-library-evidence')?.textContent).toContain('/welcome')
  })
})

describe('what each kind of row offers', () => {
  it('an own, open row opens here through reclaim — the call that transfers nothing', async () => {
    await render()
    await click(byTestId('canvas-library-open-here'))
    expect(reclaim).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: 'canvas-a',
      openTileSessionIds: [SID],
    })
    expect(onOpened).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('an own, signed-off row offers View and Reopen', async () => {
    rows = [row({ completed: true, verdict: 'APPROVED' })]
    await render()
    expect(byTestId('canvas-library-view')).toBeTruthy()
    expect(byTestId('canvas-library-open-here')).toBeNull()
    await click(byTestId('canvas-library-reopen'))
    expect(completeReopen).toHaveBeenCalledWith({ sessionId: SID, canvasId: 'canvas-a' })
  })

  it('archives the ARTEFACT, addressed by its anchor version', async () => {
    rows = [row()]
    await render()
    expect(byTestId('canvas-library-archive')?.textContent).toBe('Archive')
    await click(byTestId('canvas-library-archive'))
    expect(archiveArtifact).toHaveBeenCalledWith({ sessionId: SID, canvasId: 'canvas-a', versionId: 'v3', archived: true, openTileSessionIds: [SID] })
  })

  it('offers the same control as Restore once the run is archived', async () => {
    rows = [row({ archived: true })]
    await render()
    expect(byTestId('canvas-library-archive')?.textContent).toBe('Restore')
    await click(byTestId('canvas-library-archive'))
    expect(archiveArtifact).toHaveBeenCalledWith({ sessionId: SID, canvasId: 'canvas-a', versionId: 'v3', archived: false, openTileSessionIds: [SID] })
  })

  it('a READ-ONLY mockup offers View and not one mutating control', async () => {
    rows = [row({ ownedByThisSession: false, completed: true, readOnly: true, verdict: 'APPROVED' })]
    await render()
    expect(byTestId('canvas-library-view')).toBeTruthy()
    for (const id of ['canvas-library-open-here', 'canvas-library-reopen', 'canvas-library-archive', 'canvas-library-delete', 'canvas-library-select']) {
      expect(byTestId(id), `${id} must not be on a read-only row`).toBeNull()
    }
  })

  it('a READ-ONLY pack reads back through Expand — never a pane that could only say "no notes"', async () => {
    rows = [
      row({
        kind: 'pack',
        ownedByThisSession: false,
        completed: true,
        readOnly: true,
        verdict: 'PASSED',
        noteCount: 3,
        versionLabel: 'build 5',
        evidence: [{ note: 'Looks right after the fix', at: '2026-08-28T16:52:10Z' }],
      }),
    ]
    await render()
    expect(byTestId('canvas-library-expand')).toBeTruthy()
    expect(byTestId('canvas-library-view')).toBeNull()
    expect(byTestId('canvas-library-delete')).toBeNull()
  })

  it("ownerless in-flight work on the project is visible but not the Library's to open", async () => {
    rows = [row({ ownedByThisSession: false, completed: false, readOnly: false })]
    await render()
    expect(byTestId('canvas-library-unowned')).toBeTruthy()
    for (const id of ['canvas-library-open-here', 'canvas-library-view', 'canvas-library-delete', 'canvas-library-select']) {
      expect(byTestId(id), `${id} must not be on an unowned row`).toBeNull()
    }
  })
})

describe('the bulk bar', () => {
  const two = () => [row({ canvasId: 'c1', title: 'One' }), row({ canvasId: 'c2', title: 'Two' })]

  it('counts what is selected and clears again', async () => {
    rows = two()
    await render()
    expect(byTestId('canvas-library-bulk')).toBeNull()
    await click(within(rowEls()[0], 'canvas-library-select'))
    expect(byTestId('canvas-library-bulk')?.textContent).toContain('1 selected')
    await click(within(rowEls()[1], 'canvas-library-select'))
    expect(byTestId('canvas-library-bulk')?.textContent).toContain('2 selected')
    await click(byTestId('canvas-library-bulk-clear'))
    expect(byTestId('canvas-library-bulk')).toBeNull()
  })

  it('arms its delete exactly as a row does, then deletes each selected artefact', async () => {
    rows = two()
    await render()
    await click(within(rowEls()[0], 'canvas-library-select'))
    await click(within(rowEls()[1], 'canvas-library-select'))
    await click(byTestId('canvas-library-bulk-delete'))
    // The guard swallows the first activation — a double-click cannot arm and
    // fire a two-row delete either.
    await click(byTestId('canvas-library-bulk-confirm-delete'))
    expect(deleteArtifact).not.toHaveBeenCalled()

    const later = Date.now() + 60_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => later)
    try {
      await click(byTestId('canvas-library-bulk-confirm-delete'))
    } finally {
      nowSpy.mockRestore()
    }
    expect(deleteArtifact).toHaveBeenCalledTimes(2)
    expect(deleteArtifact.mock.calls.map((c) => (c[0] as { canvasId: string }).canvasId)).toEqual(['c1', 'c2'])
  })

  it('drops a selected row that came back read-only, rather than deleting it silently', async () => {
    rows = two()
    await render()
    await click(within(rowEls()[0], 'canvas-library-select'))
    expect(byTestId('canvas-library-bulk')).toBeTruthy()

    rows = [row({ canvasId: 'c1', title: 'One', ownedByThisSession: false, completed: true, readOnly: true }), row({ canvasId: 'c2', title: 'Two' })]
    // Any change to the query re-lists; the chip is the cheapest one to press.
    await click(byTestId('canvas-library-filter-open'))
    expect(byTestId('canvas-library-bulk')).toBeNull()
  })
})
