// @vitest-environment jsdom
// The launcher row under the owner's 2026-08-24 revision: a config is a
// TEMPLATE. A running config keeps ALL its affordances except Delete — it can
// be launched again — and shows a live-session COUNT pill whose click jumps
// to the session. (This file replaced the locked-row suite the revision
// retired: no more grey lock, no more launch refusal.)
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { codexEnabled: true } }
  const useSettingsStore: any = (sel: any) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
// Phase 4: the row now asks the REAL blocking rule (isMultiSpawnLaunchBlocked
// and its copy helpers), so the module is only partially mocked — the hook is
// stubbed to keep the store out, the pure rule stays honest.
vi.mock('../../../src/renderer/hooks/useLaunchConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/hooks/useLaunchConfig')>()),
  CODEX_OFF_LAUNCH_REASON: 'Codex is off',
  useLaunchConfig: () => () => '',
}))

const { default: ConfigRow } = await import('../../../src/renderer/components/sidebar/ConfigRow')
const { DELETE_WHILE_RUNNING_REASON } = await import('../../../src/renderer/components/sidebar/sessionsPanelState')

const config: any = {
  id: 'c1',
  label: 'App Dev',
  workingDirectory: '/dev/app',
  color: '',
  sessionType: 'local',
  provider: 'claude',
  pinned: true,
}

describe('ConfigRow — relaunch with a running-count indicator', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const renderRow = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(ConfigRow, {
      config,
      onLaunch: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onContextMenu: () => {},
      ...props,
    } as any)))

  // Phase 4 narrows the 2026-08-24 revision: a config is still a template that
  // may relaunch while running, but ONLY when it is marked Allow Multi Spawn.
  // The one-at-a-time case is covered in multi-spawn-blocking.test.tsx.
  it('a running MULTI SPAWN config can be LAUNCHED AGAIN — Edit live, only Delete refused', () => {
    const launched = vi.fn()
    renderRow({ config: { ...config, allowMultiSpawn: true }, runningCount: 2, onLaunchMany: launched, onPin: () => {} })
    const titles = Array.from(container.querySelectorAll('button')).map((b) => b.getAttribute('title'))
    expect(titles).toContain('Edit')
    expect(titles).toContain(DELETE_WHILE_RUNNING_REASON) // Delete refused with the reason
    expect(titles).not.toContain('Delete')
    // The plain play button is replaced by the ×N spawn control on a Multi
    // Spawn row — one launch affordance, never two.
    expect(titles).not.toContain('Launch')
    const spawn = container.querySelector('[data-testid="config-row-multi-spawn-launch"]') as HTMLElement
    act(() => { spawn.click() })
    expect(launched).toHaveBeenCalledTimes(1)
    const del = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('title') === DELETE_WHILE_RUNNING_REASON)!
    expect((del as HTMLButtonElement).disabled).toBe(true)
  })

  it('the count pill shows N and its click opens the session — not a row-wide hijack', () => {
    const opened = vi.fn()
    renderRow({ runningCount: 3, onOpenSession: opened })
    const pill = container.querySelector('[data-testid="config-row-running-count"]') as HTMLElement
    expect(pill).toBeTruthy()
    // #473: number only — no dot glyph (the canvas-approved pill language).
    expect(pill.textContent!.trim()).toBe('3')
    expect(pill.querySelector('span')).toBeNull()
    act(() => { pill.click() })
    expect(opened).toHaveBeenCalledTimes(1)
    // The retired locked row is gone for good.
    expect(container.querySelector('[data-testid="config-row-running"]')).toBeNull()
  })

  it('an idle config shows no pill and keeps every action, Delete included', () => {
    renderRow({ runningCount: 0, onPin: () => {} })
    expect(container.querySelector('[data-testid="config-row-running-count"]')).toBeNull()
    const titles = Array.from(container.querySelectorAll('button')).map((b) => b.getAttribute('title'))
    expect(titles).toContain('Launch')
    expect(titles).toContain('Edit')
    expect(titles).toContain('Delete')
    expect(titles).toContain('Unpin from Quick Start') // config.pinned = true
  })
})
