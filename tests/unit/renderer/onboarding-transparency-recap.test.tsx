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

  describe('the Codex row', () => {
    const codexValue = () => {
      const c = [...container.querySelectorAll('.gh-card')].find((x) => x.querySelector('.gh-t')?.textContent === 'Codex')
      return c?.querySelector('.gh-d')?.textContent
    }

    it('says On only once the user said yes', () => {
      setSettings({ codexEnabled: true, codexAnswered: true })
      render()
      expect(codexValue()).toBe('On')
    })

    it('points at Settings, Accounts to turn Codex on when the answer was no', () => {
      setSettings({ codexEnabled: false, codexAnswered: true })
      render()
      expect(codexValue()).toBe('Off (Settings, Accounts)')
    })

    it('says Not set up, with where to set it up, while the user has not answered', () => {
      setSettings({})
      render()
      expect(codexValue()).toBe('Not set up (Settings, Accounts)')
    })
  })

  it('keeps the rest of the recap intact', () => {
    render()
    const text = container.textContent ?? ''
    for (const label of ['Theme', 'Account', 'GitHub', 'Status line', 'Codex', 'Built-in Tools']) {
      expect(text).toContain(label)
    }
    // P4.11 (row 54): the Codex row is no longer labelled Beta.
    expect(text).not.toContain('Codex (Beta)')
  })
})

// P3.9 (row 42; left by P3.4): the Sentinel card says what Sentinel watches
// (the assistants in use) and what its analysis runs on and spends.
describe('Transparency, the Sentinel card (P3.9)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(window as any).electronAPI.accountProfiles = { globalEmail: vi.fn(() => Promise.resolve(null)) }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })
  const cardText = (): string => {
    const title = [...container.querySelectorAll('.tc-t')].find((e) => e.textContent === 'Sentinel')
    expect(title, 'the Sentinel card').toBeTruthy()
    return title!.parentElement!.querySelector('.tc-d')!.textContent ?? ''
  }
  const renderWith = (over: Partial<Settings>) => {
    setSettings(over)
    act(() => { root.render(React.createElement(TransparencyStep, { onNext: () => {}, onBack: () => {} })) })
  }

  it('Claude Code alone: as before', () => {
    renderWith({})
    expect(cardText()).toBe('Watches Claude Code updates for changes that could break your setup and proposes fixes. Off by default because it spends Claude tokens when Claude updates. Takes effect after a restart.')
  })

  it('Codex alone: Codex updates, Codex usage, nothing about Claude', () => {
    renderWith({ claudeEnabled: false, codexEnabled: true, codexAnswered: true })
    expect(cardText()).toBe('Watches Codex updates for changes that could break your setup and proposes fixes. Off by default because it spends Codex usage when Codex updates. Takes effect after a restart.')
  })

  it('both on: both are watched; the analysis spends the tokens of the one Ask Conductor runs on', () => {
    renderWith({ claudeEnabled: true, codexEnabled: true, codexAnswered: true })
    expect(cardText()).toContain('Watches Claude Code and Codex updates')
    expect(cardText()).toContain('its analysis spends Claude tokens when either updates.')
    renderWith({ claudeEnabled: true, codexEnabled: true, codexAnswered: true, askConductorProvider: 'codex' } as Partial<Settings>)
    expect(cardText()).toContain('its analysis spends Codex usage when either updates.')
  })
})

// P3.12 (row 31; left by P3.4): the "Index conversation logs" card names what
// is indexed: Claude's transcripts, Codex's, or both, by the assistants in use.
describe('Transparency, the log indexing card (P3.12)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(window as any).electronAPI.accountProfiles = { globalEmail: vi.fn(() => Promise.resolve(null)) }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })
  const cardText = (): string => {
    const title = [...container.querySelectorAll('.tc-t')].find((e) => e.textContent === 'Index conversation logs')
    expect(title, 'the log indexing card').toBeTruthy()
    return title!.parentElement!.querySelector('.tc-d')!.textContent ?? ''
  }
  const renderWith = (over: Partial<Settings>) => {
    setSettings(over)
    act(() => { root.render(React.createElement(TransparencyStep, { onNext: () => {}, onBack: () => {} })) })
  }

  it('Claude Code alone: the Logs page and the Memory page\'s recent sessions, and Tokenomics has an index of its own', () => {
    renderWith({})
    expect(cardText().replace(/\s+/g, ' ')).toBe("Powers the Logs page, and the recent sessions on the Memory page, by indexing Claude's own transcripts (~/.claude/projects). Tokenomics reads them with an index of its own, which this switch does not change. Indexing is local; turning it off stops it at once, and turning it on applies to sessions started after. Your conversations stay in Claude's files either way.")
  })

  // P3.16a (U2): this index does not power Tokenomics: the Tokenomics cost index
  // is a separate one that the switch does not stop (app knowledge, privacy;
  // PRIVACY.md), and the Memory page's recent sessions are the only reader of
  // this one besides the Logs page.
  it('P3.16a (U2): in every mode the card says Tokenomics has its own index, never that this one powers it', () => {
    for (const over of [{}, { claudeEnabled: false, codexEnabled: true, codexAnswered: true }, { claudeEnabled: true, codexEnabled: true, codexAnswered: true }] as Partial<Settings>[]) {
      renderWith(over)
      const t = cardText().replace(/\s+/g, ' ')
      expect(t, JSON.stringify(over)).toContain('Tokenomics reads them with an index of its own, which this switch does not change.')
      // By sentence (a full stop and a space): the dot in ~/.claude/projects
      // does not end one, as `[^.]*` did (P3.16a UI round 1).
      expect(t.split(/\.\s/).filter((s) => /Powers.*Tokenomics/.test(s)), JSON.stringify(over)).toEqual([])
    }
  })

  it('Codex alone: Codex\'s transcripts, in each account\'s sessions folder, nothing about Claude', () => {
    renderWith({ claudeEnabled: false, codexEnabled: true, codexAnswered: true })
    const t = cardText()
    expect(t).toContain("Codex's own transcripts (each Codex account's sessions folder)")
    expect(t).toContain("Your conversations stay in Codex's files either way.")
    expect(t).not.toMatch(/Claude|\.claude/)
  })

  it('both on: both are named', () => {
    renderWith({ claudeEnabled: true, codexEnabled: true, codexAnswered: true })
    const t = cardText()
    expect(t).toContain("Claude's own transcripts (~/.claude/projects) and Codex's (each Codex account's sessions folder)")
    expect(t).toContain('Your conversations stay in their own files either way.')
  })
})
