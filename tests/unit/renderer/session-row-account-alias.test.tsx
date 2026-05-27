// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({
  useResolvedTheme: () => 'dark',
}))
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn().mockResolvedValue(undefined),
  saveConfigDebounced: vi.fn(),
}))

const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true } as any)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function baseProps(session: any) {
  return {
    session,
    isActive: false,
    needsAttention: false,
    isRenaming: false,
    renameValue: '',
    renameRef: createRef<HTMLInputElement>(),
    onRenameChange: () => {},
    onRenameFinish: () => {},
    onRenameCancel: () => {},
    onClick: () => {},
    onContextMenu: () => {},
    isSelected: false,
    isFocused: false,
  }
}

function makeSession(overrides: any) {
  return {
    id: 's1',
    label: 'myproject',
    workingDirectory: '/x',
    model: 'sonnet',
    color: 'mauve',
    status: 'idle',
    createdAt: 0,
    sessionType: 'local',
    ...overrides,
  }
}

describe('SessionRow account alias display', () => {
  it('renders the alias next to the project name when settings has a matching entry', () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, accountAliases: [{ email: 'me@x.com', alias: 'work' }] },
      isLoaded: true,
    } as any)
    const session = makeSession({ accountAliasEmail: 'me@x.com' })
    act(() => { root.render(createElement(SessionRow, baseProps(session) as any)) })
    const aliasSpan = container.querySelector('[data-testid="session-row-account-alias"]')
    expect(aliasSpan).toBeTruthy()
    expect(aliasSpan!.textContent).toContain('work')
  })

  it('omits the alias span when the session has no accountAliasEmail', () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, accountAliases: [{ email: 'me@x.com', alias: 'work' }] },
      isLoaded: true,
    } as any)
    const session = makeSession({})
    act(() => { root.render(createElement(SessionRow, baseProps(session) as any)) })
    expect(container.querySelector('[data-testid="session-row-account-alias"]')).toBeNull()
  })

  it('omits the alias span when the email is set but no alias entry exists', () => {
    // empty aliases list
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, accountAliases: [] }, isLoaded: true } as any)
    const session = makeSession({ accountAliasEmail: 'orphan@x.com' })
    act(() => { root.render(createElement(SessionRow, baseProps(session) as any)) })
    expect(container.querySelector('[data-testid="session-row-account-alias"]')).toBeNull()
  })
})
