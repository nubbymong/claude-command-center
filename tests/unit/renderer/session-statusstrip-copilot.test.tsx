// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AiUsageReport } from '../../../src/shared/github-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Minimal AiUsageReport (shape copied from ai-usage-chip.test.tsx's makeReport)
// so the shared chip has a report to render.
function makeReport(over: Partial<AiUsageReport> = {}): AiUsageReport {
  return {
    fetchedAt: 1_700_000_000_000,
    source: 'ai_credit',
    timePeriod: { year: 2026, month: 6 },
    items: [
      {
        product: 'copilot',
        sku: 'sku',
        model: 'gpt-5',
        unitType: 'request',
        grossQuantity: 8120,
        grossAmount: 10,
        coveredQuantity: 8120,
        coveredAmount: 10,
        billedQuantity: 0,
        billedAmount: 0,
      },
    ],
    totals: { grossAmount: 10, coveredAmount: 10, billedAmount: 0 },
    ...over,
  }
}

// Mutable mock state so individual tests can vary settings / github usage.
const sessionState: any = { sessions: [{ id: 's1', provider: 'claude', contextPercent: 10 }] }
const settingsState: any = {
  settings: {
    statusLine: { font: 'sans', fontSize: 11, showCopilot: true },
    theme: 'dark',
    accountAliases: {},
    accountColourOverrides: {},
    githubAiUsageEnabled: true,
    copilotIncludedCredits: null,
  },
}
const profilesState: any = { profiles: [] }
const githubState: any = { aiUsage: makeReport(), aiUsageStatus: 'ok' }

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel(sessionState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore, DEFAULT_STATUS_LINE: { font: 'sans', fontSize: 11, showCopilot: true } }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel(profilesState),
}))
vi.mock('../../../src/renderer/stores/githubStore', () => ({
  useGitHubStore: (sel: any) => sel(githubState),
}))
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({ useCodexReviewUsage: () => null }))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: () => {} }) }))
vi.mock('../../../src/renderer/hooks/useSwitchAccount', () => ({ useSwitchAccount: () => () => {} }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = { pty: { write: vi.fn() } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Reset to defaults each test.
  sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10 }]
  settingsState.settings = {
    statusLine: { font: 'sans', fontSize: 11, showCopilot: true },
    theme: 'dark',
    accountAliases: {},
    accountColourOverrides: {},
    githubAiUsageEnabled: true,
    copilotIncludedCredits: null,
  }
  profilesState.profiles = []
  githubState.aiUsage = makeReport()
  githubState.aiUsageStatus = 'ok'
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('SessionStatusStrip Copilot meter (Task 2.3)', () => {
  it('renders the chip + separator when showCopilot + meter enabled + report present', () => {
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    const chip = container.querySelector('[data-ai-usage-chip]')
    const sep = container.querySelector('[data-copilot-separator]')
    expect(chip).not.toBeNull()
    expect(sep).not.toBeNull()
    expect(chip!.textContent).toContain('Copilot')
  })

  it('hides chip AND separator when showCopilot is false (meter still enabled)', () => {
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showCopilot: false }
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    expect(container.querySelector('[data-ai-usage-chip]')).toBeNull()
    expect(container.querySelector('[data-copilot-separator]')).toBeNull()
  })

  it('hides chip AND separator (no orphan divider) when the meter is disabled', () => {
    settingsState.settings.githubAiUsageEnabled = false
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    expect(container.querySelector('[data-ai-usage-chip]')).toBeNull()
    expect(container.querySelector('[data-copilot-separator]')).toBeNull()
  })

  it('shows the actionable "Fix auth" chip on scope-missing with no report', () => {
    githubState.aiUsage = null
    githubState.aiUsageStatus = 'scope-missing'
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    const chip = container.querySelector('[data-ai-usage-chip]')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('Fix auth')
  })
})
