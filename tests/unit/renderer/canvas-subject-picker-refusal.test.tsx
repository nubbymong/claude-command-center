// @vitest-environment jsdom
/**
 * A refused switch must not silence the next real filing notice.
 *
 * The picker announces the switch BEFORE the round-trip, so the resulting push
 * is not reported to the user as something that happened to them. Nothing
 * consumes that announcement when the switch does not happen — and refusals are
 * ordinary here, not exceptional: a canvas stamped with a different account is
 * refused by the account floor. The leftover would then swallow the next genuine
 * filing notice for that session, which is the one case the notice exists for.
 * (Reported by Copilot on #308; the picker half had no coverage at all.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasLibraryEntry } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const reclaim = vi.fn()
const listAll = vi.fn()
let emit: (e: { sessionId: string; canvasId: string | null; activeVersionId: string | null }) => void = () => {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reclaim,
    listAll,
    onChanged: (cb: typeof emit) => { emit = cb; return () => {} },
    onReviewChanged: () => () => {},
    getState: async () => null,
  },
}

const CanvasSubjectPicker = (await import('../../../src/renderer/components/CanvasSubjectPicker')).default
const { useCanvasStore, setupCanvasListener } = await import('../../../src/renderer/stores/canvasStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

setupCanvasListener()

const SID = 's1'
const CURRENT = 'c-current'
const OTHER = 'c-other'

const entry = (canvasId: string, title: string): CanvasLibraryEntry => ({
  canvasId,
  title,
  versionCount: 1,
  createdAt: '2026-08-21T09:00:00.000Z',
  lastRenderedAt: '2026-08-21T09:00:00.000Z',
  latestMode: 'design',
  ownedByThisSession: true,
} as CanvasLibraryEntry)

let container: HTMLDivElement
let root: Root

function seedSession(canvasId: string) {
  useCanvasStore.setState({
    bySessionId: {
      [SID]: {
        canvasId, versions: [], activeVersionId: 'v1',
        interactionMode: 'browse', emptyView: 'intro', unseenRender: false,
        filedNotice: null, loaded: true,
      },
    },
  } as never)
}

async function openMenu(): Promise<void> {
  await act(async () => {
    root.render(<CanvasSubjectPicker sessionId={SID} canvasId={CURRENT} title="Checkout flow" onOpenLibrary={() => {}} />)
  })
  const trigger = container.querySelector('[data-testid="canvas-subject-picker"]') as HTMLButtonElement
  await act(async () => trigger.click())
}

/** The row for the canvas that is NOT the current one. */
function otherRowButton(): HTMLButtonElement {
  const rows = Array.from(container.querySelectorAll('[data-testid="canvas-subject-row"]'))
  const row = rows.find((r) => r.textContent?.includes('Login screen'))
  expect(row, 'the other canvas row').toBeTruthy()
  return row!.querySelector('button') as HTMLButtonElement
}

beforeEach(async () => {
  reclaim.mockReset()
  listAll.mockReset()
  listAll.mockResolvedValue([entry(CURRENT, 'Checkout flow'), entry(OTHER, 'Login screen')])
  useCanvasStore.getState().reset()
  useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false } as never)
  seedSession(CURRENT)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('CanvasSubjectPicker — a refused switch', () => {
  it('says so, and leaves the next real filing announceable', async () => {
    reclaim.mockResolvedValue({ ok: false, state: null })
    await openMenu()

    await act(async () => otherRowButton().click())
    expect(reclaim).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('could not be opened here')
    // The menu stays open so the user can see why and try something else.
    expect(container.querySelector('[data-testid="canvas-subject-menu"]')).toBeTruthy()

    // The agent now files the canvas for real. It must still be announced.
    await act(async () => emit({ sessionId: SID, canvasId: 'c-third', activeVersionId: 'v1' }))
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice?.canvasId).toBe(CURRENT)
  })

  it('does the same when the reclaim THROWS', async () => {
    reclaim.mockRejectedValue(new Error('ipc gone'))
    await openMenu()

    await act(async () => otherRowButton().click())
    expect(container.textContent).toContain('could not be opened here')

    await act(async () => emit({ sessionId: SID, canvasId: 'c-third', activeVersionId: 'v1' }))
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice?.canvasId).toBe(CURRENT)
  })

  it('stays silent for a switch that SUCCEEDS — that one is not news', async () => {
    reclaim.mockResolvedValue({ ok: true, state: null })
    await openMenu()

    await act(async () => otherRowButton().click())
    await act(async () => emit({ sessionId: SID, canvasId: OTHER, activeVersionId: 'v1' }))
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice).toBeFalsy()
  })
})
