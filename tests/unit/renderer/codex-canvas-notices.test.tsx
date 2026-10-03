// @vitest-environment jsdom
//
// [host] WP2 PR 4, P4.1 (row 51): the Agent Canvas page's one-line notices for
// a Codex session (src/renderer/components/CodexCanvasNotices.tsx):
//  - the tools without their skills' guidance, and why (section 10 question
//    5's default A), from main's launch record;
//  - no turn events yet (its hooks not trusted), so a filed review reaches
//    Codex when its prompt is ready, read from the hook stream;
//  - a filed review or verdict Codex did not get, with the line and why.
// Nothing for a Claude session.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import CodexCanvasNotices from '../../../src/renderer/components/CodexCanvasNotices'
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

async function mount(): Promise<void> {
  await act(async () => { root.render(<CodexCanvasNotices sessionId={SID} />) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
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
    await act(async () => { undeliveredListeners.forEach((cb) => cb({ sessionId: 'another', canvasId: 'c', line: 'x', reason: 'busy-timeout' })) })
    expect(text('codex-canvas-undelivered')).toBeNull()
    await act(async () => { undeliveredListeners.forEach((cb) => cb({ sessionId: SID, canvasId: 'c', line, reason: 'busy-timeout' })) })
    expect(text('codex-canvas-undelivered')).toContain(line)
    expect(text('codex-canvas-undelivered')).toMatch(/stayed busy/)
    await act(async () => { (host.querySelector('[data-testid="codex-canvas-undelivered-dismiss"]') as HTMLButtonElement).click() })
    expect(text('codex-canvas-undelivered')).toBeNull()
  })

  it('nothing at all for a Claude session', async () => {
    setProvider('claude')
    guidance = { guidance: 'tools-only', reason: 'npm-route' }
    await mount()
    expect(host.innerHTML).toBe('')
  })
})
