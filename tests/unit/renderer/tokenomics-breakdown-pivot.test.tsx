// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { TokenomicsSessionRecord } from '../../../src/shared/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { BreakdownPanel } = await import('../../../src/renderer/components/TokenomicsPage')

const make = (over: Partial<TokenomicsSessionRecord>): TokenomicsSessionRecord => ({
  sessionId: over.sessionId || 's',
  projectDir: over.projectDir || 'p',
  model: over.model || 'claude-sonnet',
  totalCostUsd: 1,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  messageCount: 1,
  firstTimestamp: '2026-05-28T00:00:00Z',
  lastTimestamp: '2026-05-28T00:00:00Z',
  ...over,
} as any)

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

describe('BreakdownPanel pivot (U2.3)', () => {
  it('groupBy="project" renders distinct project dirs', () => {
    const sessions = [
      make({ sessionId: 's1', projectDir: '/a' }),
      make({ sessionId: 's2', projectDir: '/b' }),
    ]
    act(() => {
      root.render(createElement(BreakdownPanel, { sessions, groupBy: 'project' } as any))
    })
    expect(container.textContent).toContain('/a')
    expect(container.textContent).toContain('/b')
  })

  it('groupBy="account" renders distinct accountEmails', () => {
    const sessions = [
      make({ sessionId: 's1', accountEmail: 'a@x.com' } as any),
      make({ sessionId: 's2', accountEmail: 'b@x.com' } as any),
    ]
    act(() => {
      root.render(createElement(BreakdownPanel, { sessions, groupBy: 'account' } as any))
    })
    expect(container.textContent).toContain('a@x.com')
    expect(container.textContent).toContain('b@x.com')
  })
})
