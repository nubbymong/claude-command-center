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
    // Meter hidden card-wide for shells (it lives on its own bottom row now).
    expect(container.querySelector('.meter-fill')).toBeNull()
    expect(line2.textContent).not.toContain('98%')
    expect(line2.textContent).toContain('opus · shell')
  })

  it('still shows the context meter and % for a normal (non-shell) session', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ contextPercent: 42 }), ...baseProps })) })
    const line2 = container.querySelector('[data-testid="card-line2"]') as HTMLElement
    expect(line2.textContent).toContain('42%')
    // The meter itself sits on its own full-width bottom row — it was squeezed
    // to 0px whenever a long model name shared its flex row.
    expect(container.querySelector('[data-testid="context-meter-row"] .meter-fill')).not.toBeNull()
  })
})

describe('SessionRow session-type badge (canvas review 2026-08-19)', () => {
  // Every card shows its type, in ONE place: the right cluster, left of the
  // effort pill. Before this a local Claude Code session was marked by having
  // nothing, while Codex and Shell had an icon after the name and SSH had a
  // text badge in the same spot — four treatments, common case the odd one out.
  const renderRow = (over: Partial<Session>) => {
    act(() => { root.render(createElement(SessionRow, { ...baseProps, session: makeSession(over) })) })
    return container
  }

  it('gives a plain local Claude Code session a type badge', () => {
    const c = renderRow({})
    expect(c.querySelector('[data-testid="type-badge-claude"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="type-badge-codex"]')).toBeNull()
    expect(c.querySelector('[data-testid="type-badge-shell"]')).toBeNull()
  })

  it('shows codex and shell as their own types, never two at once', () => {
    expect(renderRow({ provider: 'codex' } as Partial<Session>).querySelector('[data-testid="type-badge-codex"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid^="type-badge-"]').length).toBe(1)
    expect(renderRow({ shellOnly: true }).querySelector('[data-testid="type-badge-shell"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid^="type-badge-"]').length).toBe(1)
  })

  it('puts the type badge in the RIGHT cluster, not after the name', () => {
    const c = renderRow({})
    const badge = c.querySelector('[data-testid="type-badge-claude"]')!
    // The name column is the `.nm` span; the badge must not be inside it.
    expect(badge.closest('.nm')).toBeNull()
    // And it sits in the same cluster as the status pill / effort pill.
    const cluster = badge.parentElement!
    expect(cluster.className).toContain('justify-self-end')
  })

  it('keeps SSH and tmux as separate badges, placed before the type badge', () => {
    const c = renderRow({ sessionType: 'ssh', sshTmuxPersistent: true } as Partial<Session>)
    const tmux = c.querySelector('[data-testid="ssh-persistent-badge"]')!
    const type = c.querySelector('[data-testid="type-badge-claude"]')!
    expect(tmux).not.toBeNull()
    // Same parent, transport first: reads "SSH · Claude" left to right.
    expect(tmux.parentElement).toBe(type.parentElement)
    expect(tmux.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Plain SSH likewise.
    const c2 = renderRow({ sessionType: 'ssh' })
    expect(c2.querySelector('[data-testid="ssh-badge"]')).not.toBeNull()
    expect(c2.querySelector('[data-testid="ssh-persistent-badge"]')).toBeNull()
  })

  it('places the type badge before the effort pill', () => {
    const c = renderRow({ effortLevel: 'high', effortLive: true } as Partial<Session>)
    const type = c.querySelector('[data-testid="type-badge-claude"]')!
    const effort = c.querySelector('[data-testid="effort-pill"]')!
    expect(effort).not.toBeNull()
    expect(type.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
