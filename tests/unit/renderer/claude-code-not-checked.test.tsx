// @vitest-environment jsdom
/**
 * WP2: while Claude Code is off, main does not run `claude auth status`; the
 * account status answers `cli.notChecked` with the reason. That answer is
 * not a sign-in result, and nothing may read it as "signed out":
 *
 *  - the store keeps the reason, caches no `cliAuthed` and stamps no
 *    `fetchedAt`, so the next refresh asks again (a normal answer is still
 *    cached for its 30 s);
 *  - the session header's Claude Code pill says "off" (or "not checked"),
 *    never "signed out", and switching Claude Code back on re-fetches;
 *  - the sidebar session menu offers no "Sign in to Claude Code" then, and
 *    says why instead.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(), retryFailedConfigSaves: vi.fn() }))

const OFF = 'Claude Code is off. Turn it on in Settings, Accounts.'
const UNKNOWN = 'This app could not read whether Claude Code is on. Check Settings, Accounts.'
const answer = vi.hoisted(() => ({ cli: {} as Record<string, unknown> }))
const status = vi.fn(async (_profileId: string) => ({ ok: true, cli: answer.cli, web: { status: 'active' } }))
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  accountWeb: { status, webStatus: vi.fn(async () => ({ ok: true, web: { status: 'active' } })) },
}

const { default: SessionHeader } = await import('../../../src/renderer/components/SessionHeader')
const { default: SessionContextMenu } = await import('../../../src/renderer/components/sidebar/SessionContextMenu')
const { useAccountAuthStore, _resetAccountAuthForTest, claudeCodeNotChecked } = await import('../../../src/renderer/stores/accountAuthStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { default: SIDEBAR_SOURCE } = await import('../../../src/renderer/components/Sidebar.tsx?raw')

const PROFILE = 'profile-work'
let container: HTMLDivElement
let root: Root
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const pill = () => container.querySelector('[data-testid="session-pill-claudecode"]') as HTMLElement
const claude = (claudeEnabled: boolean | undefined) => act(() => { useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled } }) })
const session = { id: 's1', label: 'web', workingDirectory: 'C:/w', model: '', color: '#f00', status: 'idle', createdAt: 0, sessionType: 'local', provider: 'claude', profileId: PROFILE } as any

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  _resetAccountAuthForTest()
  status.mockClear()
  answer.cli = { authenticated: false, notChecked: OFF }
  useAccountProfilesStore.setState({ profiles: [{ id: PROFILE, name: 'Work', accountEmail: 'me@work.example', isPrimary: true } as any] })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})

describe('the account status store', () => {
  it('keeps the reason, caches no sign-in result, and asks again next time', async () => {
    await useAccountAuthStore.getState().refresh(PROFILE)
    const s = useAccountAuthStore.getState().byProfile[PROFILE]
    expect(s).toMatchObject({ cliNotChecked: OFF, web: 'active', loading: false })
    expect(s.cliAuthed).toBeUndefined()
    expect(s.fetchedAt).toBeUndefined()
    await useAccountAuthStore.getState().refresh(PROFILE)
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('a real answer clears the reason and is cached for its window (the control)', async () => {
    await useAccountAuthStore.getState().refresh(PROFILE)
    answer.cli = { authenticated: true }
    await useAccountAuthStore.getState().refresh(PROFILE)
    const s = useAccountAuthStore.getState().byProfile[PROFILE]
    expect(s.cliNotChecked).toBeUndefined()
    expect(s.cliAuthed).toBe(true)
    await useAccountAuthStore.getState().refresh(PROFILE)
    expect(status).toHaveBeenCalledTimes(2)
  })
})

describe("the session header's Claude Code pill", () => {
  it('Claude Code off: says "off", never "signed out"; the claude.ai pill still reads its own answer', async () => {
    claude(false)
    act(() => { root.render(<SessionHeader session={session} />) })
    await flush()
    expect(pill().textContent).toContain('off')
    expect(pill().textContent).not.toContain('signed out')
    expect(pill().getAttribute('title')).toContain(OFF)
    const ai = container.querySelector('[data-testid="session-pill-claudeai"]') as HTMLElement
    expect(ai.textContent).not.toContain('not connected')
    // Its answer is known (active: no word), not pending.
    expect(ai.textContent).not.toContain(String.fromCharCode(0x2026))
    expect(ai.textContent).toBe('claude.ai')
  })

  it('not checked for another reason: says "not checked", never "signed out"', async () => {
    answer.cli = { authenticated: false, notChecked: UNKNOWN }
    act(() => { root.render(<SessionHeader session={session} />) })
    await flush()
    expect(pill().textContent).toContain('not checked')
    expect(pill().textContent).not.toContain('signed out')
  })

  it('switching Claude Code back on asks again, and the real answer shows', async () => {
    claude(false)
    act(() => { root.render(<SessionHeader session={session} />) })
    await flush()
    const before = status.mock.calls.length
    answer.cli = { authenticated: true }
    claude(true)
    await flush()
    expect(status.mock.calls.length).toBe(before + 1)
    expect(pill().textContent).not.toContain('off')
    expect(pill().textContent).not.toContain('signed out')
  })
})

describe('the sidebar session menu', () => {
  const renderMenu = (over: Record<string, unknown>) =>
    act(() => root.render(React.createElement(SessionContextMenu, {
      x: 0, y: 0, session, hasGroup: false, onRename: () => {}, onRemoveFromGroup: () => {}, onClose: () => {}, onDismiss: () => {},
      onSignInCode: vi.fn(), codeSignedIn: false, ...over,
    } as any)))

  it('offers no Claude Code sign-in while it is off, and says why', () => {
    renderMenu({ codeNotChecked: claudeCodeNotChecked(undefined, true) })
    expect(container.textContent).not.toContain('Sign in to Claude Code')
    const row = container.querySelector('[data-testid="session-menu-claude-code-not-checked"]') as HTMLElement
    expect(row.textContent).toBe('Claude Code is off')
    expect(row.getAttribute('title')).toBe(OFF)
  })

  it('offers it as before when Claude Code is on (the control)', () => {
    renderMenu({ codeNotChecked: claudeCodeNotChecked({}, false) ?? undefined })
    expect(container.textContent).toContain('Sign in to Claude Code')
    expect(container.querySelector('[data-testid="session-menu-claude-code-not-checked"]')).toBeNull()
  })

  it("the sidebar hands the menu the account's not-checked state and the Claude-off rule", () => {
    expect(SIDEBAR_SOURCE).toContain('codeNotChecked={actionProfileId ? claudeCodeNotChecked(authByProfile[actionProfileId], claudeOffForMenu) ?? undefined : undefined}')
    expect(SIDEBAR_SOURCE).toContain('const claudeOffForMenu = useClaudeOff()')
  })
})
