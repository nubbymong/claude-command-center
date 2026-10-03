// @vitest-environment jsdom
//
// [host] WP2 PR 4, P4.1 (row 51): the Agent Canvas page's one-line notices for
// a Codex session (src/renderer/components/CodexCanvasNotices.tsx):
//  - the tools without their skills' guidance, and why (section 10 question
//    5's default A), from main's launch record;
//  - no turn events yet (its hooks not trusted), so a filed review reaches
//    Codex when its prompt is ready, read from the hook stream;
//  - a filed review or verdict Codex did not get, with the line and why, on
//    the canvas it was filed on, kept while the page is closed (review A-1:
//    src/renderer/stores/codexMarkerNoticeStore.ts) until dismissed.
// Nothing for a Claude session.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import CodexCanvasNotices from '../../../src/renderer/components/CodexCanvasNotices'
import { useCodexMarkerNoticeStore, setupCodexMarkerNoticeListener, parseMarkerUndelivered, _resetCodexMarkerNoticesForTest, MARKER_NOTICES_PER_CANVAS, MARKER_NOTICE_CANVASES } from '../../../src/renderer/stores/codexMarkerNoticeStore'
import type { CanvasMarkerUndelivered, CanvasSessionGuidance } from '../../../src/shared/types'
import type { HookEvent } from '../../../src/shared/hook-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SID = 'ntc11111ntc11111ntc11111'
let host: HTMLDivElement
let root: Root
let guidance: CanvasSessionGuidance | null
let buffer: HookEvent[]
let hookListeners: Array<(e: HookEvent) => void>
let undeliveredListeners: Array<(u: CanvasMarkerUndelivered) => void>

function setProvider(provider: 'claude' | 'codex'): void {
  useSessionStore.setState({ sessions: [{ id: SID, provider, createdAt: 1, ptyExited: false } as never] } as never)
}

async function mount(canvasId: string | null = 'c'): Promise<void> {
  await act(async () => { root.render(<CodexCanvasNotices sessionId={SID} canvasId={canvasId} />) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const push = async (u: unknown): Promise<void> => {
  await act(async () => { undeliveredListeners.forEach((cb) => cb(u as CanvasMarkerUndelivered)) })
}

beforeEach(() => {
  guidance = null
  buffer = []
  hookListeners = []
  undeliveredListeners = []
  ;(window as any).electronAPI = {
    canvas: {
      sessionGuidance: async () => guidance,
      onAgentMarkerUndelivered: (cb: (u: CanvasMarkerUndelivered) => void) => { undeliveredListeners.push(cb); return () => {} },
    },
    hooks: {
      getBuffer: async () => buffer,
      onEvent: (cb: (e: HookEvent) => void) => { hookListeners.push(cb); return () => {} },
    },
  }
  _resetCodexMarkerNoticesForTest()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = (id: string): string | null => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null

describe('a Codex session\'s canvas notices', () => {
  it.each([
    ['npm-route', /npm command/],
    ['user-instructions', /developer instructions, which the app never replaces/],
    ['unknown-settings', /could not confirm where this Codex version reads its settings/],
    ['skills-not-staged', /skills could not be put in place/],
  ] as const)('says the tools came without their guidance, and why (%s)', async (reason, words) => {
    setProvider('codex')
    guidance = { guidance: 'tools-only', reason }
    buffer = [{ sessionId: SID, event: 'SessionStart', payload: {}, ts: 1 }]
    await mount()
    expect(text('codex-canvas-guidance')).toMatch(/without their skills' guidance/)
    expect(text('codex-canvas-guidance')).toMatch(words)
  })

  it('[host] a launch through the resume picker: the guidance reaches only a new conversation started in the session\'s folder, and the page says so (review RVMFIX-3)', async () => {
    setProvider('codex')
    guidance = { guidance: 'picker' }
    buffer = [{ sessionId: SID, event: 'SessionStart', payload: {}, ts: 1 }]
    await mount()
    expect(text('codex-canvas-guidance')).toBe('This Codex session was started through the resume picker: the canvas tools have their skills\' guidance only in a new conversation started in this session\'s folder (a resumed conversation keeps the instructions it started with).')
  })

  it('[host] a marker not confirmed in the prompt: may still be there, unsent, never said to be taken back (review R-1)', async () => {
    setProvider('codex')
    guidance = { guidance: 'full' }
    buffer = [{ sessionId: SID, event: 'Stop', payload: {}, ts: 1 }]
    await mount()
    await push({ sessionId: SID, canvasId: 'c', line: 'Approved v2 on the canvas', reason: 'not-drawn' })
    expect(text('codex-canvas-undelivered')).toBe('Codex did not get "Approved v2 on the canvas": the app could not confirm it in Codex\'s prompt. If it is still there, send it or clear it in the session.')
    expect(text('codex-canvas-undelivered')).not.toMatch(/taken back/)
  })

  it('nothing when the guidance came with the tools and turn events arrive', async () => {
    setProvider('codex')
    guidance = { guidance: 'full' }
    buffer = [{ sessionId: SID, event: 'UserPromptSubmit', payload: {}, ts: 1 }]
    await mount()
    expect(host.querySelector('[data-testid="codex-canvas-notices"]')).toBeNull()
  })

  it('no turn event yet: says a filed review reaches Codex once its prompt is ready, until the first event arrives', async () => {
    setProvider('codex')
    guidance = { guidance: 'full' }
    await mount()
    expect(text('codex-canvas-no-turn-events')).toMatch(/no turn events yet .* once its prompt is ready/)
    await act(async () => { hookListeners.forEach((cb) => cb({ sessionId: 'another', event: 'Stop', payload: {}, ts: 2 })) })
    expect(text('codex-canvas-no-turn-events')).not.toBeNull()
    await act(async () => { hookListeners.forEach((cb) => cb({ sessionId: SID, event: 'Stop', payload: {}, ts: 3 })) })
    expect(text('codex-canvas-no-turn-events')).toBeNull()
  })

  it('a marker Codex did not get: the line and why, until dismissed', async () => {
    setProvider('codex')
    guidance = { guidance: 'full' }
    buffer = [{ sessionId: SID, event: 'Stop', payload: {}, ts: 1 }]
    await mount()
    const line = `Review #3 ${String.fromCharCode(0x2014)} 5 notes ${String.fromCharCode(0xb7)} canvas_review R3`
    await push({ sessionId: 'another', canvasId: 'c', line: 'x', reason: 'busy-timeout' })
    expect(text('codex-canvas-undelivered')).toBeNull()
    await push({ sessionId: SID, canvasId: 'c', line, reason: 'busy-timeout' })
    expect(text('codex-canvas-undelivered')).toContain(line)
    expect(text('codex-canvas-undelivered')).toMatch(/stayed busy/)
    await act(async () => { (host.querySelector('[data-testid="codex-canvas-undelivered-dismiss"]') as HTMLButtonElement).click() })
    expect(text('codex-canvas-undelivered')).toBeNull()
  })

  it('[host] one that fails while the page is closed is kept, and shown when the canvas is open again', async () => {
    setProvider('codex')
    guidance = { guidance: 'full' }
    buffer = [{ sessionId: SID, event: 'Stop', payload: {}, ts: 1 }]
    setupCodexMarkerNoticeListener()
    await push({ sessionId: SID, canvasId: 'c', line: 'Approved v4 on the canvas', reason: 'busy-timeout' })
    expect(host.innerHTML).toBe('')
    await mount('c')
    expect(text('codex-canvas-undelivered')).toContain('Approved v4 on the canvas')
    // Closing the page and opening it again keeps it.
    await act(async () => { root.render(<></>) })
    expect(text('codex-canvas-undelivered')).toBeNull()
    await mount('c')
    expect(text('codex-canvas-undelivered')).toContain('Approved v4 on the canvas')
  })

  it('[host] shown on the canvas it was filed on, not on another one the page has open', async () => {
    setProvider('codex')
    guidance = { guidance: 'full' }
    buffer = [{ sessionId: SID, event: 'Stop', payload: {}, ts: 1 }]
    await mount('other-canvas')
    await push({ sessionId: SID, canvasId: 'c', line: 'Review #2 filed', reason: 'prompt-on-screen' })
    expect(text('codex-canvas-undelivered')).toBeNull()
    await mount(null)
    expect(text('codex-canvas-undelivered')).toBeNull()
    await mount('c')
    expect(text('codex-canvas-undelivered')).toContain('Review #2 filed')
  })

  it('[host] dismissed stays dismissed when the page is opened again', async () => {
    setProvider('codex')
    guidance = { guidance: 'full' }
    buffer = [{ sessionId: SID, event: 'Stop', payload: {}, ts: 1 }]
    await mount('c')
    await push({ sessionId: SID, canvasId: 'c', line: 'Approved v5 on the canvas', reason: 'not-drawn' })
    await act(async () => { (host.querySelector('[data-testid="codex-canvas-undelivered-dismiss"]') as HTMLButtonElement).click() })
    await act(async () => { root.render(<></>) })
    await mount('c')
    expect(text('codex-canvas-undelivered')).toBeNull()
    expect(useCodexMarkerNoticeStore.getState().byCanvasId).toEqual({})
  })

  it('nothing at all for a Claude session', async () => {
    setProvider('claude')
    guidance = { guidance: 'tools-only', reason: 'npm-route' }
    await mount()
    expect(host.innerHTML).toBe('')
  })
})

describe('the undelivered-marker store (review A-1)', () => {
  it('[host] listens once for the renderer\'s life', () => {
    setupCodexMarkerNoticeListener()
    setupCodexMarkerNoticeListener()
    expect(undeliveredListeners).toHaveLength(1)
  })

  it.each([
    ['nothing', undefined],
    ['no canvas', { sessionId: SID, line: 'x', reason: 'busy-timeout' }],
    ['an empty line', { sessionId: SID, canvasId: 'c', line: '', reason: 'busy-timeout' }],
    ['a reason main never sends', { sessionId: SID, canvasId: 'c', line: 'x', reason: 'made-up' }],
    ['a field of the wrong type', { sessionId: SID, canvasId: 7, line: 'x', reason: 'busy-timeout' }],
  ])('[host] keeps no push with %s', async (_name, raw) => {
    expect(parseMarkerUndelivered(raw)).toBeNull()
    setupCodexMarkerNoticeListener()
    await push(raw)
    expect(useCodexMarkerNoticeStore.getState().byCanvasId).toEqual({})
  })

  it('[host] bounded per canvas and in canvases, the oldest let go first', () => {
    const add = useCodexMarkerNoticeStore.getState().add
    for (let i = 0; i < MARKER_NOTICES_PER_CANVAS + 3; i++) add({ sessionId: SID, canvasId: 'c', line: `line ${i}`, reason: 'busy-timeout' })
    const lines = useCodexMarkerNoticeStore.getState().byCanvasId.c.map((u) => u.line)
    expect(lines).toHaveLength(MARKER_NOTICES_PER_CANVAS)
    expect(lines[lines.length - 1]).toBe(`line ${MARKER_NOTICES_PER_CANVAS + 2}`)
    for (let i = 0; i < MARKER_NOTICE_CANVASES + 2; i++) add({ sessionId: SID, canvasId: `k${i}`, line: 'x', reason: 'busy-timeout' })
    const ids = Object.keys(useCodexMarkerNoticeStore.getState().byCanvasId)
    expect(ids).toHaveLength(MARKER_NOTICE_CANVASES)
    expect(ids).not.toContain('c')
    expect(ids).toContain(`k${MARKER_NOTICE_CANVASES + 1}`)
  })
})
