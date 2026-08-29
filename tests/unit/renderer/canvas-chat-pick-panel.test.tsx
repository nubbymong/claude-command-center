// @vitest-environment jsdom
//
// canvas_pick (#373 follow-on), the panel half — guards two spec-review fixes:
//  1. A chat-picked note reads as the USER's decision, not an agent close: it
//     shows "picked in chat", it does NOT show the "nobody else checked it"
//     caveat, and it is NOT counted in the "N on your instruction — not
//     approved" chip.
//  2. The Ctrl+V window paste listener is registered ONLY while the pane is
//     active, so a paste never lands in a hidden session's composer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import CanvasNotesPanelDefault from '../../../src/renderer/components/CanvasNotesPanel'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const CanvasNotesPanel = CanvasNotesPanelDefault
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const V2 = { id: 'v2', mode: 'design', createdAt: '2026-08-23T10:00:00Z', source: { mode: 'design', entry: 'index.html' } } as CanvasVersion

const REVIEW: Review = {
  id: 'R1',
  canvas: { canvasId: 'canvas-1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds: ['a1'],
  status: 'submitted',
  createdAt: '2026-08-23T09:00:00Z',
  submittedAt: '2026-08-23T09:05:00Z',
}

/** A chat pick: approved, but the agent recorded it on the user's chat word.
 *  closedBy 'agent' + pickSource 'chat' + closedFrom 'addressed' — the exact
 *  combination that used to trip the agent-close caveat and chip. */
const CHAT_PICKED: Annotation = {
  id: 'a1',
  reviewId: 'R1',
  scope: 'general',
  note: 'the divider is heavy',
  versionId: 'v1',
  state: 'approved',
  closedBy: 'agent',
  closedFrom: 'addressed',
  pickSource: 'chat',
  variants: [
    { key: 'A', label: 'thin rule' },
    { key: 'B', label: 'no rule' },
  ],
  chosenVariantKey: 'B',
}

/** An agent VERDICT close (canvas_verdict) — the case the caveat IS for. */
const AGENT_VERDICT: Annotation = {
  id: 'a1',
  reviewId: 'R1',
  scope: 'general',
  note: 'drop the legacy banner',
  versionId: 'v1',
  state: 'stale',
  closedBy: 'agent',
  closedFrom: 'addressed',
}

const stateWith = (note: Annotation): CanvasReviewState => ({
  canvasId: 'canvas-1',
  sessionId: SID,
  reviews: [REVIEW],
  annotations: [note],
})

let container: HTMLDivElement
let root: Root
let currentState: CanvasReviewState

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => currentState),
    reviewMarkSeen: vi.fn(async () => currentState),
  },
}

async function render(props: { isActive?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel
        sessionId={SID}
        version={V2}
        getGlassApi={() => null}
        onReturnToTerminal={() => {}}
        isActive={props.isActive}
      />,
    )
  })
}

/** A fully-closed round starts collapsed, so first expand the group header,
 *  then (optionally) the Closed sub-list inside it. */
async function expandGroup(): Promise<void> {
  const header = container.querySelector('[data-testid="review-group"] button') as HTMLButtonElement | null
  if (header && header.getAttribute('aria-expanded') !== 'true') {
    await act(async () => header.click())
  }
}

async function openClosed(): Promise<void> {
  await expandGroup()
  const toggle = container.querySelector('[data-testid="review-closed-toggle"]') as HTMLButtonElement | null
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
    await act(async () => toggle.click())
  }
}

beforeEach(() => {
  useCanvasReviewStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('a chat pick reads as the user’s decision', () => {
  it('labels the closed row "picked in chat" and shows the winning variant', async () => {
    currentState = stateWith(CHAT_PICKED)
    await render({ isActive: true })
    await openClosed()
    const row = container.querySelector('[data-testid="review-closed-note"]')!
    expect(row.textContent).toContain('picked in chat')
    expect(container.querySelector('[data-testid="review-closed-picked-variant"]')!.textContent).toContain('no rule')
  })

  it('does NOT show the "nobody else checked it" caveat on a chat pick', async () => {
    currentState = stateWith(CHAT_PICKED)
    await render({ isActive: true })
    await openClosed()
    expect(container.querySelector('[data-testid="review-closed-agent-both"]')).toBeNull()
  })

  it('DOES show that caveat on a real agent verdict close (the case it is for)', async () => {
    currentState = stateWith(AGENT_VERDICT)
    await render({ isActive: true })
    await openClosed()
    expect(container.querySelector('[data-testid="review-closed-agent-both"]')).not.toBeNull()
  })

  it('excludes a chat pick from the "on your instruction — not approved" chip', async () => {
    currentState = stateWith(CHAT_PICKED)
    await render({ isActive: true })
    await expandGroup()
    // The only closed note is a chat pick, so the not-approved chip must be absent.
    expect(container.querySelector('[data-testid="review-agent-closed-chip"]')).toBeNull()
  })

  it('still shows the chip for a real agent verdict close', async () => {
    currentState = stateWith(AGENT_VERDICT)
    await render({ isActive: true })
    await expandGroup()
    expect(container.querySelector('[data-testid="review-agent-closed-chip"]')).not.toBeNull()
  })
})

describe('the Ctrl+V paste listener is scoped to the active pane', () => {
  it('registers a window paste listener only while active', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')

    currentState = stateWith(CHAT_PICKED)
    // Inactive pane (a hidden session): no paste listener at all.
    await render({ isActive: false })
    expect(add.mock.calls.filter((c) => c[0] === 'paste')).toHaveLength(0)

    // Becomes active: exactly one paste listener attaches.
    await render({ isActive: true })
    expect(add.mock.calls.filter((c) => c[0] === 'paste')).toHaveLength(1)

    // Goes inactive again: the listener is removed, so a hidden pane never
    // grabs a paste meant for the active one.
    await render({ isActive: false })
    expect(remove.mock.calls.filter((c) => c[0] === 'paste')).toHaveLength(1)

    add.mockRestore()
    remove.mockRestore()
  })
})

