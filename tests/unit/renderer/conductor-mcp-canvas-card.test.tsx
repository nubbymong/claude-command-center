// @vitest-environment jsdom
//
// The Conductor MCP page must advertise every tool family the server actually
// registers (owner feedback 2026-08-13: the canvas tools shipped across three
// phases and the page still listed only Vision / Codex review / Host
// transfer). Pins the Agent Canvas card and its full tool list.

import { describe, it, expect } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import AgentCanvasSubTool from '../../../src/renderer/components/conductor-mcp/AgentCanvasSubTool'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentCanvasSubTool', () => {
  it('names the family, its availability, and all three registered tools', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      createRoot(container).render(<AgentCanvasSubTool />)
    })
    expect(container.textContent).toContain('Agent Canvas')
    expect(container.textContent).toContain('Available')
    // The full registered surface, so a fourth tool landing without a page
    // update fails here rather than going quietly unadvertised again.
    expect(container.textContent).toContain('canvas_render')
    expect(container.textContent).toContain('canvas_snapshot')
    expect(container.textContent).toContain('canvas_review')
    expect(container.textContent).toContain('Agent Canvas button')
  })
})
