// @vitest-environment jsdom
/**
 * #404 MAJOR-2, third entry point (found re-verifying the fix).
 *
 * `registry-overlay.json` is hand-editable and only validated on APPLY, so an
 * entry with no `label` reaches the renderer intact. buildModelPickerRows admits
 * it (`label: m.label || m.id`), so it becomes a real pinned picker row — and
 * opening the footer model picker runs isModelActive() for EVERY row. With the
 * ordinary statusline display-name reading ("Opus 4.6", which can only
 * pattern-match) that fell through to `normalizeModelLabel(opt.label)` and threw
 * `TypeError: Cannot read properties of undefined (reading 'replace')`, taking
 * the whole SessionStatusStrip render down.
 *
 * This drives the REAL component through the REAL click, which is the only way
 * to pin that the crash is gone at the surface the user touches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { mergeRegistry, type ModelRegistry, type OverlayModelEntry } from '../../../src/shared/model-registry'
import baselineJson from '../../../resources/model-registry.json'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const baseline = baselineJson as unknown as ModelRegistry

/** The repro entry: a pinned picker row whose entry has NO label. */
const LABELLESS = { id: 'claude-opus-9-9', family: 'opus', patterns: ['opus-9'] } as unknown as OverlayModelEntry

const sessionState: any = {
  sessions: [{ id: 's1', provider: 'claude', contextPercent: 10, modelName: 'Opus 4.6' }],
  updateSession: vi.fn(),
}
const settingsState: any = {
  settings: {
    statusLine: { font: 'sans', fontSize: 11 },
    statusLineEnabled: true,
    theme: 'dark',
    accountAliases: {},
    accountColourOverrides: {},
    githubAiUsageEnabled: false,
    codexEnabled: false,
  },
}
const registryState: any = { registry: baseline }

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel(sessionState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore, DEFAULT_STATUS_LINE: { font: 'sans', fontSize: 11 } }
})
vi.mock('../../../src/renderer/stores/registryStore', () => ({
  useRegistryStore: (sel: any) => sel(registryState),
}))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel({ profiles: [] }),
}))
vi.mock('../../../src/renderer/stores/githubStore', () => ({
  useGitHubStore: (sel: any) => sel({ aiUsage: null, aiUsageStatus: 'ok' }),
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
  sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10, modelName: 'Opus 4.6' }]
  registryState.registry = mergeRegistry(baseline, { models: [LABELLESS] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function modelButton(): HTMLButtonElement {
  const btn = container.querySelector('button[title="Model"]') as HTMLButtonElement | null
  expect(btn, 'the Model pill should be rendered').not.toBeNull()
  return btn!
}

describe('SessionStatusStrip with a label-less overlay model (#404 MAJOR-2, 3rd site)', () => {
  it('(b) opening the model picker does not crash the strip', () => {
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    // The strip rendered, and the model pill shows the statusline reading.
    expect(modelButton().textContent).toContain('Opus 4.6')

    // THE REPRO: this click runs isModelActive() for every picker row.
    expect(() => {
      act(() => { modelButton().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    }).not.toThrow()

    // Still mounted, and the popover actually opened with the offending row in it.
    expect(container.querySelector('button[title="Model"]')).not.toBeNull()
    expect(container.textContent).toContain('claude-opus-9-9')
  })

  it('the label-less row is offered but not marked active', () => {
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    act(() => { modelButton().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // The running model is Opus 4.6 — that row is the active one, not the
    // unnameable overlay entry.
    expect(container.textContent).toContain('Opus 4.6')
    expect(container.textContent).toContain('claude-opus-9-9')
  })

  it('the model pill is not blanked by a label-less entry the session is RUNNING', () => {
    // shortModelName() used to return undefined here, leaving an empty pill.
    sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10, modelName: 'claude-opus-9-9' }]
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    expect(modelButton().textContent).toContain('claude-opus-9-9')
    expect(modelButton().textContent).not.toContain('undefined')
  })

  it('still works with a clean registry (no over-fix)', () => {
    registryState.registry = baseline
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    act(() => { modelButton().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('Opus 4.6')
  })
})
