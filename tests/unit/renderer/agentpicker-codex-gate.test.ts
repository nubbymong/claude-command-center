// @vitest-environment jsdom
/**
 * 2.1.0-beta.5: the SessionDialog agent picker is REMOVED (0 real configs used
 * it; the --agents plumbing still honours agentIds stored on old configs).
 * These tests encode the two halves of that contract:
 *   1. The picker never renders, for any provider.
 *   2. Stored claudeOptions.agentIds SURVIVE an edit+save — the dialog's
 *      spread-then-set save path must not wipe fields it no longer edits
 *      (the bug that silently ate effortLevel for years).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({
    groups: [],
    addGroup: vi.fn(),
    sections: [],
    addSection: vi.fn(),
  }),
}))

// Mock window.electronAPI
if (typeof window !== 'undefined') {
  (window as any).electronAPI = {
    debug: {
      isEnabled: vi.fn().mockResolvedValue(false),
    },
    dialog: { openFolder: vi.fn().mockResolvedValue(null) },
    credentials: { save: vi.fn(), delete: vi.fn() },
  }
  ;(window as any).electronPlatform = 'win32'
}

import SessionDialog from '../../../src/renderer/components/SessionDialog'

describe('SessionDialog agent picker removal', () => {
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

  it('does NOT render an agent picker for codex configs', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { provider: 'codex', codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    expect((container.textContent ?? '')).not.toContain('Agents')
  })

  it('does NOT render an agent picker for claude configs (removed in beta.5)', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { provider: 'claude', workingDirectory: 'C:\\proj', label: 'x' },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    expect((container.textContent ?? '')).not.toContain('Agents')
  })

  it('stored agentIds survive an edit+save (spread-then-set, no field wipe)', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: {
            provider: 'claude',
            label: 'legacy',
            workingDirectory: 'C:\\proj',
            claudeOptions: { agentIds: ['tpl-1', 'tpl-2'], legacyVersion: { enabled: true, version: '1.0.0' } },
          },
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })
    const form = container.querySelector('form')
    expect(form).not.toBeNull()
    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.agentIds).toEqual(['tpl-1', 'tpl-2'])
    expect(config.claudeOptions?.legacyVersion).toEqual({ enabled: true, version: '1.0.0' })
  })
})
