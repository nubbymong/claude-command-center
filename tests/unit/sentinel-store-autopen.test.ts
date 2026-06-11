/**
 * sentinel-store-autopen.test.ts
 *
 * Tests the applyUpdate pure transition in useSentinelStore (spec §6).
 * We call applyUpdate directly — no IPC needed.
 * useSettingsStore state is seeded via its hydrate() to avoid module mocking.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { SentinelStateSnapshot, SentinelFinding } from '../../src/shared/sentinel-types'

// Keep a stable reference to the store across tests
import { useSentinelStore } from '../../src/renderer/stores/sentinelStore'
import { useSettingsStore } from '../../src/renderer/stores/settingsStore'

function makeSnap(overrides: Partial<SentinelStateSnapshot> = {}): SentinelStateSnapshot {
  return {
    lastSeenCcVersion: null,
    analyzing: false,
    lastAnalysisAt: null,
    lastAnalysisError: null,
    findings: [],
    ...overrides,
  }
}

function openFinding(id = 'f1'): SentinelFinding {
  return {
    id,
    kind: 'info',
    severity: 'info',
    title: 'Test finding',
    evidence: 'test',
    status: 'open',
    createdAt: Date.now(),
  }
}

beforeEach(() => {
  // Reset store to initial state
  useSentinelStore.setState({
    snap: null,
    panelOpen: false,
    autoOpenedForAnalysisAt: null,
  })
  // Ensure sentinelAutoOpen is true (default)
  useSettingsStore.getState().hydrate({
    ...useSettingsStore.getState().settings,
    sentinelAutoOpen: true,
  })
})

describe('useSentinelStore.applyUpdate (spec §6)', () => {
  it('analyzing → done with open findings: opens panel and stamps timestamp', () => {
    const AT = 1_000_000
    // Seed: analyzing = true
    useSentinelStore.setState({ snap: makeSnap({ analyzing: true }) })

    // Transition: analysis complete, 1 open finding
    const next = makeSnap({ analyzing: false, lastAnalysisAt: AT, findings: [openFinding()] })
    useSentinelStore.getState().applyUpdate(next)

    const state = useSentinelStore.getState()
    expect(state.panelOpen).toBe(true)
    expect(state.autoOpenedForAnalysisAt).toBe(AT)
    expect(state.snap).toBe(next)
  })

  it('same lastAnalysisAt again: panel not re-opened', () => {
    const AT = 1_000_000
    // Already auto-opened for this AT
    useSentinelStore.setState({
      snap: makeSnap({ analyzing: true }),
      panelOpen: false,
      autoOpenedForAnalysisAt: AT,
    })

    const next = makeSnap({ analyzing: false, lastAnalysisAt: AT, findings: [openFinding()] })
    useSentinelStore.getState().applyUpdate(next)

    expect(useSentinelStore.getState().panelOpen).toBe(false)
  })

  it('sentinelAutoOpen false: panel never opens', () => {
    useSettingsStore.getState().hydrate({
      ...useSettingsStore.getState().settings,
      sentinelAutoOpen: false,
    })
    useSentinelStore.setState({ snap: makeSnap({ analyzing: true }) })

    const next = makeSnap({ analyzing: false, lastAnalysisAt: 999, findings: [openFinding()] })
    useSentinelStore.getState().applyUpdate(next)

    expect(useSentinelStore.getState().panelOpen).toBe(false)
  })

  it('analysis done but NO open findings: panel not opened', () => {
    useSentinelStore.setState({ snap: makeSnap({ analyzing: true }) })

    const dismissedFinding: SentinelFinding = { ...openFinding(), status: 'dismissed' }
    const next = makeSnap({ analyzing: false, lastAnalysisAt: 500, findings: [dismissedFinding] })
    useSentinelStore.getState().applyUpdate(next)

    expect(useSentinelStore.getState().panelOpen).toBe(false)
  })

  it('was not analyzing (push-only update): panel not opened', () => {
    useSentinelStore.setState({ snap: makeSnap({ analyzing: false }) })

    const next = makeSnap({ analyzing: false, lastAnalysisAt: 700, findings: [openFinding()] })
    useSentinelStore.getState().applyUpdate(next)

    expect(useSentinelStore.getState().panelOpen).toBe(false)
  })

  it('setPanelOpen works independently of autoOpen', () => {
    useSentinelStore.getState().setPanelOpen(true)
    expect(useSentinelStore.getState().panelOpen).toBe(true)
    useSentinelStore.getState().setPanelOpen(false)
    expect(useSentinelStore.getState().panelOpen).toBe(false)
  })
})
