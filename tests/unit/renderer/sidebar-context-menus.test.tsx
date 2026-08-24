// @vitest-environment jsdom
// The Quick Start / running-lock contract on BOTH context menus (design pass
// 2026-08-24): the pin verb flips with the pinned flag; Edit/Delete disable
// with reasons while the config runs; the deferral hint shows only when
// running && !pinned; the session menu's pin item vanishes for config-less
// sessions (Ask, adopted shells).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: ConfigContextMenu } = await import('../../../src/renderer/components/sidebar/ConfigContextMenu')
const { default: SessionContextMenu } = await import('../../../src/renderer/components/sidebar/SessionContextMenu')
const { PIN_WHILE_RUNNING_HINT } = await import('../../../src/renderer/components/sidebar/sessionsPanelState')

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
})
