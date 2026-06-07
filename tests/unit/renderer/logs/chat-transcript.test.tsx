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
