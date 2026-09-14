// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { theme: 'dark' as const } }
  const useSettingsStore: any = (sel: (s: typeof STATE) => unknown) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
const { default: ConfigRow } = await import('../../../src/renderer/components/sidebar/ConfigRow')

const baseConfig = { id: 'c1', provider: 'claude' as const, label: 'My Config', workingDirectory: '.', sessionType: 'local' as const, identityColorKey: 'mauve' as const, color: '' }
const rowProps = { onLaunch: () => {}, onEdit: () => {}, onDelete: () => {}, onContextMenu: () => {} }

describe('ConfigRow quiet launcher', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('does NOT render a Claude badge for the default provider', () => {
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: baseConfig })))
    expect(container.querySelector('[title="Claude is working"]')).toBeNull()
  })

  it('launch button is not status-green (neutral affordance)', () => {
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: baseConfig })))
    const launch = container.querySelector('[title="Launch"]') as HTMLElement
    expect(launch).toBeTruthy()
    expect(launch.className).not.toContain('text-green')
  })

  it('shows the SSH-Persistent pill for a default (detachable) ssh config', () => {
    // The SSH default is persistent (detachable undefined/true), so the config
    // row reads SSH-Persistent — matching the running-session badge — instead of
    // the generic SSH pill.
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: { ...baseConfig, sessionType: 'ssh' } })))
    expect(container.querySelector('[data-testid="ssh-persistent-badge"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="ssh-badge"]')).toBeNull()
  })

  it('shows the plain SSH pill for a non-persistent ssh config (detachable:false)', () => {
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: { ...baseConfig, sessionType: 'ssh', sshConfig: { host: 'h', username: 'u', remotePath: '~', detachable: false } } })))
    expect(container.querySelector('[data-testid="ssh-badge"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="ssh-persistent-badge"]')).toBeNull()
  })

  // Phase 6: three-way transport. A container config REPLACES both SSH chips.
  const render = (config: Record<string, unknown>) =>
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config })))
  const sshCfg = (ssh: Record<string, unknown>) => ({ ...baseConfig, sessionType: 'ssh', sshConfig: { host: 'h', username: 'u', remotePath: '~', ...ssh } })

  it('shows the CONTAINER badge — not an SSH one — for a structured container runtime', () => {
    render(sshCfg({ runtime: { type: 'container', container: 'rocky-dev', engine: 'podman' } }))
    const badge = container.querySelector('[data-testid="ssh-container-badge"]') as HTMLElement
    expect(badge).toBeTruthy()
    expect(badge.title).toContain('Container session over SSH')
    expect(badge.title).toContain('rocky-dev')
    expect(container.querySelector('[data-testid="ssh-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="ssh-persistent-badge"]')).toBeNull()
  })

  it('the container badge wins even for a NON-detachable container config', () => {
    render(sshCfg({ detachable: false, runtime: { type: 'container', container: 'c' } }))
    expect(container.querySelector('[data-testid="ssh-container-badge"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="ssh-badge"]')).toBeNull()
  })

  it('the badge is LOGO ONLY and never names the container engine', () => {
    render(sshCfg({ runtime: { type: 'container', container: 'c', engine: 'docker' } }))
    const badge = container.querySelector('[data-testid="ssh-container-badge"]') as HTMLElement
    expect(badge.textContent).toBe('')                       // no word inside the chip
    expect(badge.querySelector('svg')).toBeTruthy()
    expect(badge.title.toLowerCase()).not.toContain('docker')
    expect(badge.title.toLowerCase()).not.toContain('podman')
  })

  it('a local config carries no transport chip at all', () => {
    render(baseConfig)
    expect(container.querySelector('[data-testid="ssh-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="ssh-persistent-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="ssh-container-badge"]')).toBeNull()
  })

  // Phase 6 row anatomy (signed-off replica): identity dot FAR LEFT, then the
  // type badge, then the name. The dot used to sit behind the type mark.
  it('renders the identity dot BEFORE the type badge', () => {
    render(baseConfig)
    const row = container.querySelector('[data-testid="config-row"]')!
    const dot = container.querySelector('[data-testid="config-row-identity-dot"]')!
    const type = container.querySelector('[data-testid="type-badge-claude"]')!
    expect(row.firstElementChild).toBe(dot)
    expect(dot.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('in select mode the tick box stays ahead of the dot (mode before identity)', () => {
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: baseConfig, selectMode: true })))
    const row = container.querySelector('[data-testid="config-row"]')!
    const box = container.querySelector('[data-testid="config-row-select-checkbox"]')!
    const dot = container.querySelector('[data-testid="config-row-identity-dot"]')!
    expect(row.firstElementChild).toBe(box)
    expect(box.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // Phase 6 hover strip (replica R1/a1): an OPAQUE core, no translucent
  // gradient over the badges, parked flush left of the count pill.
  it('the hover strip core is OPAQUE (no from-surface0 gradient over the badges)', () => {
    render(baseConfig)
    const strip = container.querySelector('[data-testid="config-row-hover-actions"]') as HTMLElement
    expect(strip).toBeTruthy()
    expect(strip.className).not.toContain('bg-gradient-to-l')
    expect(strip.className).not.toContain('from-surface0')
    expect(strip.style.background).toContain('color-mix')
    expect(strip.style.background).toContain('--surface-panel')
  })

  it('the hover strip parks flush LEFT of the running-count pill, which stays clickable', () => {
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: baseConfig, runningCount: 1 })))
    const strip = container.querySelector('[data-testid="config-row-hover-actions"]') as HTMLElement
    // 25px = the row's 8px padding + a 1-digit pill: flush, no sliver between.
    expect(strip.style.right).toBe('25px')
    const pill = container.querySelector('[data-testid="config-row-running-count"]') as HTMLElement
    expect(pill).toBeTruthy()
    expect(pill.tagName).toBe('BUTTON')
    expect(pill.hasAttribute('disabled')).toBe(false)
    // With no pill it sits on the row padding instead.
    act(() => root.unmount()); root = createRoot(container)
    render(baseConfig)
    expect((container.querySelector('[data-testid="config-row-hover-actions"]') as HTMLElement).style.right).toBe('8px')
  })
})
