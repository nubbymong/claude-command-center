/**
 * The renderer store's half of open_in_app_browser: the agent push records a
 * pending URL and raises the unread pill WITHOUT touching the viewed page, and
 * the user consuming it clears both fields. The never-yank rule lives here — a
 * push must not move `currentUrl` / `isOpen` / `navSeq`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useWebviewStore } from '../../../src/renderer/stores/webviewStore'

beforeEach(() => { useWebviewStore.setState({ bySessionId: {} }) })

describe('webviewStore — agent push (never yank)', () => {
  it('pushAgentUrl records pending + unread WITHOUT touching currentUrl / isOpen / navSeq', () => {
    useWebviewStore.getState().pushAgentUrl('s1', 'https://example.com/pr/1')
    const st = useWebviewStore.getState().bySessionId['s1']
    expect(st.pendingAgentUrl).toBe('https://example.com/pr/1')
    expect(st.unread).toBe(true)
    expect(st.currentUrl).toBeNull()
    expect(st.isOpen).toBe(false)
    expect(st.navSeq).toBe(0)
  })

  it('does not disturb a page the user is actively viewing', () => {
    useWebviewStore.getState().navigate('s1', 'https://user-is-here.test/')
    const before = useWebviewStore.getState().bySessionId['s1']
    useWebviewStore.getState().pushAgentUrl('s1', 'https://agent-pushed.test/')
    const after = useWebviewStore.getState().bySessionId['s1']
    expect(after.currentUrl).toBe('https://user-is-here.test/') // unchanged
    expect(after.navSeq).toBe(before.navSeq)                     // no re-navigation
    expect(after.isOpen).toBe(true)                              // still open, still on that page
    expect(after.unread).toBe(true)
    expect(after.pendingAgentUrl).toBe('https://agent-pushed.test/')
  })

  it('consumeAgentPush returns the pending url and clears pending + unread', () => {
    useWebviewStore.getState().pushAgentUrl('s1', 'https://example.com/x')
    const url = useWebviewStore.getState().consumeAgentPush('s1')
    expect(url).toBe('https://example.com/x')
    const st = useWebviewStore.getState().bySessionId['s1']
    expect(st.pendingAgentUrl).toBeNull()
    expect(st.unread).toBe(false)
  })

  it('consumeAgentPush returns null when nothing is pending', () => {
    expect(useWebviewStore.getState().consumeAgentPush('never-existed')).toBeNull()
    useWebviewStore.getState().navigate('s2', 'https://x.test/')
    expect(useWebviewStore.getState().consumeAgentPush('s2')).toBeNull()
  })

  it('pushAgentUrl refuses a non-http(s) url (defence in depth)', () => {
    useWebviewStore.getState().pushAgentUrl('s1', 'javascript:alert(1)')
    expect(useWebviewStore.getState().bySessionId['s1']?.unread ?? false).toBe(false)
    expect(useWebviewStore.getState().bySessionId['s1']?.pendingAgentUrl ?? null).toBeNull()
  })

  it('a fresh session created by the push carries the new default fields', () => {
    useWebviewStore.getState().pushAgentUrl('brand-new', 'https://x.test/')
    const st = useWebviewStore.getState().bySessionId['brand-new']
    expect(st.pendingAgentUrl).toBe('https://x.test/')
    expect(st.status).toBe('idle')
    expect(st.isOpen).toBe(false)
  })
})
