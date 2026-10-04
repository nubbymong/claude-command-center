// @vitest-environment jsdom
// The Quick Start / running-lock contract on BOTH context menus (design pass
// 2026-08-24): the pin verb flips with the pinned flag; Edit/Delete disable
// with reasons while the config runs; the while-running hint shows only when
// running && !pinned; the session menu's pin item vanishes for config-less
// sessions (Ask, adopted shells).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: ConfigContextMenu } = await import('../../../src/renderer/components/sidebar/ConfigContextMenu')
const { default: SessionContextMenu } = await import('../../../src/renderer/components/sidebar/SessionContextMenu')
const { PIN_WHILE_RUNNING_HINT, WATCHDOG_RUNTIME_HINT, WATCHDOG_UNAVAILABLE_HINT } = await import('../../../src/renderer/components/sidebar/sessionsPanelState')
const { default: SIDEBAR_SOURCE } = await import('../../../src/renderer/components/Sidebar.tsx?raw')

describe('sidebar context menus — Quick Start + running lock', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const renderConfigMenu = (over: Record<string, unknown>) =>
    act(() => root.render(React.createElement(ConfigContextMenu, {
      x: 0, y: 0, groups: [], sections: [],
      onMoveToGroup: () => {}, onCreateGroup: () => {}, onMoveToSection: () => {}, onCreateSection: () => {},
      onEdit: () => {}, onDelete: () => {}, onPin: () => {}, onDuplicate: () => {}, onClose: () => {},
      ...over,
    } as any)))

  it('config menu: running keeps Edit live (edits shape future launches) and refuses only Delete', () => {
    // Owner revision 2026-08-24: a config is a template — it may relaunch and
    // be edited while running; deleting it under live sessions stays refused.
    renderConfigMenu({ running: true })
    const edit = container.querySelector('[data-testid="ctx-edit"]') as HTMLButtonElement
    const del = container.querySelector('[data-testid="ctx-delete"]') as HTMLButtonElement
    expect(edit.disabled).toBe(false)
    expect(edit.title).toMatch(/launched from now on/i)
    expect(del.disabled).toBe(true)
    expect(del.title).toMatch(/running/i)
  })

  it('config menu: not running keeps Edit/Delete live and shows no hint', () => {
    renderConfigMenu({ running: false })
    expect((container.querySelector('[data-testid="ctx-edit"]') as HTMLButtonElement).disabled).toBe(false)
    expect((container.querySelector('[data-testid="ctx-delete"]') as HTMLButtonElement).disabled).toBe(false)
    expect(container.textContent).not.toContain(PIN_WHILE_RUNNING_HINT)
  })

  it('config menu: pin verb flips with the pinned flag; deferral hint only when running && !pinned', () => {
    renderConfigMenu({ running: true, isPinned: false })
    expect(container.querySelector('[data-testid="ctx-pin"]')!.textContent).toMatch(/pin to quick start/i)
    expect(container.textContent).toContain(PIN_WHILE_RUNNING_HINT)

    renderConfigMenu({ running: true, isPinned: true })
    expect(container.querySelector('[data-testid="ctx-pin"]')!.textContent).toMatch(/unpin from quick start/i)
    expect(container.textContent).not.toContain(PIN_WHILE_RUNNING_HINT)
  })

  const session: any = { id: 's1', label: 'App Dev', sessionType: 'local', provider: 'claude' }
  const renderSessionMenu = (over: Record<string, unknown>) =>
    act(() => root.render(React.createElement(SessionContextMenu, {
      x: 0, y: 0, session, hasGroup: false,
      onRename: () => {}, onRemoveFromGroup: () => {}, onClose: () => {}, onDismiss: () => {},
      ...over,
    } as any)))

  it('session menu: pin item pins the config, with the deferral hint (a session IS running)', () => {
    const onPinConfig = vi.fn()
    renderSessionMenu({ onPinConfig, configPinned: false })
    const pin = container.querySelector('[data-testid="session-ctx-pin"]') as HTMLButtonElement
    expect(pin).toBeTruthy()
    expect(pin.textContent).toMatch(/pin to quick start/i)
    expect(container.textContent).toContain(PIN_WHILE_RUNNING_HINT)
    act(() => { pin.click() })
    expect(onPinConfig).toHaveBeenCalledTimes(1)
  })

  it('session menu: already-pinned config offers Unpin without the hint', () => {
    renderSessionMenu({ onPinConfig: () => {}, configPinned: true })
    expect(container.querySelector('[data-testid="session-ctx-pin"]')!.textContent).toMatch(/unpin from quick start/i)
    expect(container.textContent).not.toContain(PIN_WHILE_RUNNING_HINT)
  })

  it('session menu: hidden entirely for a config-less session', () => {
    renderSessionMenu({ onPinConfig: undefined })
    expect(container.querySelector('[data-testid="session-ctx-pin"]')).toBeNull()
  })

  // #605: the watchdog block is offered only where a watcher is actually armed,
  // and each check is an independent live switch.
  const allOn = { rateLimit: true, overload: true, safeguard: true }

  it('session menu: no watchdog block when no watcher is armed for the session', () => {
    renderSessionMenu({ watchdogChecks: undefined, onToggleWatchdogCheck: () => {} })
    expect(container.querySelector('[data-testid="session-ctx-watchdog"]')).toBeNull()
  })

  it('session menu: the three checks render with their live state and the runtime hint', () => {
    renderSessionMenu({ watchdogChecks: { ...allOn, overload: false }, onToggleWatchdogCheck: () => {} })
    expect(container.querySelector('[data-testid="session-ctx-watchdog"]')).toBeTruthy()
    const at = (k: string) => container.querySelector(`[data-testid="session-ctx-watchdog-${k}"]`) as HTMLButtonElement
    expect(at('rateLimit').getAttribute('aria-checked')).toBe('true')
    expect(at('overload').getAttribute('aria-checked')).toBe('false')
    expect(at('safeguard').getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).toContain(WATCHDOG_RUNTIME_HINT)
  })

  it('session menu: clicking a check reports that one key, leaving the others alone', () => {
    const onToggleWatchdogCheck = vi.fn()
    renderSessionMenu({ watchdogChecks: allOn, onToggleWatchdogCheck })
    act(() => { (container.querySelector('[data-testid="session-ctx-watchdog-safeguard"]') as HTMLButtonElement).click() })
    expect(onToggleWatchdogCheck).toHaveBeenCalledTimes(1)
    expect(onToggleWatchdogCheck).toHaveBeenCalledWith('safeguard')
  })

  // P3.10 (row 43): a Codex session's Watchdog has no safeguard check (Codex
  // has no such message): shown off, not switchable, and says why.
  it("session menu: a check the session's CLI has no patterns for is shown off, not switchable, with the reason", () => {
    const onToggleWatchdogCheck = vi.fn()
    renderSessionMenu({ watchdogChecks: { ...allOn, safeguard: false }, onToggleWatchdogCheck, watchdogUnavailable: ['safeguard'] })
    const btn = container.querySelector('[data-testid="session-ctx-watchdog-safeguard"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.getAttribute('title')).toBe(WATCHDOG_UNAVAILABLE_HINT)
    expect(btn.textContent).toContain('(not available)')
    act(() => { btn.click() })
    expect(onToggleWatchdogCheck).not.toHaveBeenCalled()
    const rate = container.querySelector('[data-testid="session-ctx-watchdog-rateLimit"]') as HTMLButtonElement
    expect(rate.disabled).toBe(false)
    act(() => { rate.click() })
    expect(onToggleWatchdogCheck).toHaveBeenCalledWith('rateLimit')
  })

  // [host] WP2 PR 4 P4.6 (row 58): Claude's account items (Open artifacts,
  // Authenticate claude.ai, Sign in to Claude Code) act on a Claude account's
  // claude.ai session and CLI. On a Codex tab they acted on ANOTHER account,
  // the primary Claude profile (the #216 fallback; P3.6 V5), so a Codex row
  // never gets them, whatever its caller passes. Whether a Codex item takes
  // Open artifacts' place is the signed artifacts record's to decide.
  const claudeItems = {
    onOpenArtifacts: vi.fn(), onAuthenticateWeb: vi.fn(), onSignInCode: vi.fn(), hasWebSession: true, codeSignedIn: false,
  }
  const accountItemTexts = () => Array.from(container.querySelectorAll('button, [data-testid="session-menu-claude-code-not-checked"]'))
    .map((b) => b.textContent ?? '')
    .filter((t) => /artifacts|claude\.ai|Claude Code/i.test(t))

  it("session menu: a Codex row never gets Claude's account items, even when every callback is passed", () => {
    renderSessionMenu({ session: { ...session, provider: 'codex' }, ...claudeItems })
    expect(accountItemTexts()).toEqual([])
    renderSessionMenu({ session: { ...session, provider: 'codex' }, ...claudeItems, hasWebSession: false, codeSignedIn: true })
    expect(accountItemTexts()).toEqual([])
    renderSessionMenu({ session: { ...session, provider: 'codex' }, ...claudeItems, codeNotChecked: { label: 'Claude Code is off', reason: 'off' } })
    expect(accountItemTexts()).toEqual([])
    // Nor a divider left behind for an empty block: only the one above Close.
    expect(container.querySelectorAll('.my-1.border-t')).toHaveLength(1)
  })

  it("session menu: a Claude row keeps Claude's account items (the control)", () => {
    renderSessionMenu({ ...claudeItems })
    expect(accountItemTexts()).toEqual(['Open artifacts', 'Re-authenticate claude.ai...', 'Sign in to Claude Code'])
    expect(container.querySelectorAll('.my-1.border-t')).toHaveLength(2)
    // A session with no provider recorded is Claude.
    renderSessionMenu({ session: { ...session, provider: undefined }, ...claudeItems })
    expect(accountItemTexts()).toHaveLength(3)
  })

  it('the sidebar resolves the acting account with the provider check, and a Codex row prefetches no Claude status', () => {
    // The acting profile comes from the one helper (claudeWebActionProfileId,
    // tests/unit/renderer/claude-web-targets.test.ts), not the old local
    // fallback to the primary profile.
    expect(SIDEBAR_SOURCE).toContain('const actionProfileId = claudeWebActionProfileId(s, primaryProfileId, accountProfiles)')
    expect(SIDEBAR_SOURCE).not.toMatch(/\(s\.profileId \?\? primaryProfileId\)\s*:\s*sshProfileId/)
    // The right-click prefetch reads the same helper, so it refreshes only the
    // account the menu acts on: none for a Codex row (the full read runs
    // `claude auth status`), nor for a row whose menu has no account items.
    // Both refresh helpers do nothing for an undefined id.
    expect(SIDEBAR_SOURCE).toContain('const prefetchId = claudeWebActionProfileId(session, primaryProfileId, accountProfiles); refreshWebOnly(prefetchId); void refreshWebSessions(prefetchId)')
    expect(SIDEBAR_SOURCE).not.toContain('?? (session.profileId ?? primaryProfileId)')
  })

  // [host] WP2 PR 4, P4.6 second half (row 58): a Codex row's own web-session
  // item: the account is the one the session runs under (the sidebar resolves
  // it with codexWebActionAccountId), and the item names no sign-in method.
  const codexItem = () => container.querySelector('[data-testid="session-ctx-codex-web"]') as HTMLButtonElement | null

  it('session menu: a Codex row gets its own chatgpt.com sign-in item; clicking it runs and dismisses', () => {
    const onCodexWebSignIn = vi.fn(); const onDismiss = vi.fn()
    renderSessionMenu({ session: { ...session, provider: 'codex' }, onCodexWebSignIn, onDismiss })
    expect(codexItem()!.textContent).toBe('Sign in to chatgpt.com...')
    act(() => { codexItem()!.click() })
    expect(onCodexWebSignIn).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    renderSessionMenu({ session: { ...session, provider: 'codex' }, onCodexWebSignIn, codexWebSignedIn: true })
    expect(codexItem()!.textContent).toBe('Sign in to chatgpt.com again...')
    // Never Claude's items beside it.
    expect(accountItemTexts()).toEqual([])
  })

  it('session menu: a Claude row never gets the Codex item, even when the callback is passed', () => {
    renderSessionMenu({ ...claudeItems, onCodexWebSignIn: vi.fn() })
    expect(codexItem()).toBeNull()
    renderSessionMenu({ session: { ...session, provider: undefined }, onCodexWebSignIn: vi.fn() })
    expect(codexItem()).toBeNull()
  })

  it("the sidebar wires the Codex item from the session's own registry account", () => {
    expect(SIDEBAR_SOURCE).toContain('const codexWebId = codexWebActionAccountId(s, accountsSnapshot)')
    expect(SIDEBAR_SOURCE).toContain('onCodexWebSignIn={codexWebId ? () => { void useCodexWebStore.getState().signIn(codexWebId) } : undefined}')
  })
})
