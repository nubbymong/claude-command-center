// @vitest-environment jsdom
// Wiring test for the Sentinel report Copy buttons (the modal previously had no
// way to get its text out). Verifies the header "Copy" writes the full report and
// a per-row "Copy" writes that finding, through the real component + store.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import SentinelPanel from '../../../src/renderer/components/sentinel/SentinelPanel'
import { useSentinelStore } from '../../../src/renderer/stores/sentinelStore'
import {
  formatSentinelReportText,
  formatFindingText,
} from '../../../src/renderer/components/sentinel/sentinel-report-text'
import type { SentinelFinding, SentinelStateSnapshot } from '../../../src/shared/sentinel-types'

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => root.render(ui))
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

// A genuinely reaching finding (high severity, hits a CCC surface, not managed-only
// or an unused-model env) so it survives selectBreakingFindings' reachability gate
// and the panel actually renders it with its Copy buttons.
const compat: SentinelFinding = {
  id: 'c1',
  kind: 'compat',
  severity: 'high',
  title: 'Statusline stdin fields renamed',
  evidence: 'model.id removed from the statusline JSON payload',
  affectedFeature: 'statusline',
  surface: 3,
  status: 'open',
  createdAt: 1,
}
const snap: SentinelStateSnapshot = {
  lastSeenCcVersion: '2.1.177',
  analyzing: false,
  lastAnalysisAt: 1700000000000,
  lastAnalysisError: null,
  findings: [compat],
}

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  act(() => useSentinelStore.setState({ snap: null, panelOpen: false } as never))
})

function click(el: Element | null) {
  expect(el).toBeTruthy()
  act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('SentinelPanel copy buttons', () => {
  it('header Copy writes the full report to the clipboard', () => {
    act(() => useSentinelStore.setState({ snap, panelOpen: true } as never))
    const { container, unmount } = render(<SentinelPanel />)
    click(container.querySelector('button[title="Copy the full report to the clipboard"]'))
    expect(writeText).toHaveBeenCalledWith(formatSentinelReportText(snap))
    unmount()
  })

  it('per-row Copy writes just that finding', () => {
    act(() => useSentinelStore.setState({ snap, panelOpen: true } as never))
    const { container, unmount } = render(<SentinelPanel />)
    click(container.querySelector('button[title="Copy this finding"]'))
    expect(writeText).toHaveBeenCalledWith(formatFindingText(compat))
    unmount()
  })

  it('hides the header Copy button when there are no findings', () => {
    const empty: SentinelStateSnapshot = { ...snap, findings: [] }
    act(() => useSentinelStore.setState({ snap: empty, panelOpen: true } as never))
    const { container, unmount } = render(<SentinelPanel />)
    expect(container.querySelector('button[title="Copy the full report to the clipboard"]')).toBeNull()
    unmount()
  })
})
