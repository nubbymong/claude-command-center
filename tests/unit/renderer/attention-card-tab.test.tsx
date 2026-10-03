// @vitest-environment jsdom
/**
 * P3.16a (U4): the attention state of a sidebar card and of a tab.
 *
 * The pulse overlay is the session's identity colour painted under the text, so
 * the text colours drawn over it decide whether the card and the tab stay
 * readable. The contrast numbers are pinned in token-contrast.test.ts and the
 * animation's own values in inject-attention-styles.test.ts; this file pins what
 * the markup gives them to work with: the card carries data-attention (the
 * stylesheet's muted-text rule keys on it) exactly while its overlay is drawn,
 * and the tab's label is the primary text colour exactly while its overlay is
 * drawn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const settingsState: any = { settings: { accountAliases: {}, accountColourOverrides: {} } }
const profilesState: any = { profiles: [] }

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))
vi.mock('../../../src/renderer/components/TerminalView', () => ({ killSessionPty: vi.fn() }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel(profilesState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore }
})

const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')
const { default: TabBar } = await import('../../../src/renderer/components/TabBar')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useSleepStore } = await import('../../../src/renderer/stores/sleepStore')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'API Refactor', workingDirectory: '/x', model: 'opus',
    color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local',
    contextPercent: 47, ...over,
  } as Session
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSleepStore.setState({ silentSince: {}, attentionDismissedAt: {}, graceTick: 0 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the attention card (P3.16a, U4)', () => {
  const baseProps = {
    isActive: false, needsAttention: false, isRenaming: false, renameValue: '',
    renameRef: { current: null }, onRenameChange: () => {}, onRenameFinish: () => {},
    onRenameCancel: () => {}, onClick: () => {}, onContextMenu: () => {},
  }
  const render = (session: Session, props: Record<string, unknown> = {}) =>
    act(() => { root.render(createElement(SessionRow, { session, ...baseProps, ...props } as never)) })
  const card = () => container.querySelector('button.session-card') as HTMLElement
  const overlay = () => card().querySelector('.attention-pulse-bg')

  it('carries data-attention while its overlay is drawn, so the muted-text rule applies', () => {
    render(makeSession({ status: 'working' }), { needsAttention: true })
    expect(overlay()).not.toBeNull()
    expect(card().getAttribute('data-attention')).toBe('true')
  })

  it('a quiet card has neither', () => {
    render(makeSession({ status: 'working' }))
    expect(overlay()).toBeNull()
    expect(card().hasAttribute('data-attention')).toBe(false)
  })

  it('a stopped session that also needs attention shows the error state, with no overlay and no attribute', () => {
    render(makeSession({ status: 'error' }), { needsAttention: true })
    expect(overlay()).toBeNull()
    expect(card().hasAttribute('data-attention')).toBe(false)
  })
})

describe('the attention tab (P3.16a, U4)', () => {
  const tabs = () => [...container.querySelectorAll('[data-testid="session-tab"]')] as HTMLElement[]
  const tab = (label: string) => tabs().find((b) => b.getAttribute('aria-label') === label) as HTMLElement
  const render = (sessions: Session[], active: string) => {
    useSessionStore.setState({ sessions, activeSessionId: active, renamingSessionId: null })
    act(() => { root.render(createElement(TabBar, { activeView: 'sessions', openPageTabs: [], onActivateSession: () => {}, onActivatePage: () => {}, onClosePage: () => {} } as never)) })
  }

  it('an attention tab that is not the active one draws its overlay and its label in the primary text colour', () => {
    render([makeSession({ id: 'a', label: 'Active one' }), makeSession({ id: 'b', label: 'Needs you', needsAttention: true })], 'a')
    const t = tab('Needs you')
    expect(t.querySelector('.attention-pulse-bg')).not.toBeNull()
    expect(t.getAttribute('data-attention')).toBe('true')
    const classes = t.className.split(/\s+/)
    expect(classes).toContain('text-text')
    expect(classes).not.toContain('text-overlay1')
  })

  it('a quiet inactive tab keeps its muted label, and has no overlay or attribute', () => {
    render([makeSession({ id: 'a', label: 'Active one' }), makeSession({ id: 'b', label: 'Quiet' })], 'a')
    const t = tab('Quiet')
    expect(t.querySelector('.attention-pulse-bg')).toBeNull()
    expect(t.hasAttribute('data-attention')).toBe(false)
    expect(t.className.split(/\s+/)).toContain('text-overlay1')
  })

  it('the active tab shows no attention even when its session asks for it', () => {
    render([makeSession({ id: 'a', label: 'Active one', needsAttention: true })], 'a')
    const t = tab('Active one')
    expect(t.querySelector('.attention-pulse-bg')).toBeNull()
    expect(t.hasAttribute('data-attention')).toBe(false)
  })
})
