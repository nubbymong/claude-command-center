// @vitest-environment jsdom
// Quick Start (Running tab, design pass 2026-08-24; owner revision the same
// day): every pinned config shows, running or not — a config is a template
// and Start spawns another instance. Running pins carry a count pill. Start
// launches; the header collapse persists via settings; absent entirely when
// nothing is pinned.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const updateSettings = vi.fn()
const SETTINGS: any = { settings: { codexEnabled: true, quickStartCollapsed: false }, updateSettings }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS)
  useSettingsStore.getState = () => SETTINGS
  return { useSettingsStore }
})
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
// Phase 4: the panel now asks the REAL blocking rule (isMultiSpawnLaunchBlocked
// and its copy helpers), so the module is only partially mocked — the hook is
// stubbed to keep the store out, the pure rule stays honest.
vi.mock('../../../src/renderer/hooks/useLaunchConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/hooks/useLaunchConfig')>()),
  CODEX_OFF_LAUNCH_REASON: 'Codex is off',
  useLaunchConfig: () => () => '',
}))

const { default: QuickStartPanel } = await import('../../../src/renderer/components/sidebar/QuickStartPanel')

const cfg = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, workingDirectory: `/x/${id}`, color: '', sessionType: 'local', provider: 'claude', pinned: true, ...over,
})

describe('QuickStartPanel', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); updateSettings.mockClear(); SETTINGS.settings.quickStartCollapsed = false })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(QuickStartPanel, {
      onLaunch: () => {}, onContextMenu: () => {}, running: new Map(), ...props,
    } as any)))

  it('lists EVERY pin — a running one stays, with its count pill (owner revision)', () => {
    render({ configs: [cfg('a'), cfg('b'), cfg('c', { pinned: false })], running: new Map([['b', 2]]) })
    const items = container.querySelectorAll('[data-testid="quick-start-item"]')
    expect(items.length).toBe(2)
    const b = Array.from(items).find((el) => el.textContent!.includes('b'))!
    const pill = b.querySelector('[data-testid="quick-start-running-count"]')!
    expect(pill.textContent!.trim()).toBe('2')
    // Canvas note R1: number only — no dot glyph inside the pill.
    expect(pill.querySelector('span')).toBeNull()
    // The idle pin carries no pill.
    const a = Array.from(items).find((el) => el.textContent!.includes('a'))!
    expect(a.querySelector('[data-testid="quick-start-running-count"]')).toBeNull()
  })

  // Phase 4 narrows the 2026-08-24 revision: a running pin only relaunches when
  // it is a Multi Spawn config; the one-at-a-time refusal is covered in
  // multi-spawn-blocking.test.tsx.
  it('a running MULTI SPAWN pin can still start another instance (phase 4)', () => {
    const onLaunchMany = vi.fn()
    render({ configs: [cfg('b', { allowMultiSpawn: true })], running: new Map([['b', 1]]), onLaunchMany })
    const spawn = container.querySelector('[data-testid="quick-start-multi-spawn-launch"]') as HTMLButtonElement
    expect(spawn.disabled).toBe(false)
    act(() => { spawn.click() })
    expect(onLaunchMany).toHaveBeenCalledTimes(1)
  })

  it('Start launches the config', () => {
    const onLaunch = vi.fn()
    render({ configs: [cfg('a')], onLaunch })
    const start = container.querySelector('[data-testid="quick-start-item"] button') as HTMLButtonElement
    act(() => { start.click() })
    expect(onLaunch).toHaveBeenCalledTimes(1)
    expect(onLaunch.mock.calls[0][0].id).toBe('a')
  })

  it('collapse persists via settings and hides the rows', () => {
    render({ configs: [cfg('a')] })
    act(() => { (container.querySelector('[data-testid="quick-start-header"]') as HTMLElement).click() })
    expect(updateSettings).toHaveBeenCalledWith({ quickStartCollapsed: true })
    SETTINGS.settings.quickStartCollapsed = true
    render({ configs: [cfg('a')] })
    expect(container.querySelectorAll('[data-testid="quick-start-item"]').length).toBe(0)
    expect(container.querySelector('[data-testid="quick-start-header"]')).toBeTruthy()
  })

  it('renders nothing at all when no config is pinned', () => {
    render({ configs: [cfg('a', { pinned: false })] })
    expect(container.querySelector('[data-testid="quick-start"]')).toBeNull()
  })

  it('every pin running: the strip shows them all, each with a pill — never empty rows', () => {
    render({ configs: [cfg('a')], running: new Map([['a', 1]]) })
    expect(container.querySelector('[data-testid="quick-start"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="quick-start-item"]').length).toBe(1)
    expect(container.querySelector('[data-testid="quick-start-running-count"]')!.textContent).toContain('1')
  })
})

describe('the #462 restyle — session-card language, no loud fill', () => {
  const start = () =>
    container.querySelector('[data-testid="quick-start-item"] button') as HTMLButtonElement
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); SETTINGS.settings.quickStartCollapsed = false; SETTINGS.settings.codexEnabled = true })
  afterEach(() => { act(() => root.unmount()); container.remove() })
  const render = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(QuickStartPanel, {
      onLaunch: () => {}, onContextMenu: () => {}, running: new Map(), ...props,
    } as any)))

  it('Start is the subtle tinted-brand treatment, not a solid fill', () => {
    render({ configs: [cfg('a')] })
    const cls = start().className
    expect(cls).not.toContain('bg-blue')
    expect(cls).not.toContain('text-crust')
    expect(cls).toContain('var(--brand)')
    expect(cls).toContain('h-5')
  })

  it('each row carries ITS OWN identity colour — not a uniform wash of any kind', () => {
    // Two valid palette keys (see identity-colors.ts) — an invalid key would
    // silently fall back to mauve and make this a false pass.
    render({ configs: [cfg('a', { identityColorKey: 'pink' }), cfg('b', { identityColorKey: 'indigo' })] })
    const rows = Array.from(container.querySelectorAll('[data-testid="quick-start-item"]')) as HTMLElement[]
    expect(rows).toHaveLength(2)
    const channelsOf = (el: HTMLElement) => {
      // jsdom normalizes the chip hex to rgb(r, g, b) — the row's hex8 tint
      // normalizes to rgba(r, g, b, a) — so the channel triplet links them.
      const chip = el.querySelector('span[aria-hidden]') as HTMLElement
      const m = chip.style.backgroundColor.match(/rgb\((.+)\)/)
      expect(m, 'chip colour must resolve').toBeTruthy()
      return m![1]
    }
    for (const row of rows) {
      const styleAttr = row.getAttribute('style') ?? ''
      expect(styleAttr).not.toContain('--brand')
      // Canvas-approved 2026-08-25: identity on the BORDER only — its
      // color-mix carries the same channels as the row's own chip — and the
      // interior is transparent like a real idle session card (no background
      // property at all: stage read too bright in the light theme).
      expect(styleAttr).toContain(channelsOf(row))
      expect(styleAttr.toLowerCase()).not.toContain('background')
    }
    // ...and the two rows genuinely differ.
    expect(channelsOf(rows[0])).not.toBe(channelsOf(rows[1]))
  })

  it('a blocked Codex pin still reads as disabled in the new language', () => {
    SETTINGS.settings.codexEnabled = false
    render({ configs: [cfg('a', { provider: 'codex' })] })
    expect(start().disabled).toBe(true)
    expect(start().className).toContain('cursor-not-allowed')
    expect(start().className).not.toContain('bg-blue')
  })

  // Phase 6: Quick Start reads the SAME transport truth table as the Saved
  // rows — it used to make its own two-way call and so could never show a
  // container pin as anything but "SSH".
  const sshPin = (id: string, ssh: Record<string, unknown>) =>
    cfg(id, { sessionType: 'ssh', sshConfig: { host: 'h', username: 'u', remotePath: '~', ...ssh } })

  it('shows the container badge (replacing the SSH one) for a container pin', () => {
    render({ configs: [sshPin('a', { runtime: { type: 'container', container: 'rocky-dev' } })] })
    const item = container.querySelector('[data-testid="quick-start-item"]')!
    const badge = item.querySelector('[data-testid="ssh-container-badge"]') as HTMLElement
    expect(badge).toBeTruthy()
    expect(badge.title).toContain('Container session over SSH')
    expect(item.querySelector('[data-testid="ssh-badge"]')).toBeNull()
    expect(item.querySelector('[data-testid="ssh-persistent-badge"]')).toBeNull()
  })

  it('still shows SSH-Persistent / SSH for the other two kinds', () => {
    render({ configs: [sshPin('a', {}), sshPin('b', { detachable: false })] })
    const items = Array.from(container.querySelectorAll('[data-testid="quick-start-item"]'))
    const a = items.find((el) => el.textContent!.includes('a'))!
    const b = items.find((el) => el.textContent!.includes('b'))!
    expect(a.querySelector('[data-testid="ssh-persistent-badge"]')).toBeTruthy()
    expect(b.querySelector('[data-testid="ssh-badge"]')).toBeTruthy()
    expect(b.querySelector('[data-testid="ssh-persistent-badge"]')).toBeNull()
  })

  // Phase 6 row anatomy: identity dot FAR LEFT, then the type badge.
  it('renders the identity dot BEFORE the type badge', () => {
    render({ configs: [cfg('a')] })
    const item = container.querySelector('[data-testid="quick-start-item"]')!
    const dot = item.querySelector('[data-testid="quick-start-identity-dot"]')!
    const type = item.querySelector('[data-testid="type-badge-claude"]')!
    expect(item.firstElementChild).toBe(dot)
    expect(dot.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('in select mode the tick box stays ahead of the dot', () => {
    render({ configs: [cfg('a')], selectMode: true, onToggleSelected: () => {} })
    const item = container.querySelector('[data-testid="quick-start-item"]')!
    const box = item.querySelector('[data-testid="quick-start-select-checkbox"]')!
    const dot = item.querySelector('[data-testid="quick-start-identity-dot"]')!
    expect(item.firstElementChild).toBe(box)
    expect(box.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('has no absolutely-positioned hover strip to ghost through (its start button is inline)', () => {
    // The ConfigRow defect this phase fixes cannot exist here: Quick Start's
    // affordances are real flex children, not an overlay. Pinned so a future
    // "make it match the Saved row" does not silently import the bug.
    render({ configs: [cfg('a')] })
    const item = container.querySelector('[data-testid="quick-start-item"]')!
    expect(item.querySelector('.absolute')).toBeNull()
    expect(item.className).not.toContain('relative')
  })
})
