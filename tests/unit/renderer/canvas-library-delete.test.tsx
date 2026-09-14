// @vitest-environment jsdom
//
// The canvas library's DESTRUCTIVE row action, after the v2 rewrite (M4).
//
// Delete is the one destructive canvas operation there is, so the whole surface
// of this file is the two-step arm and its double-click proofing (#456). What
// changed in v2 is the SUBJECT: a row is an artefact run, not a canvas, so the
// row's delete removes that run. A canvas's last artefact is a different
// operation with its own path discipline in main (`deleteArtifact` refuses it
// as 'only-artifact'), and the Library is where that operation lives — so the
// refusal is a hand-off inside the same armed confirm, not an error the user
// has to understand.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasLibraryRow } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { CanvasLibrary } = await import('../../../src/renderer/components/CanvasLibrary')

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
    audit: { when: '2026-08-29T09:00:00Z' },
    versionLabel: 'v3',
    noteCount: 0,
    ownedByThisSession: true,
    readOnly: false,
    updatedAt: '2026-08-29T09:00:00Z',
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let rows: CanvasLibraryRow[]
let artifactDelete: { ok: boolean; reason?: string }

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    libraryList: vi.fn(async () => ({ rows, truncated: false })),
    deleteArtifact: vi.fn(async () => artifactDelete),
    deleteCanvas: vi.fn(async () => ({ ok: true })),
    archiveArtifact: vi.fn(async () => ({ ok: true, state: null })),
    reclaim: vi.fn(async () => ({ ok: true, state: null })),
    completeReopen: vi.fn(async () => ({ ok: true })),
    evidenceRead: vi.fn(async () => null),
  },
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CanvasLibrary sessionId={SID} onClose={() => {}} />)
  })
}

const byTestId = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)

async function click(el: Element | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

beforeEach(() => {
  rows = [row({ owed: '1 note with the agent' })]
  artifactDelete = { ok: true }
  const api = (window as any).electronAPI.canvas
  for (const fn of Object.values(api)) if (typeof fn === 'function' && 'mockClear' in (fn as any)) (fn as any).mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  nowSpy?.mockRestore()
  nowSpy = null
})

// #456: a freshly-armed confirm ignores activation for CONFIRM_GUARD_MS so a
// double-click cannot arm and fire in one gesture. Deliberate confirms jump a
// mocked clock past the window instead of really waiting.
let nowSpy: ReturnType<typeof vi.spyOn> | null = null
function passGuard(): void {
  const later = Date.now() + 60_000
  nowSpy?.mockRestore()
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => later)
}

describe('the row no longer offers a bulk close-out', () => {
  it('shows no "Close notes" control, whatever the row reports as outstanding', async () => {
    await render()
    expect(byTestId('canvas-library-close')).toBeNull()
    expect(byTestId('canvas-library-close-confirm')).toBeNull()
    expect((window as any).electronAPI.canvas.reviewCloseOut).toBeUndefined()
  })
})

describe('delete is two-step and double-click-proof (#456)', () => {
  it('a double-click cannot arm and fire delete in one gesture', async () => {
    await render()
    const deleteArtifactFn = (window as any).electronAPI.canvas.deleteArtifact
    deleteArtifactFn.mockClear()
    await click(byTestId('canvas-library-delete'))
    await click(byTestId('canvas-library-confirm-delete'))
    expect(deleteArtifactFn).not.toHaveBeenCalled()
    // Still armed — the delete waits for a deliberate second decision.
    expect(byTestId('canvas-library-confirm-delete')).toBeTruthy()

    passGuard()
    await click(byTestId('canvas-library-confirm-delete'))
    expect(deleteArtifactFn).toHaveBeenCalledTimes(1)
    expect(deleteArtifactFn).toHaveBeenCalledWith({ sessionId: SID, canvasId: 'canvas-a', versionId: 'v3', openTileSessionIds: [] })
  })

  it('arming moves focus onto the confirm', async () => {
    await render()
    await click(byTestId('canvas-library-delete'))
    expect(document.activeElement).toBe(byTestId('canvas-library-confirm-delete'))
  })

  it("names what goes, so the confirm is not a bare 'are you sure'", async () => {
    await render()
    await click(byTestId('canvas-library-delete'))
    expect(byTestId('canvas-library-confirm-delete')?.textContent).toContain('v3')
    expect(byTestId('canvas-library-confirm-delete')?.textContent).toContain('notes')
  })

  it("hands off to deleting the CANVAS when the run is its only artefact", async () => {
    artifactDelete = { ok: false, reason: 'only-artifact' }
    await render()
    await click(byTestId('canvas-library-delete'))
    passGuard()
    await click(byTestId('canvas-library-confirm-delete'))
    expect((window as any).electronAPI.canvas.deleteArtifact).toHaveBeenCalledTimes(1)
    expect((window as any).electronAPI.canvas.deleteCanvas).toHaveBeenCalledWith({ sessionId: SID, canvasId: 'canvas-a', openTileSessionIds: [] })
    expect(byTestId('canvas-library-error')).toBeNull()
  })

  it('says so, in plain words, when main refuses the delete outright', async () => {
    artifactDelete = { ok: false, reason: 'not-found' }
    await render()
    await click(byTestId('canvas-library-delete'))
    passGuard()
    await click(byTestId('canvas-library-confirm-delete'))
    expect((window as any).electronAPI.canvas.deleteCanvas).not.toHaveBeenCalled()
    expect(byTestId('canvas-library-error')?.textContent).toContain('could not be deleted')
  })
})
