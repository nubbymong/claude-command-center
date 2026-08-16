// @vitest-environment jsdom
/**
 * Onboarding Transparency recap: the two rows that are load-bearing rather
 * than informational.
 *
 * 1. Update channel. `updateChannel` defaults to 'stable', so someone who
 *    deliberately installed a beta build silently received no further betas
 *    (and the beta re-onboarding gate, which reads the same value, never
 *    fired). The row pre-selects the channel matching the running build,
 *    PERSISTS it, and never overrides a choice the user actually made.
 * 2. Session events. The hooks gateway is on by default and opens a loopback
 *    listener; nothing else in the flow mentioned it.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ghState = { profiles: [] as { username: string }[], config: { enabledByDefault: false }, loadConfig: vi.fn() }
vi.mock('../../../src/renderer/stores/githubStore', () => {
  const hook: any = (sel?: (s: typeof ghState) => unknown) => (sel ? sel(ghState) : ghState)
  hook.getState = () => ghState
  return { useGitHubStore: hook }
})

const apState = { profiles: [] as { isPrimary?: boolean; accountEmail?: string }[], hydrate: vi.fn() }
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  const hook: any = (sel?: (s: typeof apState) => unknown) => (sel ? sel(apState) : apState)
  hook.getState = () => apState
  return { useAccountProfilesStore: hook }
})

const { TransparencyStep } = await import('../../../src/renderer/onboarding/TransparencyStep')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

type Settings = typeof DEFAULT_SETTINGS

function setSettings(over: Partial<Settings>): void {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...over } })
}

describe('Transparency recap rows', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as any).electronAPI.accountProfiles = { globalEmail: vi.fn(() => Promise.resolve(null)) }
    setSettings({})
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    delete (globalThis as any).__APP_VERSION__
  })

  const render = () => {
    act(() => {
      root.render(React.createElement(TransparencyStep, { onNext: () => {}, onBack: () => {} }))
    })
  }
  const button = (label: string): HTMLButtonElement => {
    const el = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
    if (!el) throw new Error(`no button labelled "${label}"`)
    return el as HTMLButtonElement
  }

  describe('update channel', () => {
    it('pre-selects AND persists beta on a prerelease build', () => {
      ;(globalThis as any).__APP_VERSION__ = '2.1.0-beta.10'
      render()
      expect(container.textContent).toContain('Updates')
      expect(container.textContent).toContain("You're on a beta build")
      // Persisted, not just painted: the updater reads the stored value.
      expect(useSettingsStore.getState().settings.updateChannel).toBe('beta')
      expect(button('Beta releases').getAttribute('aria-pressed')).toBe('true')
      expect(button('Stable only').getAttribute('aria-pressed')).toBe('false')
    })

    it('leaves a final release on stable and says so', () => {
      ;(globalThis as any).__APP_VERSION__ = '2.1.0'
      render()
      expect(container.textContent).toContain("You're on a stable build")
      expect(useSettingsStore.getState().settings.updateChannel).toBe('stable')
      expect(useSettingsStore.getState().settings.updateChannelChosen).toBeFalsy()
      expect(button('Stable only').getAttribute('aria-pressed')).toBe('true')
    })

    it('never overrides an explicit choice, even on a prerelease build', () => {
      ;(globalThis as any).__APP_VERSION__ = '2.1.0-beta.10'
      setSettings({ updateChannel: 'stable', updateChannelChosen: true })
      render()
      expect(useSettingsStore.getState().settings.updateChannel).toBe('stable')
      expect(button('Stable only').getAttribute('aria-pressed')).toBe('true')
    })

    it('records the click as an explicit choice', () => {
      ;(globalThis as any).__APP_VERSION__ = '2.1.0-beta.10'
      render()
      act(() => { button('Stable only').click() })
      const s = useSettingsStore.getState().settings
      expect(s.updateChannel).toBe('stable')
      expect(s.updateChannelChosen).toBe(true)
      expect(button('Stable only').getAttribute('aria-pressed')).toBe('true')
    })

    it('re-mounting after an explicit stable choice does not flip it back', () => {
      ;(globalThis as any).__APP_VERSION__ = '2.1.0-beta.10'
      render()
      act(() => { button('Stable only').click() })
      act(() => { root.unmount() })
      root = createRoot(container)
      render()
      expect(useSettingsStore.getState().settings.updateChannel).toBe('stable')
    })
  })

  describe('session events', () => {
    it('discloses the loopback listener while it is on', () => {
      render()
      expect(container.textContent).toContain('Session events')
      expect(container.textContent).toContain('127.0.0.1')
      expect(container.textContent).toContain('No telemetry')
    })

    it('reports it off, with where to change it', () => {
      setSettings({ hooksEnabled: false })
      render()
      expect(container.textContent).toContain('Session events')
      expect(container.textContent).toContain('Off (Settings → Hooks)')
    })
  })

  it('keeps the rest of the recap intact', () => {
    render()
    const text = container.textContent ?? ''
    for (const label of ['Theme', 'Account', 'GitHub', 'Status line', 'Codex (Beta)', 'Built-in tools']) {
      expect(text).toContain(label)
    }
  })
})
