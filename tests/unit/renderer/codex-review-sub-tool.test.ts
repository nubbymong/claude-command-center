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

  it('renders the Available status + opt-in description', () => {
    act(() => { root.render(React.createElement(CodexReviewSubTool)) })
    const text = container.textContent ?? ''
    expect(text).toContain('Codex review (Claude-driven)')
    expect(text).toContain('Available')
    expect(text).toContain('Enable Codex code review')
    expect(text).toContain('codex_review')
  })
})
