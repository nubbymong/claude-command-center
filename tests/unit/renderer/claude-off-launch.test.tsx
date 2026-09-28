// @vitest-environment jsdom
/**
 * WP2 commit 6e review fix: with Claude Code switched off (a Codex-only
 * install) the renderer launches no Claude session from a config.
 *
 * Verifies:
 *   - the one launch rule (isConfigLaunchBlocked) blocks a Claude config,
 *     named or implied, while Claude Code is off, and never a terminal-only
 *     config (it runs no Claude); a Codex config still follows Codex's own
 *     switch and nothing else;
 *   - the reason names the right provider, word for word, and so does the
 *     short tag a blocked row wears;
 *   - the launch action itself refuses (buildLaunchSession, useLaunchConfig);
 *   - the launch surfaces show it: a config row, the empty-state cards and
 *     Quick Start (a terminal-only pin still starts);
 *   - the Feature Guide's Ask card is disabled and says why;
 *   - the New session dialog: the Claude choice is disabled with the reason,
 *     and a new config starts on the provider that is on.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ groups: [], addGroup: vi.fn(), sections: [], addSection: vi.fn() }),
}))
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))

;(window as any).electronAPI = {
  debug: { isEnabled: vi.fn().mockResolvedValue(false) },
  dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  credentials: { save: vi.fn(), delete: vi.fn() },
}
;(window as any).electronPlatform = 'win32'

const {
  isConfigLaunchBlocked, launchBlockedReason, launchBlockedTag, buildLaunchSession, useLaunchConfig,
  CLAUDE_OFF_LAUNCH_REASON, CODEX_OFF_LAUNCH_REASON, CODEX_NOT_SET_UP_LAUNCH_REASON, launchBlockedTabText,
} = await import('../../../src/renderer/hooks/useLaunchConfig')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { default: StageEmptyState } = await import('../../../src/renderer/components/StageEmptyState')
const { default: ConfigRow } = await import('../../../src/renderer/components/sidebar/ConfigRow')
const { default: SessionDialog } = await import('../../../src/renderer/components/SessionDialog')
const { default: QuickStartPanel } = await import('../../../src/renderer/components/sidebar/QuickStartPanel')
const { default: FeatureGuidePage } = await import('../../../src/renderer/components/FeatureGuidePage')
const { snapshot } = await import('./accounts-snapshot-harness')

const CLAUDE_COPY = 'Claude Code is off. Turn it on in Settings, Accounts to launch this config.'

const cfg = (over: Record<string, unknown> = {}): any => ({
  id: 'c1', label: 'App Dev', workingDirectory: 'C:\\proj', color: '', sessionType: 'local', provider: 'claude', pinned: true, ...over,
})
const shell = cfg({ id: 'c2', label: 'Shell', shellOnly: true })
const codexCfg = cfg({ id: 'c3', label: 'Codex job', provider: 'codex' })

let container: HTMLDivElement
let root: Root

function setProviders(over: { claudeEnabled?: boolean; codexEnabled?: boolean }) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...over }, isLoaded: true })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setProviders({})
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the launch rule', () => {
  it('blocks a Claude config while Claude Code is off, named or implied', () => {
    const off = { claudeEnabled: false, codexEnabled: true }
    expect(isConfigLaunchBlocked(cfg(), off)).toBe(true)
    expect(isConfigLaunchBlocked(cfg({ provider: undefined }), off)).toBe(true)
    // On, or never chosen (absent means on): it launches.
    expect(isConfigLaunchBlocked(cfg(), { claudeEnabled: true })).toBe(false)
    expect(isConfigLaunchBlocked(cfg(), {})).toBe(false)
  })

  it('never blocks a terminal-only config: it runs no Claude', () => {
    expect(isConfigLaunchBlocked(shell, { claudeEnabled: false, codexEnabled: true })).toBe(false)
  })

  it('a Codex config follows its own switch, and Claude Code being off does not touch it', () => {
    expect(isConfigLaunchBlocked(codexCfg, { claudeEnabled: false, codexEnabled: true })).toBe(false)
    expect(isConfigLaunchBlocked(codexCfg, { codexEnabled: false })).toBe(true)
    expect(isConfigLaunchBlocked(cfg(), { codexEnabled: false })).toBe(false)
  })

  it('reads the live settings when none are passed', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    expect(isConfigLaunchBlocked(cfg())).toBe(true)
    setProviders({})
    expect(isConfigLaunchBlocked(cfg())).toBe(false)
  })
})

describe('the reason names the provider', () => {
  it('Claude and Codex each get their own copy; a config that can launch gets none', () => {
    expect(CLAUDE_OFF_LAUNCH_REASON).toBe(CLAUDE_COPY)
    expect(launchBlockedReason(cfg(), { claudeEnabled: false })).toBe(CLAUDE_COPY)
    expect(launchBlockedReason(codexCfg, { codexEnabled: false })).toBe(CODEX_OFF_LAUNCH_REASON)
    expect(launchBlockedReason(shell, { claudeEnabled: false })).toBeUndefined()
    expect(launchBlockedReason(cfg(), {})).toBeUndefined()
    expect(launchBlockedTag(cfg())).toBe('Claude Code off')
    expect(launchBlockedTag(codexCfg, { codexEnabled: false })).toBe('Codex off')
  })
})

describe('a Codex the user has not said they use (owner decision 2026-09-26): not set up, blocked the way off is', () => {
  const NOT_SET_UP = 'Codex is not set up yet. Set it up in Settings, Accounts to launch this config.'

  it('the rule, the reason and the tag, each in its own words; an answered yes launches', () => {
    expect(isConfigLaunchBlocked(codexCfg, {})).toBe(true)
    expect(isConfigLaunchBlocked(codexCfg, { codexEnabled: true })).toBe(false)
    expect(CODEX_NOT_SET_UP_LAUNCH_REASON).toBe(NOT_SET_UP)
    expect(launchBlockedReason(codexCfg, {})).toBe(NOT_SET_UP)
    expect(launchBlockedReason(codexCfg, { codexEnabled: false })).toBe(CODEX_OFF_LAUNCH_REASON)
    expect(launchBlockedTag(codexCfg, {})).toBe('Codex not set up')
    // Claude Code is unaffected: its absent value is on.
    expect(launchBlockedReason(cfg(), {})).toBeUndefined()
  })

  it('the launch action builds nothing for it, reading the live settings', () => {
    setProviders({})
    expect(buildLaunchSession(codexCfg)).toBeNull()
    setProviders({ codexEnabled: true })
    expect(buildLaunchSession(codexCfg)).not.toBeNull()
  })

  it('the surfaces that tag an off config tag it "Codex not set up", and none of them launches it', () => {
    setProviders({})
    const onLaunch = vi.fn()
    act(() => { root.render(<ConfigRow config={codexCfg} onLaunch={onLaunch} onEdit={() => {}} onDelete={() => {}} onContextMenu={() => {}} />) })
    const tag = container.querySelector('[data-testid="config-row-provider-off"]') as HTMLElement
    expect(tag.textContent).toBe('Codex not set up')
    expect(tag.title).toBe(NOT_SET_UP)
    const play = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('title') === NOT_SET_UP) as HTMLButtonElement
    expect(play.disabled).toBe(true)
    act(() => { root.render(<StageEmptyState configs={[codexCfg]} onLaunch={onLaunch} onShowAllConfigs={() => {}} onCreateConfig={() => {}} />) })
    const card = Array.from(container.querySelectorAll('button')).find((b) => b.textContent!.includes('Codex job')) as HTMLButtonElement
    expect(card.disabled).toBe(true)
    expect(card.title).toBe(NOT_SET_UP)
    expect(card.textContent).toContain('Codex not set up')
    act(() => { card.click() })
    // Quick Start has no tag for an off config either: disabled, with the reason.
    act(() => { root.render(<QuickStartPanel configs={[codexCfg]} onLaunch={onLaunch} onContextMenu={() => {}} running={new Map()} />) })
    const start = container.querySelector('[data-testid="quick-start-start"]') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    expect(start.title).toBe(NOT_SET_UP)
    act(() => { start.click() })
    expect(onLaunch).not.toHaveBeenCalled()
  })
})

describe('what a tab of a blocked config reads when it opens (the resume prompt titles its tag with it)', () => {
  it('the tab\'s own Not started line, in main\'s words, per provider and state; nothing when it can launch', () => {
    expect(launchBlockedTabText({ provider: 'codex' }, { codexEnabled: false })).toBe('Not started. Codex is off. Turn it on in Settings, Accounts, then Restart this tab.')
    expect(launchBlockedTabText({ provider: 'codex' }, {})).toBe('Not started. Codex is not set up yet. Set it up in Settings, Accounts, then Restart this tab.')
    expect(launchBlockedTabText({ provider: 'claude' }, { claudeEnabled: false, codexEnabled: true })).toBe('Not started. Claude Code is off. Turn it on in Settings, Accounts, then Restart this tab.')
    // A saved session with no provider is Claude.
    expect(launchBlockedTabText({}, { claudeEnabled: false, codexEnabled: true })).toBe('Not started. Claude Code is off. Turn it on in Settings, Accounts, then Restart this tab.')
    // A terminal-only session runs no Claude; a provider that is on launches.
    expect(launchBlockedTabText({ provider: 'claude', shellOnly: true }, { claudeEnabled: false, codexEnabled: true })).toBeUndefined()
    expect(launchBlockedTabText({ provider: 'codex' }, { codexEnabled: true })).toBeUndefined()
    expect(launchBlockedTabText({ provider: 'claude' }, {})).toBeUndefined()
  })
})

describe('the launch action refuses', () => {
  it('buildLaunchSession: no session for a Claude config while Claude Code is off; a terminal-only one still builds', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    expect(buildLaunchSession(cfg())).toBeNull()
    expect(buildLaunchSession(shell)).not.toBeNull()
    setProviders({})
    expect(buildLaunchSession(cfg())).not.toBeNull()
  })

  it('useLaunchConfig: returns nothing and adds no session', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    let launch: (c: any) => string = () => 'unset'
    function Probe() { launch = useLaunchConfig(); return null }
    act(() => { root.render(<Probe />) })
    let id = 'unset'
    act(() => { id = launch(cfg()) })
    expect(id).toBe('')
    expect(useSessionStore.getState().sessions).toEqual([])
    act(() => { id = launch(shell) })
    expect(id).not.toBe('')
    expect(useSessionStore.getState().sessions).toHaveLength(1)
  })
})

describe('the launch surfaces show it', () => {
  it('the empty-state card: disabled, titled with the Claude reason, tagged', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    const onLaunch = vi.fn()
    act(() => { root.render(<StageEmptyState configs={[cfg(), shell]} onLaunch={onLaunch} onShowAllConfigs={() => {}} onCreateConfig={() => {}} />) })
    const card = Array.from(container.querySelectorAll('button')).find((b) => b.textContent!.includes('App Dev')) as HTMLButtonElement
    expect(card.disabled).toBe(true)
    expect(card.title).toBe(CLAUDE_COPY)
    expect(card.textContent).toContain('Claude Code off')
    act(() => { card.click() })
    expect(onLaunch).not.toHaveBeenCalled()
    // The terminal-only card still launches.
    const shellCard = Array.from(container.querySelectorAll('button')).find((b) => b.textContent!.includes('Shell')) as HTMLButtonElement
    expect(shellCard.disabled).toBe(false)
    act(() => { shellCard.click() })
    expect(onLaunch).toHaveBeenCalledTimes(1)
  })

  it('a config row: the play button is inert with the Claude reason, and the row is tagged', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    const onLaunch = vi.fn()
    act(() => { root.render(<ConfigRow config={cfg()} onLaunch={onLaunch} onEdit={() => {}} onDelete={() => {}} onContextMenu={() => {}} />) })
    const play = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('title') === CLAUDE_COPY) as HTMLButtonElement
    expect(play).toBeTruthy()
    expect(play.disabled).toBe(true)
    const tag = container.querySelector('[data-testid="config-row-provider-off"]') as HTMLElement
    expect(tag.textContent).toBe('Claude Code off')
    expect(tag.title).toBe(CLAUDE_COPY)
  })

  it('flipping the switch back on re-enables the row live', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    act(() => { root.render(<ConfigRow config={cfg()} onLaunch={() => {}} onEdit={() => {}} onDelete={() => {}} onContextMenu={() => {}} />) })
    expect(container.querySelector('[data-testid="config-row-provider-off"]')).not.toBeNull()
    act(() => { setProviders({ claudeEnabled: true, codexEnabled: true }) })
    expect(container.querySelector('[data-testid="config-row-provider-off"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.getAttribute('title') === 'Launch')).toBe(true)
  })

  it('Quick Start: a Claude pin cannot start and says why; a terminal-only pin still starts', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    const onLaunch = vi.fn()
    act(() => { root.render(<QuickStartPanel configs={[cfg(), shell]} onLaunch={onLaunch} onContextMenu={() => {}} running={new Map()} />) })
    const [claudePin, shellPin] = Array.from(container.querySelectorAll('[data-testid="quick-start-item"]'))
    const start = claudePin.querySelector('[data-testid="quick-start-start"]') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    expect(start.title).toBe(CLAUDE_COPY)
    expect(start.getAttribute('aria-label')).toBe(CLAUDE_COPY)
    act(() => { start.click() })
    expect(onLaunch).not.toHaveBeenCalled()
    const shellStart = shellPin.querySelector('[data-testid="quick-start-start"]') as HTMLButtonElement
    expect(shellStart.disabled).toBe(false)
    act(() => { shellStart.click() })
    expect(onLaunch).toHaveBeenCalledTimes(1)
  })
})

describe('the Feature Guide Ask card', () => {
  const ASK_OFF = 'Ask Conductor runs on Claude Code, which is off. Turn it on in Settings, Accounts.'
  const ask = () => container.querySelector('[data-ux-id="ask-card-button"]') as HTMLButtonElement

  it('with Claude Code off: Ask is disabled and the card says why', async () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    await act(async () => { root.render(<FeatureGuidePage onNavigateToSessions={() => {}} onStartTour={() => {}} />) })
    expect(ask().disabled).toBe(true)
    expect(ask().title).toBe(ASK_OFF)
    expect(container.querySelector('[data-ux-id="ask-card-note"]')!.textContent).toBe(ASK_OFF)
  })

  it('with Claude Code on: Ask is live and the card explains what it opens', async () => {
    setProviders({})
    await act(async () => { root.render(<FeatureGuidePage onNavigateToSessions={() => {}} onStartTour={() => {}} />) })
    expect(ask().disabled).toBe(false)
    expect(container.querySelector('[data-ux-id="ask-card-note"]')!.textContent).toContain('Opens the Ask Conductor session')
  })
})

describe('the New session dialog', () => {
  function providerRadio(title: string): HTMLInputElement {
    const g = container.querySelector('[role="radiogroup"][aria-label="Provider"]')!
    const lab = Array.from(g.querySelectorAll('label')).find((l) => l.querySelector('span')?.textContent === title)!
    return lab.querySelector('input[type="radio"]') as HTMLInputElement
  }
  const render = (props: Record<string, unknown> = {}) =>
    act(() => { root.render(React.createElement(SessionDialog, { onConfirm: vi.fn(), onCancel: vi.fn(), ...props } as any)) })

  it('with Claude Code off: the Claude choice is disabled with the reason, and a new config starts on Codex', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    render()
    expect(providerRadio('Claude Code').disabled).toBe(true)
    expect(container.querySelector('[data-testid="claude-off-note"]')!.textContent).toBe(CLAUDE_COPY)
    expect(providerRadio('Codex').checked).toBe(true)
    expect(providerRadio('Codex').disabled).toBe(false)
    // Terminal only runs no Claude and stays available.
    expect(providerRadio('Terminal only').disabled).toBe(false)
  })

  it('with both on: nothing is disabled and a new config starts with no choice made, as before', () => {
    setProviders({ claudeEnabled: true, codexEnabled: true })
    render()
    expect(providerRadio('Claude Code').disabled).toBe(false)
    expect(container.querySelector('[data-testid="claude-off-note"]')).toBeNull()
    for (const t of ['Claude Code', 'Codex', 'Terminal only']) expect(providerRadio(t).checked, t).toBe(false)
  })

  it('an edit keeps the provider it has, even one that is off', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    render({ initial: cfg() })
    expect(providerRadio('Claude Code').checked).toBe(true)
    expect(providerRadio('Claude Code').disabled).toBe(true)
  })

  // P3.4 follow-up (row 14): SSH Persistent keeps a remote session alive by
  // wrapping the remote claude command in tmux, which a terminal-only
  // session never runs while Claude Code is off (every Launch Claude is
  // refused). So with Claude Code off the card is disabled for Terminal only,
  // as it is for Codex, with the reason in the same place.
  function connectionRadio(title: string): HTMLInputElement {
    const g = container.querySelector('[role="radiogroup"][aria-label="Connection"]')!
    const lab = Array.from(g.querySelectorAll('label')).find((l) => l.querySelector('span')?.textContent === title)!
    return lab.querySelector('input[type="radio"]') as HTMLInputElement
  }
  const PERSISTENT_COPY = 'SSH Persistent keeps a remote Claude Code session running, and Claude Code is off.'
  const persistentNote = () => container.querySelector('[data-testid="claude-off-persistent-note"]')

  it('with Claude Code off, Terminal only: SSH Persistent is disabled with the reason; Local and SSH stay', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    render()
    // Codex (the start) keeps its own treatment and note, and not this one.
    expect(connectionRadio('SSH Persistent').disabled).toBe(true)
    expect(persistentNote()).toBeNull()
    act(() => { providerRadio('Terminal only').click() })
    expect(providerRadio('Terminal only').checked).toBe(true)
    expect(connectionRadio('SSH Persistent').disabled).toBe(true)
    expect(connectionRadio('Local').disabled).toBe(false)
    expect(connectionRadio('SSH').disabled).toBe(false)
    expect(persistentNote()!.textContent).toBe(PERSISTENT_COPY)
    expect(container.querySelector('[data-testid="codex-local-note"]')).toBeNull()
  })

  it('with Claude Code on (alone or beside Codex), Terminal only offers SSH Persistent as before, with no note', () => {
    for (const on of [{ claudeEnabled: true, codexEnabled: true }, { claudeEnabled: true, codexEnabled: false }]) {
      act(() => { root.unmount() })
      root = createRoot(container)
      setProviders(on)
      render()
      act(() => { providerRadio('Terminal only').click() })
      for (const t of ['Local', 'SSH', 'SSH Persistent']) expect(connectionRadio(t).disabled, `${t} ${JSON.stringify(on)}`).toBe(false)
      expect(persistentNote()).toBeNull()
    }
  })

  it('an edit of a terminal-only SSH Persistent config with Claude Code off keeps its choice, says why it is off, and can move to plain SSH', () => {
    setProviders({ claudeEnabled: false, codexEnabled: true })
    render({ initial: cfg({ shellOnly: true, sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } }) })
    expect(connectionRadio('SSH Persistent').checked).toBe(true)
    expect(connectionRadio('SSH Persistent').disabled).toBe(true)
    expect(persistentNote()!.textContent).toBe(PERSISTENT_COPY)
    act(() => { connectionRadio('SSH').click() })
    expect(connectionRadio('SSH').checked).toBe(true)
  })
})
