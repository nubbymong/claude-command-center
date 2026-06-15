// @vitest-environment jsdom
// tests/unit/renderer/logs/chat-transcript.test.tsx
//
// Render tests for the split transcript:
//   - ChatTranscriptView (PRESENTATIONAL): role headers (you/claude), a tool row,
//     dividers and an unknown row render from injected props — NO hook, NO IPC.
//   - ChatTranscript (CONTAINER): wires ONE useWindowedTurns to the view (we
//     assert exactly one readMessages('tail') + one onNewMessages subscription,
//     i.e. the hook is single-instanced, not double-mounted).
// The heavy windowing logic is covered by use-windowed-turns.test.tsx.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import ChatTranscript from '../../../../src/renderer/components/logs/ChatTranscript'
import ChatTranscriptView from '../../../../src/renderer/components/logs/ChatTranscriptView'
import type { Logs2Message } from '../../../../src/renderer/hooks/useWindowedTurns'

const YOU = String.fromCodePoint(0x276f)
const CLAUDE = String.fromCodePoint(0x2733)

function msg(partial: Partial<Logs2Message> & { idx: number; kind: string }): Logs2Message {
  return {
    runId: 1,
    ts: 1000 + partial.idx,
    role: 'system',
    content: '',
    toolName: null,
    toolMeta: null,
    ...partial,
  } as Logs2Message
}

const WINDOW: Logs2Message[] = [
  msg({ idx: 0, kind: 'message', role: 'user', content: 'hello claude' }),
  msg({ idx: 1, kind: 'message', role: 'assistant', content: 'hi **there**' }),
  msg({ idx: 2, kind: 'tool_call', role: 'assistant', toolName: 'Edit', toolMeta: 'src/x.ts' }),
  msg({ idx: 3, kind: 'clear', role: 'system', content: 'new conversation' }),
  msg({ idx: 4, kind: 'relaunch', role: 'system', content: 'session relaunched' }),
  msg({ idx: 5, kind: 'unknown', role: 'system', content: '{"weird":true}' }),
]

/** Default props for the presentational view (a settled, non-following window). */
function viewProps(messages: Logs2Message[]) {
  return {
    messages,
    follow: false,
    setFollow: vi.fn(),
    loading: false,
    loadingOlder: false,
    error: null,
    loadOlder: vi.fn(async () => {}),
    prependToken: 0,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ChatTranscriptView (presentational)', () => {
  it('renders you/claude role headers, a tool row, dividers and an unknown row', async () => {
    await act(async () => {
      root.render(React.createElement(ChatTranscriptView, viewProps(WINDOW)))
    })
    await flush()

    const text = container.textContent || ''
    // Layout C role headers.
    expect(text).toContain(`${YOU}`)
    expect(text).toContain('you')
    expect(text).toContain(`${CLAUDE}`)
    expect(text).toContain('claude')
    // Markdown message body rendered through the sanitizer.
    expect(container.querySelector('strong')?.textContent).toBe('there')
    // Tool row.
    expect(text).toContain('Edit')
    // Dividers.
    expect(container.querySelector('[data-divider="clear"]')).toBeTruthy()
    expect(container.querySelector('[data-divider="relaunch"]')).toBeTruthy()
    // Unknown muted row.
    expect(container.querySelector('[data-unknown="true"]')).toBeTruthy()
    expect(text).toContain('unsupported entry')
  })

  it('blue tone for user header, mauve tone for claude header', async () => {
    await act(async () => {
      root.render(React.createElement(ChatTranscriptView, viewProps(WINDOW)))
    })
    await flush()
    const userRow = container.querySelector('[data-role="user"]')
    const asstRow = container.querySelector('[data-role="assistant"]')
    expect(userRow?.querySelector('.text-\\[var\\(--color-blue\\)\\]')).toBeTruthy()
    expect(asstRow?.querySelector('.text-\\[var\\(--color-mauve\\)\\]')).toBeTruthy()
  })

  it('does NOT call useWindowedTurns — renders with no electronAPI present', async () => {
    // Remove the IPC entirely: a presentational component must not touch it.
    const saved = (globalThis as any).window.electronAPI
    delete (globalThis as any).window.electronAPI
    try {
      await act(async () => {
        root.render(React.createElement(ChatTranscriptView, viewProps(WINDOW)))
      })
      await flush()
      expect(container.querySelector('[data-testid="chat-transcript"]')).toBeTruthy()
    } finally {
      ;(globalThis as any).window.electronAPI = saved
    }
  })
})

describe('ChatTranscriptView — top-sentinel load-older dedup (race guard)', () => {
  it('two rapid top-sentinel scroll events issue only ONE loadOlder call', async () => {
    // A loadOlder that stays in-flight (never resolves during the test) so the
    // lagging `loadingOlder` prop can't flip between the two scroll events — this
    // is exactly the window the synchronous in-flight ref must close.
    let resolveOlder: () => void = () => {}
    const loadOlder = vi.fn(() => new Promise<void>((res) => { resolveOlder = res }))

    const props = { ...viewProps(WINDOW), loadOlder, loadingOlder: false }
    await act(async () => {
      root.render(React.createElement(ChatTranscriptView, props))
    })
    await flush()

    const scroller = container.querySelector('[data-testid="chat-transcript"]') as HTMLElement
    // jsdom has no layout: force the geometry so onScroll's top-sentinel branch fires.
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    scroller.scrollTop = 0 // at the very top → under TOP_THRESHOLD

    // Fire two scroll events back-to-back (coalesced before the prop can flip).
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    // The synchronous in-flight latch must gate the 2nd event out entirely.
    expect(loadOlder).toHaveBeenCalledTimes(1)

    // Cleanup: resolve the pending promise so React doesn't warn on unmount.
    await act(async () => { resolveOlder(); await Promise.resolve() })
  })
})

describe('ChatTranscriptView — jump-to-result scroll + highlight', () => {
  it('scrolls the jump target into view (centered) and flashes a highlight on it', async () => {
    const scrollSpy = vi.fn()
    ;(Element.prototype as any).scrollIntoView = scrollSpy

    const props = { ...viewProps(WINDOW), jumpTarget: { runId: 1, idx: 2, nonce: 1 } }
    await act(async () => {
      root.render(React.createElement(ChatTranscriptView, props))
    })
    await flush()

    // Each row carries a stable data-msgkey so the view can find the target node.
    const target = container.querySelector('[data-msgkey="1:2"]') as HTMLElement
    expect(target).toBeTruthy()
    // The clicked message flashes (the brief highlight class is applied to it).
    expect(target.className).toContain('cct-jump-flash')
    // Non-target rows do NOT get the highlight.
    expect((container.querySelector('[data-msgkey="1:0"]') as HTMLElement).className).not.toContain('cct-jump-flash')
    // scrollIntoView was invoked on the target node, centered.
    expect(scrollSpy).toHaveBeenCalled()
    expect(scrollSpy.mock.instances[0]).toBe(target)
    expect(scrollSpy.mock.calls[0][0]).toMatchObject({ block: 'center' })
  })

  it('does NOT scroll or highlight when no jumpTarget is supplied', async () => {
    const scrollSpy = vi.fn()
    ;(Element.prototype as any).scrollIntoView = scrollSpy
    await act(async () => {
      root.render(React.createElement(ChatTranscriptView, viewProps(WINDOW)))
    })
    await flush()
    expect(scrollSpy).not.toHaveBeenCalled()
    expect(container.querySelector('.cct-jump-flash')).toBeNull()
  })

  it('removes the highlight after the flash window elapses', async () => {
    vi.useFakeTimers()
    ;(Element.prototype as any).scrollIntoView = vi.fn()
    try {
      const props = { ...viewProps(WINDOW), jumpTarget: { runId: 1, idx: 1, nonce: 7 } }
      await act(async () => {
        root.render(React.createElement(ChatTranscriptView, props))
      })
      // Flush the layout effect's microtasks under fake timers.
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(container.querySelector('[data-msgkey="1:1"]')?.className).toContain('cct-jump-flash')
      // After the flash duration, the highlight is gone (UI not stuck on it).
      await act(async () => { vi.advanceTimersByTime(2200) })
      expect(container.querySelector('[data-msgkey="1:1"]')?.className ?? '').not.toContain('cct-jump-flash')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ChatTranscript (container)', () => {
  it('instantiates EXACTLY ONE windowing hook (one tail read, one subscription)', async () => {
    const readMessages = vi.fn(async () => WINDOW)
    const onNewMessages = vi.fn(() => () => {})
    ;(globalThis as any).window.electronAPI = { logs2: { readMessages, onNewMessages } }

    await act(async () => {
      root.render(React.createElement(ChatTranscript, { scope: { sessionId: 's1' } }))
    })
    await flush()

    // Single instance: exactly one initial tail read and one new-messages sub.
    const tailReads = readMessages.mock.calls.filter((c: any[]) => c[0]?.anchor === 'tail')
    expect(tailReads.length).toBe(1)
    expect(onNewMessages).toHaveBeenCalledTimes(1)

    // And it renders the view content from that one window.
    const text = container.textContent || ''
    expect(text).toContain('claude')
    expect(container.querySelector('[data-divider="clear"]')).toBeTruthy()
  })
})
