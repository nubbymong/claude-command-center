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

  it('Claude session renders no provider badge (quiet launcher)', () => {
    mountWith('claude')
    // Claude is the default provider -- no badge rendered (quiet launcher design)
    expect(container.querySelector('[title^="Claude"]')).toBeNull()
    expect(container.querySelector('[title^="Codex"]')).toBeNull()
  })

  it('Codex session renders the Codex badge', () => {
    mountWith('codex')
    expect(container.querySelector('[title^="Codex"]')).not.toBeNull()
    expect(container.querySelector('[title^="Claude"]')).toBeNull()
  })
})
