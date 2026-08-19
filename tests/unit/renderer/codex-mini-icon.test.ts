// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import SessionRow from '../../../src/renderer/components/sidebar/SessionRow'
import type { Session } from '../../../src/renderer/stores/sessionStore'

const mkSession = (over: Partial<Session> = {}): Session => ({
  id: 's-1',
  label: 'test',
  workingDirectory: '/tmp',
  color: '#89b4fa',
  sessionType: 'local',
  provider: 'claude',
  ...over,
} as Session)

describe('SessionRow provider mini-icon', () => {
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

  const mountWith = (provider: 'claude' | 'codex') => {
    act(() => {
      root.render(
        React.createElement(SessionRow, {
          session: mkSession({ provider }),
          isActive: false,
          needsAttention: false,
          isRenaming: false,
          renameValue: '',
          renameRef: { current: null },
          onRenameChange: () => {},
          onRenameFinish: () => {},
          onRenameCancel: () => {},
          onClick: () => {},
          onContextMenu: () => {},
        }),
      )
    })
  }

  it('Claude session renders the Claude type badge, and nothing Codex', () => {
    // Was "no badge for the default provider" (the quiet-launcher design).
    // Reversed 2026-08-19 on canvas review: marking the common case by ABSENCE
    // is what made the type icons read as inconsistent — every type shows its
    // own icon now, in one place. Still exactly one, and never the wrong one.
    mountWith('claude')
    expect(container.querySelector('[data-testid="type-badge-claude"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="type-badge-codex"]')).toBeNull()
  })

  it('Codex session renders the Codex badge, and nothing Claude', () => {
    mountWith('codex')
    expect(container.querySelector('[data-testid="type-badge-codex"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="type-badge-claude"]')).toBeNull()
  })
})
