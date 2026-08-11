// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// SessionRow reads useResolvedTheme + useAccountProfilesStore + useSettingsStore.
// Mock them (the codebase pattern; @testing-library/react is not a dependency).
const settingsState: any = { settings: { accountAliases: {}, accountColourOverrides: {} } }
const profilesState: any = { profiles: [] }

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel(profilesState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore }
})

const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'API Refactor', workingDirectory: '/x', model: 'opus',
    color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local', ...over,
  } as Session
}

const baseProps = {
  isActive: false, needsAttention: false, isRenaming: false, renameValue: '',
  renameRef: { current: null }, onRenameChange: () => {}, onRenameFinish: () => {},
  onRenameCancel: () => {}, onClick: () => {}, onContextMenu: () => {},
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('SessionRow effort indicator', () => {
  it('shows the EffortPill when the session has a LIVE effort level', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ effortLevel: 'xhigh', effortLive: true }), ...baseProps })) })
    const pill = container.querySelector('[data-testid="effort-pill"]') as HTMLElement
    expect(pill).not.toBeNull()
    expect(pill.textContent).toBe('xhigh')
  })

  it('omits the EffortPill when there is no effort level', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession(), ...baseProps })) })
    expect(container.querySelector('[data-testid="effort-pill"]')).toBeNull()
  })

  it('graceful-fail: omits the EffortPill when effortLevel is set but no live tick has arrived', () => {
    // A spawn-time / persisted guess sets effortLevel but NOT effortLive -- the
    // card must stay calm (no pill) until a statusline/hooks tick confirms it.
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ effortLevel: 'xhigh' }), ...baseProps })) })
    expect(container.querySelector('[data-testid="effort-pill"]')).toBeNull()
  })

  it('no longer renders the 7px status dot', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ status: 'working' }), ...baseProps })) })
    // StatusDot rendered an inline 7x7 span; it must be gone.
    expect(container.querySelector('span[style*="width: 7px"]')).toBeNull()
  })
})

describe('SessionRow fast-mode bolt', () => {
  it('shows the FastBolt when session.fastMode is true (live)', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ fastMode: true }), ...baseProps })) })
    expect(container.querySelector('[data-testid="fast-bolt"]')).not.toBeNull()
  })

  it('omits the FastBolt when fastMode is false', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ fastMode: false }), ...baseProps })) })
    expect(container.querySelector('[data-testid="fast-bolt"]')).toBeNull()
  })

  it('omits the FastBolt when fastMode is unset (no live tick yet)', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession(), ...baseProps })) })
    expect(container.querySelector('[data-testid="fast-bolt"]')).toBeNull()
  })
})

describe('SessionRow context meter', () => {
  it('hides the context meter and % for a terminal-only (shell) session, keeping the model · mode meta', () => {
    // The statusline bridge can leak a stale/foreign context % onto a shell
    // session; until proper integration we do not show context for shells.
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ shellOnly: true, model: 'opus', contextPercent: 98 }), ...baseProps })) })
    const line2 = container.querySelector('[data-testid="card-line2"]') as HTMLElement
    expect(line2).not.toBeNull()
    expect(line2.querySelector('.meter-fill')).toBeNull()
    expect(line2.textContent).not.toContain('98%')
    expect(line2.textContent).toContain('opus · shell')
  })

  it('still shows the context meter and % for a normal (non-shell) session', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ contextPercent: 42 }), ...baseProps })) })
    const line2 = container.querySelector('[data-testid="card-line2"]') as HTMLElement
    expect(line2.querySelector('.meter-fill')).not.toBeNull()
    expect(line2.textContent).toContain('42%')
  })
})
