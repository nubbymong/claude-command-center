// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: CodexReviewSubTool } = await import('../../../src/renderer/components/conductor-mcp/CodexReviewSubTool')

describe('CodexReviewSubTool (P7.4)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders the Available status + global-availability description', () => {
    act(() => { root.render(React.createElement(CodexReviewSubTool)) })
    const text = container.textContent ?? ''
    expect(text).toContain('Codex review (Claude-driven)')
    expect(text).toContain('Available')
    // 2.1.0-beta.5: the per-config opt-in is retired — the card describes the
    // global gate (Codex master switch) instead.
    expect(text).toContain('every local Claude Code session')
    expect(text).toContain('codex_review')
  })
})
