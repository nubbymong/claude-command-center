// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { theme: 'dark' as const, accountAliases: {} as Record<string, string>, accountColourOverrides: {} as Record<string, import('../../../src/shared/identity-colors').IdentityColorKey> } }
  const useSettingsStore: any = (sel: (s: typeof STATE) => unknown) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})

vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  // Default: no profiles. Tests that need profile-name resolution seed the
  // mock directly via the STATE reference.
  const PROFILES_STATE = { profiles: [] as Array<{ id: string; name: string; accountEmail: string }> }
  const useAccountProfilesStore: any = (sel: (s: typeof PROFILES_STATE) => unknown) => sel(PROFILES_STATE)
  useAccountProfilesStore.getState = () => PROFILES_STATE
  // Expose STATE so individual tests can seed profiles.
  useAccountProfilesStore.__state = PROFILES_STATE
  return { useAccountProfilesStore }
})

const { useAccountProfilesStore: profilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')

const base = {
  id: 's1', label: 'web-frontend', model: 'sonnet', identityColorKey: 'mauve' as const,
  color: '', status: 'working' as const, createdAt: 0, provider: 'claude' as const,
  sessionType: 'local' as const, contextPercent: 40,
}
const props = {
  isActive: false, needsAttention: false, isRenaming: false, renameValue: '',
  renameRef: { current: null }, onRenameChange: () => {}, onRenameFinish: () => {},
  onRenameCancel: () => {}, onClick: () => {}, onContextMenu: () => {},
}

function render(root: Root, sessionOverrides: any, propOverrides: any = {}) {
  act(() => root.render(React.createElement(SessionRow, { ...(props as any), ...propOverrides, session: { ...base, ...sessionOverrides } })))
}

describe('SessionRow card', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('#454: renders the instance ordinal when given one, and omits it otherwise', () => {
    render(root, { label: 'App Dev' }, { ordinal: 2 })
    const o = container.querySelector('[data-testid="session-row-ordinal"]')
    expect(o?.textContent).toBe('#2')
    act(() => root.unmount()); root = createRoot(container)
    render(root, { label: 'App Dev' }) // no ordinal prop
    expect(container.querySelector('[data-testid="session-row-ordinal"]')).toBeNull()
  })

  it('does NOT render a Claude provider badge for the default (claude) provider', () => {
    render(root, { provider: 'claude' })
    expect(container.querySelector('[title="Claude is working"]')).toBeNull()
    expect(container.querySelector('[title="Waiting for input"]')).toBeNull()
  })

  it('renders a Codex glyph for codex provider', () => {
    // The type badge is a TYPE mark now, not an attention indicator: its title
    // is the plain type name and it no longer changes colour with state (the
    // status pill owns attention). Canvas review 2026-08-19.
    render(root, { provider: 'codex' })
    expect(container.querySelector('[data-testid="type-badge-codex"]')).toBeTruthy()
  })

  it('applies the quiet dashed focus ring class when focused', () => {
    render(root, {}, { isFocused: true })
    expect(container.querySelector('.card-focus')).toBeTruthy()
  })

  it('active card uses an inset box-shadow rail with the identity colour', () => {
    render(root, {}, { isActive: true })
    const card = container.querySelector('.session-card') as HTMLElement
    const style = card.getAttribute('style') || ''
    expect(style).toContain('inset 4px')
  })

  it('inactive row has a muted 3px inset box-shadow rail (identity colour visible, narrower than active)', () => {
    render(root, {}, { isActive: false, isSelected: false })
    const card = container.querySelector('.session-card') as HTMLElement
    const style = card.getAttribute('style') || ''
    expect(style).toContain('inset 3px')
    expect(style).not.toContain('inset 4px')
  })

  it('active row box-shadow contains "inset 4px" (stronger rail than inactive)', () => {
    render(root, {}, { isActive: true })
    const card = container.querySelector('.session-card') as HTMLElement
    const style = card.getAttribute('style') || ''
    expect(style).toContain('inset 4px')
  })

  it('context meter turns danger above 85%', () => {
    render(root, { contextPercent: 90 })
    expect(container.querySelector('.meter-danger')).toBeTruthy()
    render(root, { contextPercent: 50 })
    expect(container.querySelector('.meter-neutral')).toBeTruthy()
  })

  it('rename input is NOT nested inside a <button> (a11y #398)', () => {
    render(root, {}, { isRenaming: true, renameValue: 'x' })
    const input = container.querySelector('input') as HTMLElement
    expect(input).toBeTruthy()
    expect(input.closest('button')).toBeNull()
  })

  it('renders a persistent account stamp (dot + name) when accountEmail is set', () => {
    render(root, { accountEmail: 'nicholas@example.com', accountColour: 'mauve' })
    expect(container.querySelector('[data-testid="account-dot"]')).toBeTruthy()
    const name = container.querySelector('[data-testid="account-name"]') as HTMLElement
    expect(name).toBeTruthy()
    // No profile/alias resolved here, so the visible name falls back to the email.
    expect(name.textContent).toBe('nicholas@example.com')
    expect(name.getAttribute('title')).toBe('nicholas@example.com')
    // Account name now lives on its own line-3 row, not crammed into line-2.
    const line3 = container.querySelector('[data-testid="card-line3"]') as HTMLElement
    expect(line3).toBeTruthy()
    expect(line3.style.gridColumn).toBe('1 / 3')
    expect(line3.contains(name)).toBe(true)
  })

  it('resolves account name by live email, not by launch profileId', () => {
    // Seed a profile whose email matches the session's live accountEmail.
    const state = (profilesStore as any).__state
    state.profiles = [{ id: 'profile-abc', name: 'iCloud', accountEmail: 'me@icloud.com' }]
    // Session was launched under a different profile but /login changed it.
    render(root, { accountEmail: 'me@icloud.com', profileId: 'profile-xyz', accountColour: 'mauve' })
    const name = container.querySelector('[data-testid="account-name"]') as HTMLElement
    expect(name).toBeTruthy()
    // Name follows the LIVE email -> profile match, not the stale launch profileId.
    expect(name.textContent).toBe('iCloud')
    // Restore
    state.profiles = []
  })

  it('falls back to email when accountEmail does not match any profile', () => {
    render(root, { accountEmail: 'unknown@example.com', accountColour: 'mauve' })
    const name = container.querySelector('[data-testid="account-name"]') as HTMLElement
    expect(name).toBeTruthy()
    expect(name.textContent).toBe('unknown@example.com')
  })

  it('renders no account stamp when accountEmail is absent', () => {
    render(root, { accountEmail: undefined })
    expect(container.querySelector('[data-testid="account-dot"]')).toBeNull()
    expect(container.querySelector('[data-testid="account-name"]')).toBeNull()
    // No line-3 row for accountless sessions (no layout shift).
    expect(container.querySelector('[data-testid="card-line3"]')).toBeNull()
  })

  it('line 2 spans the full 2-column grid so the model meta is not clipped', () => {
    // jsdom cannot compute CSS grid, so lock the structural intent: the line-2
    // content lives in ONE child that spans the full grid (columns 1 / 3, after
    // the leading status-dot column was removed), and the model meta text lives
    // inside that wrapper.
    render(root, { model: 'sonnet', provider: 'claude' })
    const line2 = container.querySelector('[data-testid="card-line2"]') as HTMLElement
    expect(line2).toBeTruthy()
    expect(line2.style.gridColumn).toBe('1 / 3')
    expect(line2.textContent).toContain('sonnet')
    expect(line2.textContent).toContain('claude')
  })

  it('context meter lives on its own full-width row, independent of model-name length', () => {
    // Regression (owner report): the meter shared line 2 with the model meta as
    // a flex-basis-0 item. A long model name ("Opus 5 (1M context)") consumed
    // the row's natural width, so with no positive free space to grow into the
    // bar rendered 0px wide — it only ever showed for short names. jsdom can't
    // measure flex layout, so lock the structural fix instead: the meter sits in
    // a dedicated full-span grid row containing NO text, so no model-name length
    // can compete with it for width.
    render(root, { modelName: 'Opus 5 (1M context)', contextPercent: 26 })
    const meterRow = container.querySelector('[data-testid="context-meter-row"]') as HTMLElement
    expect(meterRow).toBeTruthy()
    expect(meterRow.style.gridColumn).toBe('1 / 3')
    // Nothing textual shares the meter's row — the squeeze cannot recur.
    expect((meterRow.textContent ?? '').trim()).toBe('')
    const fill = meterRow.querySelector('.meter-fill') as HTMLElement
    expect(fill).toBeTruthy()
    expect(fill.style.width).toBe('26%')
    // The long model name and the % still render on line 2; the meter is NOT
    // inside that flex row any more.
    const line2 = container.querySelector('[data-testid="card-line2"]') as HTMLElement
    expect(line2.textContent).toContain('Opus 5 (1M context)')
    expect(line2.textContent).toContain('26%')
    expect(line2.contains(fill)).toBe(false)
  })

  it('meter row sits below the account line (row 4; row 3 accountless) and degrades gracefully with no usage data', () => {
    render(root, { accountEmail: 'nicholas@example.com', accountColour: 'mauve', contextPercent: undefined })
    const meterRow = container.querySelector('[data-testid="context-meter-row"]') as HTMLElement
    expect(meterRow.className).toContain('row-start-4')
    // Unknown usage: empty track (0% fill) + blank %, same as pre-change.
    expect((meterRow.querySelector('.meter-fill') as HTMLElement).style.width).toBe('0%')
    expect(container.querySelector('[data-testid="card-line2"]')!.textContent).not.toContain('%')
    // Accountless card: the meter takes row 3 directly (no empty gap row).
    render(root, { accountEmail: undefined, contextPercent: 40 })
    expect((container.querySelector('[data-testid="context-meter-row"]') as HTMLElement).className).toContain('row-start-3')
  })

  it('shell-only sessions render no meter row at all', () => {
    render(root, { shellOnly: true, contextPercent: 98 })
    expect(container.querySelector('[data-testid="context-meter-row"]')).toBeNull()
    expect(container.querySelector('.meter-fill')).toBeNull()
  })

  // Phase 3 (harmonise-remote): the card's account line resolves from
  // accountEmail (live /status tick) with sshRemoteAccount (setup sentinel)
  // as the SSH fallback, so remote cards carry the same account row as local.
  it('SSH card shows the account line from sshRemoteAccount when no live tick yet', () => {
    render(root, { sessionType: 'ssh', accountEmail: undefined, sshRemoteAccount: 'remote@x.com' })
    const name = container.querySelector('[data-testid="account-name"]')
    expect(name).not.toBeNull()
    expect(name!.textContent).toBeTruthy()
    expect((name as HTMLElement).title).toBe('remote@x.com')
  })

  it('SSH card prefers the live accountEmail over the setup-sentinel snapshot', () => {
    render(root, { sessionType: 'ssh', accountEmail: 'live@x.com', sshRemoteAccount: 'stale@x.com' })
    const name = container.querySelector('[data-testid="account-name"]')
    expect((name as HTMLElement).title).toBe('live@x.com')
  })

  // Container transport badge (phase 6; supersedes the composing DockerBadge of
  // harmonise-remote Phase 3). The container mark REPLACES the SSH chip — main
  // never tmux-wraps a container session, so the old pairing showed two chips
  // for one fact.
  it('renders the container badge for a container SSH session, REPLACING the SSH badge', () => {
    render(root, { sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', dockerContainer: 'ccc-test' } })
    const c = container.querySelector('[data-testid="ssh-container-badge"]')
    expect(c).not.toBeNull()
    expect((c as HTMLElement).title).toContain('Container session over SSH')
    expect((c as HTMLElement).title).toContain('ccc-test')
    // Replaces: neither SSH chip is rendered alongside it.
    expect(container.querySelector('[data-testid="ssh-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="ssh-persistent-badge"]')).toBeNull()
  })

  it('the container badge OUTRANKS a reported tmux wrap (container wins)', () => {
    render(root, { sessionType: 'ssh', sshTmuxPersistent: true, sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', dockerContainer: 'ccc-test' } })
    expect(container.querySelector('[data-testid="ssh-container-badge"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="ssh-persistent-badge"]')).toBeNull()
  })

  it('a structured container runtime also wins (not just the legacy hint)', () => {
    render(root, { sessionType: 'ssh', sshTmuxPersistent: true, sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', runtime: { type: 'container', container: 'rocky-dev', engine: 'podman' } } })
    const c = container.querySelector('[data-testid="ssh-container-badge"]')
    expect(c).not.toBeNull()
    expect((c as HTMLElement).title).toContain('rocky-dev')
    // Never the engine's brand name anywhere the user can read it.
    expect((c as HTMLElement).title.toLowerCase()).not.toContain('docker')
    expect((c as HTMLElement).title.toLowerCase()).not.toContain('podman')
  })

  it('renders NO container badge when no container is configured', () => {
    render(root, { sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } })
    expect(container.querySelector('[data-testid="ssh-container-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="ssh-badge"]')).not.toBeNull()
    act(() => root.unmount()); root = createRoot(container)
    render(root, { sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', dockerContainer: '' } })
    expect(container.querySelector('[data-testid="ssh-container-badge"]')).toBeNull()
    act(() => root.unmount()); root = createRoot(container)
    // A runtime that explicitly runs on the HOST is not a container session.
    render(root, { sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', runtime: { type: 'host' } } })
    expect(container.querySelector('[data-testid="ssh-container-badge"]')).toBeNull()
    act(() => root.unmount()); root = createRoot(container)
    // A local session never carries one — nor any transport chip.
    render(root, { sessionType: 'local' })
    expect(container.querySelector('[data-testid="ssh-container-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="ssh-badge"]')).toBeNull()
  })
})
