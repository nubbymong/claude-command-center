// @vitest-environment jsdom
//
// The Agent Canvas empty state (owner feedback 2026-08-13): with nothing
// rendered, the pane must introduce the surface and put the first render one
// keypress away — not fall silently back to the old Draw pane. These pin the
// landing's contract: intro by default, starter prompt typed into the PTY
// WITHOUT a newline (the user confirms), and the classic sketchpad still one
// click away in both directions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import CanvasEmptyState from '../../../src/renderer/components/CanvasEmptyState'
import { CONFIRM_GUARD_MS } from '../../../src/renderer/hooks/useArmedConfirm'
import { useCanvasStore } from '../../../src/renderer/stores/canvasStore'
import { useCanvasReviewStore } from '../../../src/renderer/stores/canvasReviewStore'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The sketchpad view embeds the real ExcalidrawPane (heavy); the landing's own
// behaviour is what's under test.
vi.mock('../../../src/renderer/components/ExcalidrawPane', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid="sketchpad">{sessionId}</div>,
}))

const ptyWriteMock = vi.fn()
const listReclaimableMock = vi.fn(async () => [] as unknown[])
const reclaimMock = vi.fn(async () => ({ ok: true, state: null }))
const deleteCanvasMock = vi.fn(async () => ({ ok: true }))
const listAllMock = vi.fn(async () => [] as unknown[])
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: ptyWriteMock },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    listReclaimable: listReclaimableMock,
    reclaim: reclaimMock,
    deleteCanvas: deleteCanvasMock,
    listAll: listAllMock,
  },
}

const SID = 'session-1'
let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<CanvasEmptyState sessionId={SID} onClose={() => {}} />)
  })
}

function click(el: Element | null): void {
  expect(el, 'expected element to click').toBeTruthy()
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonByText(text: string): Element | null {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null
}

// #456: a freshly-armed confirm ignores activation for CONFIRM_GUARD_MS so a
// double-click cannot arm and fire in one gesture. Deliberate confirms jump a
// mocked clock past the window instead of really waiting.
let nowSpy: ReturnType<typeof vi.spyOn> | null = null
function passGuard(): void {
  const later = Date.now() + 60_000
  nowSpy?.mockRestore()
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => later)
}
afterEach(() => {
  nowSpy?.mockRestore()
  nowSpy = null
})

beforeEach(() => {
  ptyWriteMock.mockClear()
  useCanvasStore.getState().reset()
  useCanvasReviewStore.getState().reset()
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

describe('the landing (intro view)', () => {
  it('is the default, names the surface, and explains the loop and the controls', () => {
    render()
    expect(container.textContent).toContain('Agent Canvas')
    // The eyebrow. Sentence case in the DOM — the sheet upper-cases it in CSS.
    expect(container.textContent).toContain('Nothing rendered yet')
    expect(container.textContent).toContain('The review loop')
    expect(container.textContent).toContain('Submit review')
    expect(container.textContent).toContain('Agent Canvas')
    // The classic pane is NOT mounted on the greeting.
    expect(container.querySelector('[data-testid="sketchpad"]')).toBeNull()
  })

  it('draws the loop as five ordered steps', () => {
    // The numbering encodes a real sequence (and the return arc from 05 back to
    // 02 is the feature) — so the order and the count are contract, not decor.
    render()
    const steps = Array.from(container.querySelectorAll('ol > li'))
    expect(steps).toHaveLength(5)
    expect(steps.map((li) => li.querySelector('h4')?.textContent)).toEqual([
      'Agent renders',
      'You annotate',
      'Submit review',
      'Agent revises',
      'You resolve',
    ])
    expect(steps.map((li) => li.querySelector('span')?.textContent)).toEqual(['01', '02', '03', '04', '05'])
  })

  it('still teaches the control vocabulary, one click away', () => {
    // Disclosed rather than always-on so the sheet stays a sheet — but nothing
    // the landing used to explain may go missing.
    render()
    expect(container.textContent).not.toContain('drag a rectangle when a note is about an area')
    click(buttonByText('Once something is rendered'))
    for (const control of ['Browse', 'Region', 'Draw', 'Submit review']) {
      expect(container.textContent).toContain(control)
    }
    expect(container.textContent).toContain('drag a rectangle when a note is about an area')
  })

  it('types the starter prompt into the terminal WITHOUT a newline', () => {
    render()
    click(buttonByText('Put this in the terminal'))
    expect(ptyWriteMock).toHaveBeenCalledTimes(1)
    const [sessionId, text] = ptyWriteMock.mock.calls[0]
    expect(sessionId).toBe(SID)
    expect(text).toContain('Agent Canvas')
    // The user presses Enter, not us — a trailing newline would SEND it.
    expect(text).not.toMatch(/[\r\n]/)
  })

  it('asks in plain words — the starter prompt names no MCP tool (the skill carries the workflow)', () => {
    // Owner feedback 2026-08-14: "the user has to have too much knowledge
    // about the mcps". The agent-canvas skill (canvas-plugin.ts) teaches
    // htmlPath / data-ux-id / the loop, so the user never types a tool name.
    render()
    click(buttonByText('Put this in the terminal'))
    const [, text] = ptyWriteMock.mock.calls[0]
    for (const jargon of ['canvas_render', 'canvas_snapshot', 'canvas_review', 'data-ux-id', 'mcp']) {
      expect(String(text).toLowerCase()).not.toContain(jargon.toLowerCase())
    }
    // ...and the same jargon is absent from the landing copy the user reads.
    expect(container.textContent).not.toContain('canvas_render')
  })
})

describe('reclaiming an earlier canvas (the user is the authorization)', () => {
  // Moving a canvas moves the user's private review notes with it. Two rounds
  // of adversarial review showed no inferred identity is safe to do that on,
  // so the pane OFFERS and the user clicks. Nothing may move on its own.
  const candidate = {
    canvasId: 'abc123def456abc123def456',
    versionCount: 3,
    lastRenderedAt: '2026-08-13T19:15:53.893Z',
    cwd: 'C:\\proj',
    sameProject: true,
    conversationShortId: '8c25bfdc',
  }

  it('offers a candidate without taking it, and only moves it when clicked', async () => {
    listReclaimableMock.mockResolvedValueOnce([candidate])
    render()
    await act(async () => {
      await Promise.resolve()
    })

    // Offered, described well enough to recognise...
    expect(container.textContent).toContain('Pick up where you left off')
    expect(container.textContent).toContain('3 versions')
    // ...and NOTHING has moved yet.
    expect(reclaimMock).not.toHaveBeenCalled()

    click(buttonByText('Reopen'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(reclaimMock).toHaveBeenCalledTimes(1)
    expect(reclaimMock).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: candidate.canvasId,
      openTileSessionIds: [],
    })
  })

  it('names each candidate by its conversation, so two from one project differ', async () => {
    // A constant title plus a version count, a timestamp and a cwd is what two
    // canvases from the SAME project both look like — and a mis-click re-binds
    // the other project's private review notes to this session.
    const sibling = { ...candidate, canvasId: 'def456abc123def456abc123', conversationShortId: '59596c8b' }
    listReclaimableMock.mockResolvedValueOnce([candidate, sibling])
    render()
    await act(async () => {
      await Promise.resolve()
    })
    const titles = Array.from(container.querySelectorAll('li > div > div:first-child')).map((d) => d.textContent)
    expect(titles).toHaveLength(2)
    expect(new Set(titles).size, `both candidates rendered as "${titles[0]}"`).toBe(2)
    expect(titles.join(' ')).toContain('8c25bfdc')
    expect(titles.join(' ')).toContain('59596c8b')
  })

  it('falls back to the canvas id when no conversation is known — never a constant', async () => {
    const anonymous = { ...candidate, conversationShortId: undefined }
    const sibling = { ...anonymous, canvasId: 'def456abc123def456abc123' }
    listReclaimableMock.mockResolvedValueOnce([anonymous, sibling])
    render()
    await act(async () => {
      await Promise.resolve()
    })
    const titles = Array.from(container.querySelectorAll('li > div > div:first-child')).map((d) => d.textContent)
    expect(new Set(titles).size).toBe(2)
  })

  it('tells main which tiles are open, so a live one is never offered back', async () => {
    // Main has no reliable oracle for this: the saved-tile file exists only
    // between a graceful Save & Close and the next restore, so during a normal
    // run it reports nobody open. The renderer is the only party that knows.
    useSessionStore.setState({ sessions: [{ id: 'tile-a' }, { id: 'tile-b' }] as never })
    listReclaimableMock.mockResolvedValueOnce([])
    render()
    await act(async () => {
      await Promise.resolve()
    })
    expect(listReclaimableMock).toHaveBeenCalledWith({
      sessionId: SID,
      openTileSessionIds: ['tile-a', 'tile-b'],
    })
    useSessionStore.setState({ sessions: [] })
  })

  it('shows nothing when there is nothing to reclaim', async () => {
    listReclaimableMock.mockResolvedValueOnce([])
    render()
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('Pick up where you left off')
  })
})

describe('deleting a canvas from the front page (#452)', () => {
  // The front page has no top bar, so before this the reclaim rows offered
  // Reopen and nothing else — an old canvas could only be removed by opening
  // the library. Same guarantees as the library's delete: permanent, two-step
  // confirmed, and the second click names what will go.
  const candidate = {
    canvasId: 'abc123def456abc123def456',
    versionCount: 3,
    lastRenderedAt: '2026-08-13T19:15:53.893Z',
    cwd: 'C:\\proj',
    sameProject: true,
    conversationShortId: '8c25bfdc',
  }

  const testid = (id: string): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)

  async function renderWith(candidates: unknown[]): Promise<void> {
    listReclaimableMock.mockResolvedValueOnce(candidates)
    render()
    await act(async () => {
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    deleteCanvasMock.mockReset()
    deleteCanvasMock.mockResolvedValue({ ok: true })
    reclaimMock.mockClear()
    listReclaimableMock.mockClear()
  })

  it('arms on the first click, deletes only on the confirm — and drops the row', async () => {
    await renderWith([candidate])

    click(testid('canvas-reclaim-delete'))
    // Armed, not done: the confirm names what will go, nothing has been deleted.
    expect(deleteCanvasMock).not.toHaveBeenCalled()
    expect(testid('canvas-reclaim-confirm-delete')?.textContent).toBe('Delete 3 versions')

    passGuard()
    click(testid('canvas-reclaim-confirm-delete'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(deleteCanvasMock).toHaveBeenCalledTimes(1)
    expect(deleteCanvasMock).toHaveBeenCalledWith({ canvasId: candidate.canvasId })
    // The row is gone, and with it the whole section (it was the only one).
    expect(container.textContent).not.toContain('Pick up where you left off')
  })

  it('a double-click cannot arm and fire in one gesture (#456)', async () => {
    await renderWith([candidate])

    // The confirm swaps into the arm button's footprint, so both clicks of a
    // double-click land at one point: the first arms, the second hits the
    // freshly-armed confirm. Inside the guard window nothing may fire.
    click(testid('canvas-reclaim-delete'))
    click(testid('canvas-reclaim-confirm-delete'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(deleteCanvasMock).not.toHaveBeenCalled()
    // Still armed — the delete waits for a deliberate second decision.
    expect(testid('canvas-reclaim-confirm-delete')).toBeTruthy()

    passGuard()
    click(testid('canvas-reclaim-confirm-delete'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(deleteCanvasMock).toHaveBeenCalledTimes(1)
  })

  it('arming moves focus onto the confirm — the element swap no longer drops it to body', async () => {
    await renderWith([candidate])
    click(testid('canvas-reclaim-delete'))
    expect(document.activeElement).toBe(testid('canvas-reclaim-confirm-delete'))
  })

  it('a sustained gesture cannot ride the guard out — a blocked activation re-arms it', async () => {
    // Focus sits on the confirm, so a HELD Enter auto-repeats activation into
    // it; anchored to the arm moment alone, the repeats would tick past the
    // window and the last one would fire. Each blocked activation must push
    // the window forward: live only after CONFIRM_GUARD_MS of quiet.
    await renderWith([candidate])
    const realNow = Date.now.bind(Date)
    let offset = 0
    nowSpy?.mockRestore()
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)

    click(testid('canvas-reclaim-delete'))
    offset = CONFIRM_GUARD_MS / 2 // inside the arm window — blocked, re-arms
    click(testid('canvas-reclaim-confirm-delete'))
    offset = CONFIRM_GUARD_MS // past the ARM stamp, inside the re-armed window
    click(testid('canvas-reclaim-confirm-delete'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(deleteCanvasMock).not.toHaveBeenCalled()

    offset = CONFIRM_GUARD_MS * 2 + 100 // quiet has passed since the last attempt
    click(testid('canvas-reclaim-confirm-delete'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(deleteCanvasMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the row and shows the error when the delete is refused', async () => {
    deleteCanvasMock.mockResolvedValueOnce({ ok: false })
    await renderWith([candidate])

    click(testid('canvas-reclaim-delete'))
    passGuard()
    click(testid('canvas-reclaim-confirm-delete'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(testid('canvas-reclaim-delete-error')?.textContent).toContain('could not be deleted')
    expect(container.textContent).toContain('Pick up where you left off')
    // Disarmed — a retry is a fresh, deliberate two-step.
    expect(testid('canvas-reclaim-confirm-delete')).toBeNull()
    expect(testid('canvas-reclaim-delete')).toBeTruthy()
  })

  it('treats a thrown IPC the same as a refusal', async () => {
    deleteCanvasMock.mockRejectedValueOnce(new Error('ipc gone'))
    await renderWith([candidate])

    click(testid('canvas-reclaim-delete'))
    passGuard()
    click(testid('canvas-reclaim-confirm-delete'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(testid('canvas-reclaim-delete-error')?.textContent).toContain('could not be deleted')
    expect(container.textContent).toContain('Pick up where you left off')
  })

  it('disables the row while the delete is in flight — no double-fire, no reclaim mid-delete', async () => {
    let settle: (v: { ok: boolean }) => void = () => {}
    deleteCanvasMock.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => { settle = resolve }),
    )
    await renderWith([candidate])

    click(testid('canvas-reclaim-delete'))
    passGuard()
    click(testid('canvas-reclaim-confirm-delete'))
    const confirm = testid('canvas-reclaim-confirm-delete')
    expect(confirm?.disabled).toBe(true)
    expect(confirm?.textContent).toBe('Deleting…')
    expect((buttonByText('Reopen') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      settle({ ok: true })
      await Promise.resolve()
    })
    expect(deleteCanvasMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Pick up where you left off')
  })

  it('arming another row disarms the first — one confirm at a time', async () => {
    const sibling = { ...candidate, canvasId: 'def456abc123def456abc123', conversationShortId: '59596c8b' }
    await renderWith([candidate, sibling])

    // 'ul > li' — the loop track's steps are an <ol>; the reclaim rows are the
    // only <ul> on the default view.
    const rows = () => Array.from(container.querySelectorAll('ul > li'))
    const arms = container.querySelectorAll('[data-testid="canvas-reclaim-delete"]')
    expect(arms).toHaveLength(2)
    click(arms[0])
    expect(rows()[0].querySelector('[data-testid="canvas-reclaim-confirm-delete"]')).toBeTruthy()

    // The first row is armed, so the one remaining arm button is row 2's.
    click(container.querySelector('[data-testid="canvas-reclaim-delete"]'))
    expect(container.querySelectorAll('[data-testid="canvas-reclaim-confirm-delete"]')).toHaveLength(1)
    expect(rows()[0].querySelector('[data-testid="canvas-reclaim-confirm-delete"]')).toBeNull()
    expect(rows()[1].querySelector('[data-testid="canvas-reclaim-confirm-delete"]')).toBeTruthy()
  })

  it('is disabled while a reclaim is in flight', async () => {
    reclaimMock.mockImplementationOnce(() => new Promise(() => {}))
    await renderWith([candidate])

    click(buttonByText('Reopen'))
    expect(testid('canvas-reclaim-delete')?.disabled).toBe(true)
  })

  it('re-reads the list when the library overlay closes — a library delete cannot strand a row', async () => {
    // The library sits OVER the front page; deleting there used to leave the
    // reclaim row behind, whose Delete then dead-ended on "could not be
    // deleted" — for a canvas that was already gone.
    await renderWith([candidate])
    expect(listReclaimableMock).toHaveBeenCalledTimes(1)

    click(buttonByText('Browse the canvas library'))
    await act(async () => {
      await Promise.resolve()
    })
    // The refetch after Done returns without the canvas the library deleted.
    listReclaimableMock.mockResolvedValueOnce([])
    click(buttonByText('Done'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(listReclaimableMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Pick up where you left off')
  })
})

describe('the sketchpad escape hatch (spec D2)', () => {
  it('is one click away, and one click back', () => {
    render()
    click(buttonByText('Open the sketchpad instead'))
    expect(container.querySelector('[data-testid="sketchpad"]')).toBeTruthy()
    expect(useCanvasStore.getState().bySessionId[SID].emptyView).toBe('sketchpad')

    click(buttonByText('Agent Canvas'))
    expect(container.querySelector('[data-testid="sketchpad"]')).toBeNull()
    expect(container.textContent).toContain('The review loop')
  })

  it('remembers the choice per session within the run', () => {
    useCanvasStore.getState().setEmptyView(SID, 'sketchpad')
    render()
    expect(container.querySelector('[data-testid="sketchpad"]')).toBeTruthy()
  })
})

describe('the notes-panel primer flag', () => {
  it('defaults to visible and dismisses per session', () => {
    expect(useCanvasReviewStore.getState().bySessionId[SID]?.helpDismissed ?? false).toBe(false)
    useCanvasReviewStore.getState().dismissHelp(SID)
    expect(useCanvasReviewStore.getState().bySessionId[SID].helpDismissed).toBe(true)
  })
})
