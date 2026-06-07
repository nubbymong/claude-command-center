// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import LogEmptyState, { type LogEmptyReason } from '../../../../src/renderer/components/logs/LogEmptyState'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const render = async (el: React.ReactElement) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(el) })
  return { container, cleanup: () => { act(() => { root.unmount() }); container.remove() } }
}

const cases: { reason: LogEmptyReason; match: RegExp }[] = [
  { reason: 'shell-only', match: /shell/i },
  { reason: 'ssh', match: /remote/i },
  { reason: 'codex', match: /codex/i },
  { reason: 'logging-off', match: /indexing is off/i },
  { reason: 'no-transcript', match: /no conversation detected/i },
  { reason: 'select', match: /select a slot/i },
]

describe('LogEmptyState', () => {
  for (const { reason, match } of cases) {
    it(`renders honest copy for "${reason}"`, async () => {
      const { container, cleanup } = await render(<LogEmptyState reason={reason} />)
      const el = container.querySelector('[data-testid="log-empty-state"]') as HTMLElement
      expect(el).toBeTruthy()
      expect(el.getAttribute('data-reason')).toBe(reason)
      expect(container.textContent || '').toMatch(match)
      cleanup()
    })
  }

  it('shows the watched cwd for no-transcript', async () => {
    const { container, cleanup } = await render(<LogEmptyState reason="no-transcript" watchedCwd="C:/proj/app" />)
    expect(container.textContent).toMatch(/C:\/proj\/app/)
    cleanup()
  })

  it('ssh is an explicit named regression (not silent blank)', async () => {
    const { container, cleanup } = await render(<LogEmptyState reason="ssh" />)
    expect(container.textContent).toMatch(/SSH/)
    cleanup()
  })
})
