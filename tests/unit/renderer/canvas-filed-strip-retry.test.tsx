// @vitest-environment jsdom
/**
 * The strip IS the offer of a way back, so a refused "Go back" must leave it up.
 *
 * It dismissed itself in a `finally`, next to a catch comment that said "the
 * strip stays up" — so a reclaim that threw, or that came back `{ok:false}`,
 * took away the only affordance for retrying the one action the user asked for.
 * Refusals are ordinary here: a canvas stamped with a different account is one.
 * (Reported by Copilot on #308.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const reclaim = vi.fn()
let emit: (e: { sessionId: string; canvasId: string | null; activeVersionId: string | null }) => void = () => {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reclaim,
    onChanged: (cb: typeof emit) => { emit = cb; return () => {} },
    onReviewChanged: () => () => {},
    getState: async () => null,
  },
}

const CanvasFiledStrip = (await import('../../../src/renderer/components/CanvasFiledStrip')).default
const { useCanvasStore, setupCanvasListener } = await import('../../../src/renderer/stores/canvasStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

setupCanvasListener()

const SID = 's1'

let container: HTMLDivElement
let root: Root

function seedNotice() {
  useCanvasStore.setState({
    bySessionId: {
      [SID]: {
        canvasId: 'c-new', versions: [], activeVersionId: 'v1',
        interactionMode: 'browse', emptyView: 'intro', unseenRender: false,
        loaded: true,
        filedNotice: { canvasId: 'c-old', title: 'Checkout flow', openNotes: 2, draftNotes: 1 },
      },
    },
  } as never)
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CanvasFiledStrip sessionId={SID} />)
  })
}

const backButton = () => container.querySelector('[data-testid="canvas-filed-back"]') as HTMLButtonElement | null

beforeEach(async () => {
  reclaim.mockReset()
  // Clears the pending-switch counts as well, so one test's un-landed switch
  // cannot make the next one think the user asked for what it is about to see.
  useCanvasStore.getState().reset()
  useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false } as never)
  seedNotice()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('CanvasFiledStrip — Go back', () => {
  it('keeps the strip up when the reclaim is REFUSED', async () => {
    reclaim.mockResolvedValue({ ok: false, state: null })
    await render()
    expect(backButton()).toBeTruthy()

    await act(async () => backButton()!.click())

    expect(reclaim).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice).toBeTruthy()
    expect(backButton()).toBeTruthy()
    // ...and it can be retried, which was the point.
    await act(async () => backButton()!.click())
    expect(reclaim).toHaveBeenCalledTimes(2)
  })

  it('keeps the strip up when the reclaim THROWS', async () => {
    reclaim.mockRejectedValue(new Error('ipc gone'))
    await render()
    await act(async () => backButton()!.click())
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice).toBeTruthy()
    expect(backButton()!.disabled).toBe(false)

    // ...and the throw path cancels the announcement too, not just the refusal
    // path. Both are one line, and only one of them was covered.
    await act(async () => useCanvasStore.getState().dismissFiled(SID))
    await act(async () => emit({ sessionId: SID, canvasId: 'c-third', activeVersionId: 'v1' }))
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice?.canvasId).toBe('c-new')
  })

  it('dismisses the strip when the reclaim SUCCEEDS', async () => {
    reclaim.mockResolvedValue({ ok: true, state: null })
    await render()
    await act(async () => backButton()!.click())
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice).toBeNull()
  })

  it('does not leave a stale switch expectation behind on a refusal', async () => {
    // The strip announces the switch before the round-trip so the resulting
    // push is not reported as a filing. Nothing consumes that announcement when
    // the switch does not happen, and the leftover would swallow the next real
    // filing notice for this session.
    reclaim.mockResolvedValue({ ok: false, state: null })
    await render()
    await act(async () => backButton()!.click())

    // Clear the strip by hand, as the user would with the × — the question is
    // what happens to the announcement the click left behind, not to the strip.
    await act(async () => useCanvasStore.getState().dismissFiled(SID))

    // The agent now files this canvas for real. It must still be announced; a
    // leftover expectation would have swallowed it.
    await act(async () => emit({ sessionId: SID, canvasId: 'c-third', activeVersionId: 'v1' }))
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice?.canvasId).toBe('c-new')
  })
})
