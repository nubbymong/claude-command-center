// @vitest-environment jsdom
/**
 * P3.13 (row 72): Multi Spawn and Quick Start on a Codex config. The rule's
 * other tests (multi-spawn-launch, multi-spawn-rule, multi-spawn-surfaces,
 * quick-start-panel) drive Claude configs; Codex is a different provider with
 * its own launch gate (off, not set up), its own account and its own options,
 * so the rule is pinned here on a Codex config at every place it is asked:
 *
 *  - the launch action's backstop (one copy at a time; N distinct copies of a
 *    Multi Spawn config, each carrying the Codex fields it spawns with);
 *  - a Restart of a tab that started nothing;
 *  - Quick Start's pin: the x N control, the blocked start and the select lock;
 *  - and that this rule, the renderer's, is the one main asks at pty:spawn.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const addSession = vi.fn((s: any) => { liveSessions.push(s) })
let liveSessions: any[] = []
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign((sel: any) => sel({ addSession, sessions: liveSessions }), {
    getState: () => ({ addSession, sessions: liveSessions }),
  }),
}))
const SETTINGS: any = { settings: { codexEnabled: true, quickStartCollapsed: false }, updateSettings: vi.fn() }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS)
  useSettingsStore.getState = () => SETTINGS
  return { useSettingsStore }
})
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ markSessionForResumePicker: vi.fn() }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const {
  useLaunchConfig, isMultiSpawnLaunchBlocked, alreadyRunningLaunchCopy, cannotSelectCopy, flattenPopoverCopy, restartLaunchRefusal,
  CODEX_OFF_LAUNCH_REASON, CODEX_NOT_SET_UP_LAUNCH_REASON,
} = await import('../../../src/renderer/hooks/useLaunchConfig')
const { default: QuickStartPanel } = await import('../../../src/renderer/components/sidebar/QuickStartPanel')
const { isOneAtATimeBlocked, alreadyRunningCopy } = await import('../../../src/shared/multi-spawn-rule')
const { claimConfigLaunch, _resetConfigLaunchClaimsForTest } = await import('../../../src/main/launch-one-at-a-time')

const codexConfig = (over: Record<string, unknown> = {}) => ({
  id: 'cx-1',
  label: 'Codex Dev',
  workingDirectory: '/x',
  color: '',
  sessionType: 'local',
  provider: 'codex',
  codexOptions: { permissionsPreset: 'standard', model: 'gpt-5.5', loggingEnabled: false },
  providerAccountId: 'acct-work',
  ...over,
}) as any

/** Call the launch hook `times` times in a row, as the x N control's loop does. */
function launchTimes(cfg: any, times: number): string[] {
  const returned: string[] = []
  function Harness() {
    const launch = useLaunchConfig()
    React.useEffect(() => { for (let i = 0; i < times; i++) returned.push(launch(cfg)) }, [])
    return null
  }
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  act(() => { root.render(React.createElement(Harness)) })
  act(() => { root.unmount() })
  return returned
}

beforeEach(() => {
  addSession.mockClear()
  liveSessions = []
  SETTINGS.settings = { codexEnabled: true, quickStartCollapsed: false }
  _resetConfigLaunchClaimsForTest()
})

describe('the launch backstop, on a Codex config', () => {
  it('refuses the second launch of a one-at-a-time Codex config: returns "" and adds nothing', () => {
    const ids = launchTimes(codexConfig(), 2)
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).toBe('')
  })

  it('a declined Multi Spawn (an explicit false) is one at a time too', () => {
    expect(launchTimes(codexConfig({ allowMultiSpawn: false }), 3).filter(Boolean)).toHaveLength(1)
  })

  it('a running copy of ANOTHER config never blocks it', () => {
    liveSessions = [{ id: 's-claude', configId: 'cfg-claude', provider: 'claude' }]
    expect(launchTimes(codexConfig(), 1)[0]).toBeTruthy()
  })

  it('a Codex tab whose launch started nothing (refused by main) does not count as running', () => {
    liveSessions = [{ id: 's-refused', configId: 'cx-1', neverStarted: true }]
    expect(launchTimes(codexConfig(), 1)[0]).toBeTruthy()
  })

  for (const n of [1, 2, 5, 9]) {
    it(`a Multi Spawn Codex config launched x${n} adds ${n} sessions with ${n} distinct ids, each carrying what its spawn needs`, () => {
      const ids = launchTimes(codexConfig({ allowMultiSpawn: true, multiSpawnCount: n }), n)
      expect(addSession).toHaveBeenCalledTimes(n)
      expect(new Set(ids).size).toBe(n)
      for (const [session] of addSession.mock.calls as any[][]) {
        expect(session).toMatchObject({
          configId: 'cx-1', provider: 'codex', sessionType: 'local', providerAccountId: 'acct-work',
          codexOptions: { permissionsPreset: 'standard', model: 'gpt-5.5' }, loggingEnabled: false,
        })
        expect(session.shellOnly).toBeUndefined()
        // None is a reattach, and none is started ahead of its tab.
        expect(session.sshReachedClaudeRunning).toBeUndefined()
      }
    })
  }

  it('a x N on a one-at-a-time Codex config still stops after the first', () => {
    expect(launchTimes(codexConfig({ multiSpawnCount: 4 }), 4).filter(Boolean)).toHaveLength(1)
    expect(addSession).toHaveBeenCalledTimes(1)
  })

  it('Codex off: no copy of a Multi Spawn config starts either (the provider rule first)', () => {
    SETTINGS.settings.codexEnabled = false
    expect(launchTimes(codexConfig({ allowMultiSpawn: true }), 3).filter(Boolean)).toHaveLength(0)
    expect(addSession).not.toHaveBeenCalled()
  })

  it('Codex not set up (no answer yet): no copy starts', () => {
    delete SETTINGS.settings.codexEnabled
    expect(launchTimes(codexConfig({ allowMultiSpawn: true }), 2).filter(Boolean)).toHaveLength(0)
    expect(addSession).not.toHaveBeenCalled()
  })

  it('Claude Code being off does not touch a Codex config', () => {
    SETTINGS.settings.claudeEnabled = false
    expect(launchTimes(codexConfig({ allowMultiSpawn: true }), 2).filter(Boolean)).toHaveLength(2)
  })
})

describe('a Restart of a Codex tab that started nothing is a launch of its config', () => {
  const tab = { neverStarted: true, configId: 'cx-1' }

  it('is refused, in the sidebar\'s words, while another copy runs and the config is not Multi Spawn', () => {
    liveSessions = [{ id: 's-live', configId: 'cx-1' }]
    const cfg = codexConfig()
    expect(restartLaunchRefusal(tab, [cfg])).toBe(flattenPopoverCopy(alreadyRunningLaunchCopy('Codex Dev')))
  })

  it('goes ahead for a Multi Spawn config, with nothing else running, or when it is not a tab that started nothing', () => {
    liveSessions = [{ id: 's-live', configId: 'cx-1' }]
    expect(restartLaunchRefusal(tab, [codexConfig({ allowMultiSpawn: true })])).toBeUndefined()
    liveSessions = []
    expect(restartLaunchRefusal(tab, [codexConfig()])).toBeUndefined()
    liveSessions = [{ id: 's-live', configId: 'cx-1' }]
    expect(restartLaunchRefusal({ configId: 'cx-1' }, [codexConfig()])).toBeUndefined()
  })
})

describe('the renderer and main ask the SAME rule', () => {
  const flags = [undefined, false, true, 'yes', 1, null]
  const counts = [0, 1, 2, 5]

  it('over every stored value and copy count, the sidebar\'s block, the shared rule and main\'s refusal agree', () => {
    for (const flag of flags) {
      for (const count of counts) {
        const blocked = isMultiSpawnLaunchBlocked({ allowMultiSpawn: flag as never }, count)
        expect(isOneAtATimeBlocked(flag, count), `shared ${String(flag)} x${count}`).toBe(blocked)
        // Main: `count` other copies of the config are held; a new spawn is asked.
        _resetConfigLaunchClaimsForTest()
        const held = new Set<string>()
        const deps = { savedConfigs: () => [{ id: 'cx-1', label: 'Codex Dev', allowMultiSpawn: flag }], isLive: (id: string) => held.has(id) }
        for (let i = 0; i < count; i++) {
          // Held copies were accepted while the config was Multi Spawn.
          const accepted = claimConfigLaunch(`held-${i}`, { configId: 'cx-1', provider: 'codex' }, { ...deps, savedConfigs: () => [{ id: 'cx-1', label: 'x', allowMultiSpawn: true }] })
          expect('ticket' in accepted).toBe(true)
          held.add(`held-${i}`)
        }
        const answer = claimConfigLaunch('new', { configId: 'cx-1', provider: 'codex' }, deps)
        expect('refused' in answer, `main ${String(flag)} x${count}`).toBe(blocked)
      }
    }
  })

  it('and says it in the same words: the sidebar\'s popover copy is the head of main\'s refusal', () => {
    const copy = alreadyRunningLaunchCopy('Codex Dev')
    expect(copy).toEqual(alreadyRunningCopy('Codex Dev'))
    _resetConfigLaunchClaimsForTest()
    const held = new Set<string>(['a'])
    const deps = { savedConfigs: () => [{ id: 'cx-1', label: 'Codex Dev' }], isLive: (id: string) => held.has(id) }
    claimConfigLaunch('a', { configId: 'cx-1', provider: 'codex' }, deps)
    const answer = claimConfigLaunch('b', { configId: 'cx-1', provider: 'codex' }, deps)
    const refusal = 'refused' in answer ? answer.refused : { message: '' }
    expect(refusal.message.startsWith(`${copy.headline} ${copy.body}`)).toBe(true)
  })
})

describe('Quick Start with a Codex pin', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const pin = (over: Record<string, unknown> = {}) => codexConfig({ pinned: true, ...over })
  const render = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(QuickStartPanel, {
      onLaunch: () => {}, onContextMenu: () => {}, running: new Map(), ...props,
    } as any)))
  const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null

  it('shows a Codex pin with the Codex type badge, and Start launches it', () => {
    const onLaunch = vi.fn()
    render({ configs: [pin()], onLaunch })
    expect($('type-badge-codex')).toBeTruthy()
    expect($('type-badge-claude')).toBeNull()
    const start = $('quick-start-start') as HTMLButtonElement
    expect(start.disabled).toBe(false)
    act(() => { start.click() })
    expect(onLaunch).toHaveBeenCalledTimes(1)
    expect(onLaunch.mock.calls[0][0]).toMatchObject({ id: 'cx-1', provider: 'codex' })
  })

  it('a Multi Spawn Codex pin\'s start button IS the x N control, launching its stored count', () => {
    const onLaunchMany = vi.fn()
    const onLaunch = vi.fn()
    render({ configs: [pin({ allowMultiSpawn: true, multiSpawnCount: 3 })], running: new Map([['cx-1', 3]]), onLaunchMany, onLaunch })
    expect($('quick-start-start')).toBeNull()
    expect($('quick-start-multi-spawn-count')!.textContent).toBe('3')
    act(() => { ($('quick-start-multi-spawn-launch') as HTMLButtonElement).click() })
    expect(onLaunchMany).toHaveBeenCalledTimes(1)
    expect(onLaunchMany.mock.calls[0][0]).toMatchObject({ id: 'cx-1', provider: 'codex' })
    expect(onLaunchMany.mock.calls[0][1]).toBe(3)
    expect(onLaunch).not.toHaveBeenCalled()
    // The count pill says how many are running, as for a Claude pin.
    expect($('quick-start-running-count')!.textContent).toBe('3')
  })

  it('the x N control steps and persists the count for a Codex pin', () => {
    const onSpawnCountChange = vi.fn()
    render({ configs: [pin({ allowMultiSpawn: true, multiSpawnCount: 3 })], onSpawnCountChange })
    act(() => { ($('quick-start-multi-spawn-step') as HTMLButtonElement).click() })
    expect(onSpawnCountChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'cx-1' }), 4)
  })

  it('a running Codex pin that is not Multi Spawn has a blocked start that raises the popover, never a launch', () => {
    const onLaunch = vi.fn()
    const onBlockedLaunch = vi.fn()
    render({ configs: [pin()], running: new Map([['cx-1', 1]]), onLaunch, onBlockedLaunch })
    const blocked = $('quick-start-start-blocked') as HTMLButtonElement
    expect($('quick-start-start')).toBeNull()
    expect(blocked.title).toBe(flattenPopoverCopy(alreadyRunningLaunchCopy('Codex Dev')))
    act(() => { blocked.click() })
    expect(onBlockedLaunch).toHaveBeenCalledTimes(1)
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it('an idle one-at-a-time Codex pin starts normally; a declined one is blocked only while running', () => {
    render({ configs: [pin({ allowMultiSpawn: false })] })
    expect($('quick-start-start')).toBeTruthy()
    render({ configs: [pin({ allowMultiSpawn: false })], running: new Map([['cx-1', 1]]) })
    expect($('quick-start-start-blocked')).toBeTruthy()
  })

  it('Codex off: the pin is disabled with Codex\'s own reason, a Multi Spawn pin\'s x N control included', () => {
    SETTINGS.settings.codexEnabled = false
    render({ configs: [pin()] })
    expect(($('quick-start-start') as HTMLButtonElement).disabled).toBe(true)
    expect(($('quick-start-start') as HTMLButtonElement).title).toBe(CODEX_OFF_LAUNCH_REASON)
    render({ configs: [pin({ allowMultiSpawn: true })] })
    const control = $('quick-start-multi-spawn-launch') as HTMLButtonElement
    expect(control.disabled).toBe(true)
    expect(control.title).toBe(CODEX_OFF_LAUNCH_REASON)
  })

  it('Codex not set up: the pin says so, not that it is off', () => {
    delete SETTINGS.settings.codexEnabled
    render({ configs: [pin({ allowMultiSpawn: true })] })
    expect(($('quick-start-multi-spawn-launch') as HTMLButtonElement).title).toBe(CODEX_NOT_SET_UP_LAUNCH_REASON)
  })

  it('Claude Code off does not disable a Codex pin', () => {
    SETTINGS.settings.claudeEnabled = false
    render({ configs: [pin({ allowMultiSpawn: true })] })
    expect(($('quick-start-multi-spawn-launch') as HTMLButtonElement).disabled).toBe(false)
  })

  it('select mode: a running one-at-a-time Codex pin is locked, a Multi Spawn one is ticked', () => {
    const onBlockedSelect = vi.fn()
    const onToggleSelected = vi.fn()
    render({
      configs: [pin(), pin({ id: 'cx-2', label: 'Codex Multi', allowMultiSpawn: true })],
      running: new Map([['cx-1', 1], ['cx-2', 2]]),
      selectMode: true, onBlockedSelect, onToggleSelected,
    })
    const lock = $('quick-start-select-lock') as HTMLButtonElement
    expect(lock).toBeTruthy()
    expect(lock.title).toBe(flattenPopoverCopy(cannotSelectCopy('Codex Dev')))
    act(() => { lock.click() })
    expect(onBlockedSelect).toHaveBeenCalledTimes(1)
    const box = $('quick-start-select-checkbox') as HTMLButtonElement
    act(() => { box.click() })
    expect(onToggleSelected).toHaveBeenCalledWith('cx-2')
    // The x N control steps aside in select mode; the ordinary start takes over.
    expect($('quick-start-multi-spawn-launch')).toBeNull()
    expect($('quick-start-start')).toBeTruthy()
  })
})
