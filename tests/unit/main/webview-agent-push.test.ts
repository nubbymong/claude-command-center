/**
 * The main-side half of open_in_app_browser: `pushAgentUrlToWebview` emits the
 * WEBVIEW_AGENT_PUSH event to the renderer for the right session, carrying the
 * NORMALISED href, and refuses when there is no window, a bad scheme, or an
 * ill-formed session id. It NEVER opens or navigates a view here — that is the
 * whole of the never-yank guarantee, so there is nothing to assert about a view.
 *
 * Relies on the global electron mock (tests/unit/setup.ts): the function only
 * touches `win.webContents.send`, so a plain fake window is enough.
 */
import { describe, it, expect, vi } from 'vitest'
import { pushAgentUrlToWebview } from '../../../src/main/webview-manager'
import { IPC } from '../../../src/shared/ipc-channels'

const makeWin = () => {
  const send = vi.fn()
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as import('electron').BrowserWindow
  return { win, send }
}

describe('pushAgentUrlToWebview', () => {
  it('emits WEBVIEW_AGENT_PUSH with the session id and the normalised href, and returns true', () => {
    const { win, send } = makeWin()
    expect(pushAgentUrlToWebview(win, 'sess-1', 'HTTP://Example.com/a')).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC.WEBVIEW_AGENT_PUSH, { sessionId: 'sess-1', url: 'http://example.com/a' })
  })

  it('targets the RIGHT session — the id is passed through verbatim', () => {
    const { win, send } = makeWin()
    pushAgentUrlToWebview(win, 'session-XYZ', 'https://ex.test/')
    expect(send.mock.calls[0][1]).toMatchObject({ sessionId: 'session-XYZ' })
  })

  it('returns false and sends nothing when the window is absent or destroyed', () => {
    expect(pushAgentUrlToWebview(null, 'sess-1', 'https://ex.test/')).toBe(false)
    const send = vi.fn()
    const dead = { isDestroyed: () => true, webContents: { send } } as unknown as import('electron').BrowserWindow
    expect(pushAgentUrlToWebview(dead, 'sess-1', 'https://ex.test/')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('DEFENSIVELY refuses a non-http(s) url even though the tool validated first (belt and braces)', () => {
    const { win, send } = makeWin()
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'about:blank', 'chrome://settings']) {
      expect(pushAgentUrlToWebview(win, 'sess-1', bad), bad).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a session id that is not path-safe', () => {
    const { win, send } = makeWin()
    for (const bad of ['a/b', '..', 'x\n', 'persist:x', '']) {
      expect(pushAgentUrlToWebview(win, bad, 'https://ex.test/'), bad).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })
})
