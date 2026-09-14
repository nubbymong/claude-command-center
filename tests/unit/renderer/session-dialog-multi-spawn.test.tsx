// @vitest-environment jsdom
/**
 * Allow Multi Spawn — the config dialog's half of the TRI-STATE (phase 4.1).
 *
 * The field is not an opt-in flag, and this is where that matters. Phase 4
 * stored `undefined` whenever the box was unticked, which meant the startup
 * migration could not tell "never asked" from "the user turned this off" — so
 * it re-enabled a declined config on every launch for as long as two copies
 * were live, and the user's OFF never stuck.
 *
 * These tests drive the REAL dialog and assert on what it hands to onConfirm:
 * ticked => true, unticked-after-on (or unticked-while-already-declined) =>
 * an explicit false, unticked-on-a-config-that-never-had-it => undefined.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ groups: [], addGroup: vi.fn(), sections: [], addSection: vi.fn() }),
}))

;(window as any).electronAPI = {
  debug: { isEnabled: vi.fn().mockResolvedValue(false) },
  legacyVersion: {
    fetchVersions: vi.fn().mockResolvedValue([]),
    isInstalled: vi.fn().mockResolvedValue(false),
    install: vi.fn().mockResolvedValue({ ok: true }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
  },
  dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  credentials: { save: vi.fn(), delete: vi.fn() },
}
;(window as any).electronPlatform = 'win32'

import SessionDialog from '../../../src/renderer/components/SessionDialog'

const base = {
  id: 'c1',
  label: 'App Dev',
  workingDirectory: 'C:\\proj',
  color: '',
  sessionType: 'local',
  provider: 'claude',
}

describe('SessionDialog — Allow Multi Spawn tri-state', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  /** Open the dialog FRESH each time. Re-rendering into the same root would
   *  keep the previous useState seed, so a second `render` in one test would
   *  silently assert against the first config's checkbox. */
  const render = (initial: Record<string, unknown>, onConfirm = vi.fn()) => {
    act(() => { root.unmount() })
    root = createRoot(container)
    act(() => { root.render(React.createElement(SessionDialog, { initial, onConfirm, onCancel: vi.fn() } as any)) })
    return onConfirm
  }
  const box = () => container.querySelector('[data-testid="allow-multi-spawn"]') as HTMLInputElement
  const submit = () => act(() => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  const savedConfig = (onConfirm: ReturnType<typeof vi.fn>) => {
    expect(onConfirm).toHaveBeenCalledOnce()
    return onConfirm.mock.calls[0][0]
  }

  it('renders the toggle with its explanatory sub-line', () => {
    render(base)
    expect(container.querySelector('[data-testid="allow-multi-spawn-field"]')!.textContent)
      .toContain('Launch several copies of this config at once')
  })

  it('the checkbox reflects the stored value — and BOTH off-states look the same', () => {
    render({ ...base, allowMultiSpawn: true })
    expect(box().checked).toBe(true)
    render({ ...base, allowMultiSpawn: undefined })
    expect(box().checked).toBe(false)
    render({ ...base, allowMultiSpawn: false })
    expect(box().checked).toBe(false)
  })

  it('ticking it stores true', () => {
    const onConfirm = render(base)
    act(() => { box().click() })
    submit()
    expect(savedConfig(onConfirm).allowMultiSpawn).toBe(true)
  })

  it('UNTICKING a config that had it ON stores an explicit false, not undefined', () => {
    // The fix: this is the migration-reverts-the-user repro's second step.
    const onConfirm = render({ ...base, allowMultiSpawn: true })
    act(() => { box().click() })
    submit()
    expect(savedConfig(onConfirm).allowMultiSpawn).toBe(false)
  })

  it('a config that never had the field, left unticked, still stores undefined', () => {
    // Old configs stay clean and stay eligible for grandfathering — an
    // untouched checkbox is not a decision.
    const onConfirm = render(base)
    submit()
    expect(savedConfig(onConfirm).allowMultiSpawn).toBeUndefined()
  })

  it('a standing decline survives an unrelated edit', () => {
    const onConfirm = render({ ...base, allowMultiSpawn: false })
    submit()
    expect(savedConfig(onConfirm).allowMultiSpawn).toBe(false)
  })

  it('re-ticking a declined config stores true again', () => {
    const onConfirm = render({ ...base, allowMultiSpawn: false })
    act(() => { box().click() })
    submit()
    expect(savedConfig(onConfirm).allowMultiSpawn).toBe(true)
  })

  it('the row-owned copy count rides through the dialog untouched', () => {
    const onConfirm = render({ ...base, allowMultiSpawn: true, multiSpawnCount: 5 })
    submit()
    expect(savedConfig(onConfirm).multiSpawnCount).toBe(5)
  })
})
