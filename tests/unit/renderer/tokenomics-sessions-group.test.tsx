// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { SessionsTable } = await import('../../../src/renderer/components/TokenomicsPage')

const make = (over: any) => ({
  sessionId: over.id,
  projectDir: over.proj || 'p',
  model: over.model || 'sonnet',
  totalCostUsd: 1,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  messageCount: 1,
  firstTimestamp: '2026-05-28T00:00:00Z',
  lastTimestamp: '2026-05-28T00:00:00Z',
  ...over,
})

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

describe('SessionsTable lens grouping (U2.6)', () => {
  it('renders group headers when groupBy="project"', async () => {
    const sessions = [
      make({ id: 's1', proj: '/x' }),
      make({ id: 's2', proj: '/y' }),
    ] as any

    await act(async () => {
      root.render(
        createElement(SessionsTable, {
          sessions,
          groupBy: 'project',
          observedEmails: [],
          onRefresh: () => {},
        } as any)
      )
    })

    // Assert two group-header rows are present (one per distinct project key)
    const headers = container.querySelectorAll('[data-testid="group-header"]')
    expect(headers.length).toBe(2)

    // Assert both project keys appear in the content
    const texts = Array.from(headers).map(h => h.textContent || '')
    expect(texts.some(t => t.includes('/x'))).toBe(true)
    expect(texts.some(t => t.includes('/y'))).toBe(true)
  })
})
