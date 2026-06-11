// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import ToolCallRow from '../../../../src/renderer/components/logs/ToolCallRow'

describe('ToolCallRow', () => {
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

  it('renders the ⏺ glyph via String.fromCodePoint(0x23FA)', () => {
    act(() =>
      root.render(React.createElement(ToolCallRow, { toolName: 'Edit', toolMeta: '{"file":"a.ts"}' })),
    )
    expect(container.textContent).toContain(String.fromCodePoint(0x23fa))
  })

  it('collapsed: shows toolName, a preview, and a chevron; toolMeta body hidden', () => {
    act(() =>
      root.render(
        React.createElement(ToolCallRow, {
          toolName: 'Bash',
          toolMeta: 'npm run build && echo done',
        }),
      ),
    )
    expect(container.textContent).toContain('Bash')
    // chevron glyph present (collapsed = ▸ U+25B8)
    expect(container.textContent).toContain(String.fromCodePoint(0x25b8))
    // the expandable detail region is not shown while collapsed
    expect(container.querySelector('[data-tool-detail]')).toBeNull()
  })

  it('expands on click to reveal the toolMeta args preview', () => {
    const meta = '{"command":"npm test","cwd":"/repo"}'
    act(() => root.render(React.createElement(ToolCallRow, { toolName: 'Bash', toolMeta: meta })))
    const btn = container.querySelector('button')
    expect(btn).toBeTruthy()
    act(() => btn!.click())
    const detail = container.querySelector('[data-tool-detail]')
    expect(detail).toBeTruthy()
    expect(detail?.textContent).toContain('npm test')
  })

  it('renders a muted variant for kind="sidechain"', () => {
    act(() =>
      root.render(
        React.createElement(ToolCallRow, {
          toolName: 'Grep',
          toolMeta: 'pattern',
          kind: 'sidechain',
        }),
      ),
    )
    // muted variant marked for downstream styling assertions
    const row = container.querySelector('[data-sidechain="true"]')
    expect(row).toBeTruthy()
  })

  it('non-sidechain row is not flagged as sidechain', () => {
    act(() =>
      root.render(React.createElement(ToolCallRow, { toolName: 'Read', toolMeta: 'x.ts' })),
    )
    expect(container.querySelector('[data-sidechain="true"]')).toBeNull()
  })

  it('handles null toolMeta without crashing (no detail to expand)', () => {
    act(() => root.render(React.createElement(ToolCallRow, { toolName: 'TodoWrite', toolMeta: null })))
    expect(container.textContent).toContain('TodoWrite')
    const btn = container.querySelector('button')
    act(() => btn!.click())
    // With no meta, the detail region renders empty or stays absent — either way no throw.
    expect(container.textContent).toContain('TodoWrite')
  })
})
