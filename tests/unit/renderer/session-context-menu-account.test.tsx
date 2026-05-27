// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn().mockResolvedValue(undefined),
  saveConfigDebounced: vi.fn(),
}))

const { default: SessionContextMenu } = await import('../../../src/renderer/components/sidebar/SessionContextMenu')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      accountAliases: [
        { email: 'me@x.com', alias: 'work' },
        { email: 'other@y.com', alias: 'personal' },
      ],
    },
    isLoaded: true,
  } as any)
  useSessionStore.setState({
    sessions: [{
      id: 's1', label: 'S1', workingDirectory: '/x', model: 'sonnet', color: 'mauve',
      status: 'idle', createdAt: 0, sessionType: 'local',
    } as any],
    activeSessionId: 's1',
    isRestoring: false,
  } as any)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function renderMenu(overrides: Partial<any> = {}) {
  const props = {
    x: 0,
    y: 0,
    session: { id: 's1', label: 'S1' } as any,
    hasGroup: false,
    onRename: () => {},
    onRemoveFromGroup: () => {},
    onClose: () => {},
    onDismiss: () => {},
    onNavigateToAliases: () => {},
    ...overrides,
  }
  act(() => { root.render(createElement(SessionContextMenu, props as any)) })
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)

describe('SessionContextMenu account submenu', () => {
  it('renders one item per alias plus a (none) entry and an Edit aliases entry', () => {
    renderMenu()
    expect(byTestId('account-alias-none')).toBeTruthy()
    expect(byTestId('account-alias-me@x.com')).toBeTruthy()
    expect(byTestId('account-alias-other@y.com')).toBeTruthy()
    expect(byTestId('account-alias-edit')).toBeTruthy()
    expect(container.textContent).toContain('work')
    expect(container.textContent).toContain('personal')
  })

  it('clicking an alias item calls updateSession with the canonical email', () => {
    renderMenu()
    act(() => { (byTestId('account-alias-me@x.com') as HTMLButtonElement).click() })
    const s = useSessionStore.getState().sessions.find((x) => x.id === 's1')!
    expect(s.accountAliasEmail).toBe('me@x.com')
  })

  it('clicking (none) clears the account alias', () => {
    useSessionStore.setState({
      sessions: [{
        id: 's1', label: 'S1', workingDirectory: '/x', model: 'sonnet', color: 'mauve',
        status: 'idle', createdAt: 0, sessionType: 'local', accountAliasEmail: 'me@x.com',
      } as any],
      activeSessionId: 's1',
      isRestoring: false,
    } as any)
    renderMenu({ session: { id: 's1', label: 'S1', accountAliasEmail: 'me@x.com' } })
    act(() => { (byTestId('account-alias-none') as HTMLButtonElement).click() })
    const s = useSessionStore.getState().sessions.find((x) => x.id === 's1')!
    expect(s.accountAliasEmail).toBeUndefined()
  })

  it('clicking Edit aliases fires onNavigateToAliases', () => {
    const onNavigateToAliases = vi.fn()
    renderMenu({ onNavigateToAliases })
    act(() => { (byTestId('account-alias-edit') as HTMLButtonElement).click() })
    expect(onNavigateToAliases).toHaveBeenCalled()
  })
})
