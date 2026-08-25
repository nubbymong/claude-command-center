// @vitest-environment jsdom
/**
 * #439 — the "Open claude.ai sign-in in" setting and its routing.
 *
 * Default 'auto' keeps today's flow byte-identical (the dedicated window /
 * system browser); 'internal-pane' routes the Settings sign-in button into a
 * session's baked-in browser pane — and falls back to the window flow, with a
 * notice, when no session is open to host it. The Chrome/Edge picker only
 * renders when there is a genuine choice (SSO account AND both installed).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let SESSIONS: Array<{ id: string }> = []
let ACTIVE: string | null = null
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = () => ({ sessions: SESSIONS, activeSessionId: ACTIVE })
  const useSessionStore = (sel?: any) => (sel ? sel(state()) : state())
  useSessionStore.getState = state
  return { useSessionStore }
})

const api = {
  status: vi.fn(),
  webStatus: vi.fn(async () => ({ ok: true, web: { status: 'none' } })),
  signIn: vi.fn(async () => ({ ok: true, state: { phase: 'done' } })),
  signInState: vi.fn(async () => ({ ok: true, state: { phase: 'idle' } })),
  cancel: vi.fn(async () => ({ ok: true })),
  signOut: vi.fn(async () => ({ ok: true })),
  openArtifacts: vi.fn(async () => ({ ok: true })),
  setAuthMethod: vi.fn(async () => ({ ok: true })),
  setAuthBrowser: vi.fn(async () => ({ ok: true })),
  setSignInMode: vi.fn(async () => ({ ok: true })),
  onPaneState: vi.fn(() => () => {}),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, accountWeb: api }

const { AccountWebSession } = await import('../../../src/renderer/components/settings/AccountWebSession')

const statusPayload = (over: Record<string, unknown> = {}) => ({
  ok: true,
  web: { status: 'none' },
  cli: { authenticated: false },
  authCommand: 'claude auth login',
  authMethod: 'claudeai',
  authBrowser: 'edge',
  webSignInMode: 'auto',
  detectedBrowsers: ['edge'],
  ...over,
})

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const render = async () => {
  await act(async () => { root.render(<AccountWebSession profileId="profile-aaa111" accountName="Work" />) })
  await flush()
}
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

beforeEach(() => {
  SESSIONS = []
  ACTIVE = null
  for (const fn of Object.values(api)) (fn as ReturnType<typeof vi.fn>).mockClear()
  api.status.mockResolvedValue(statusPayload())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the sign-in mode setting', () => {
  it('renders both modes with the stored value selected, and writes a change', async () => {
    await render()
    const select = byTestId('web-sign-in-mode') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(select.value).toBe('auto')
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['auto', 'internal-pane'])
    await act(async () => {
      select.value = 'internal-pane'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.setSignInMode).toHaveBeenCalledWith({ profileId: 'profile-aaa111', mode: 'internal-pane' })
  })

  it('shows the stored internal-pane choice on load', async () => {
    api.status.mockResolvedValue(statusPayload({ webSignInMode: 'internal-pane' }))
    await render()
    expect((byTestId('web-sign-in-mode') as HTMLSelectElement).value).toBe('internal-pane')
  })
})

describe('the Chrome/Edge picker gate (#439: only when there is a choice)', () => {
  const pickerShown = () => container.textContent!.includes('Sign-in browser')

  it('hidden for a non-SSO account even with both browsers installed', async () => {
    api.status.mockResolvedValue(statusPayload({ authMethod: 'claudeai', detectedBrowsers: ['edge', 'chrome'] }))
    await render()
    expect(pickerShown()).toBe(false)
  })

  it('hidden for SSO with exactly one browser detected', async () => {
    api.status.mockResolvedValue(statusPayload({ authMethod: 'sso', detectedBrowsers: ['edge'] }))
    await render()
    expect(pickerShown()).toBe(false)
  })

  it('shown for SSO with both detected', async () => {
    api.status.mockResolvedValue(statusPayload({ authMethod: 'sso', detectedBrowsers: ['edge', 'chrome'] }))
    await render()
    expect(pickerShown()).toBe(true)
  })
})

describe('sign-in routing', () => {
  const clickSignIn = async () => {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Sign in to claude.ai'))
    expect(btn).toBeDefined()
    await act(async () => { btn!.click() })
    await flush()
  }

  it("mode 'auto' runs today's flow — api.signIn, no pane event", async () => {
    const seen = vi.fn()
    window.addEventListener('app:openAccountPane', seen)
    await render()
    await clickSignIn()
    window.removeEventListener('app:openAccountPane', seen)
    expect(api.signIn).toHaveBeenCalledWith('profile-aaa111')
    expect(seen).not.toHaveBeenCalled()
  })

  it("mode 'internal-pane' with a session open dispatches the pane event for the ACTIVE session and never calls signIn", async () => {
    api.status.mockResolvedValue(statusPayload({ webSignInMode: 'internal-pane' }))
    SESSIONS = [{ id: 's-one', sessionType: 'local' }, { id: 's-two', sessionType: 'local' }] as never
    ACTIVE = 's-two'
    const seen = vi.fn()
    window.addEventListener('app:openAccountPane', seen)
    await render()
    await clickSignIn()
    window.removeEventListener('app:openAccountPane', seen)
    expect(api.signIn).not.toHaveBeenCalled()
    expect(seen).toHaveBeenCalledTimes(1)
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's-two', profileId: 'profile-aaa111' })
    expect(container.textContent).toContain('sign in there once')
  })

  it("mode 'internal-pane' with NO session falls back to the window flow, with a notice", async () => {
    api.status.mockResolvedValue(statusPayload({ webSignInMode: 'internal-pane' }))
    await render()
    await clickSignIn()
    expect(api.signIn).toHaveBeenCalledWith('profile-aaa111')
    expect(container.textContent).toContain('sign-in window was used instead')
  })

  it('an SSH or shell-only session cannot host the pane — same fallback (#475 gate)', async () => {
    api.status.mockResolvedValue(statusPayload({ webSignInMode: 'internal-pane' }))
    SESSIONS = [{ id: 's-ssh', sessionType: 'ssh' }, { id: 's-shell', sessionType: 'local', shellOnly: true }] as never
    ACTIVE = 's-ssh'
    const seen = vi.fn()
    window.addEventListener('app:openAccountPane', seen)
    await render()
    await clickSignIn()
    window.removeEventListener('app:openAccountPane', seen)
    expect(seen).not.toHaveBeenCalled()
    expect(api.signIn).toHaveBeenCalledWith('profile-aaa111')
    expect(container.textContent).toContain('sign-in window was used instead')
  })
})
