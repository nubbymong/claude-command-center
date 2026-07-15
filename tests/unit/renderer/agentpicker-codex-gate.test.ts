// @vitest-environment jsdom
/**
 * P5.6 regression: SessionDialog agent picker is gated to Claude provider only.
 * The picker MUST NOT appear in the DOM when provider='codex'.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let mockUserTemplates: any[] = []

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({
    groups: [],
    addGroup: vi.fn(),
    sections: [],
    addSection: vi.fn(),
  }),
}))

vi.mock('../../../src/renderer/stores/agentLibraryStore', () => ({
  useAgentLibraryStore: (sel: any) => sel({
    templates: mockUserTemplates,
  }),
  BUILTIN_TEMPLATES: [
    {
      id: 'builtin-test',
      name: 'Test Agent',
      description: 'A test agent',
      model: 'inherit',
      tools: [],
      isBuiltIn: true,
    },
  ],
}))

// Mock window.electronAPI
if (typeof window !== 'undefined') {
  (window as any).electronAPI = {
    debug: {
      isEnabled: vi.fn().mockResolvedValue(false),
    },
  }
}

import SessionDialog from '../../../src/renderer/components/SessionDialog'

describe('SessionDialog agent picker provider gate', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockUserTemplates = []
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('does NOT render the agent picker section when provider is codex', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { provider: 'codex', codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    // The "Agents" section label only appears in the Claude branch (line 692 of SessionDialog)
    expect((container.textContent ?? '')).not.toContain('Agents')
  })

  it('DOES render the agent picker section when provider is claude', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { provider: 'claude' },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    // The "Agents" label appears when Claude branch is active and templates exist
    expect((container.textContent ?? '')).toContain('Agents')
  })
})
