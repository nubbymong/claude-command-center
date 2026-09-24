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
  CLAUDE_OFF_LAUNCH_REASON, CODEX_OFF_LAUNCH_REASON,
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
    expect(launchBlockedTag(codexCfg)).toBe('Codex off')
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
})
