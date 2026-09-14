// @vitest-environment jsdom
/**
 * Allow Multi Spawn (phase 4) — the launch ACTION's backstop.
 *
 * The affordances can be got around (a group launch-all, a keyboard path, a
 * render that has not caught up). `useLaunchConfig` therefore asks the rule
 * itself and returns '' for a refused launch, so the second copy of a
 * one-at-a-time config cannot be spawned by any route. And a ×N launch — N
 * calls through that same path — must produce exactly N sessions with N
 * DISTINCT ids.
 */
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: Object.assign((sel: any) => sel({ settings: { codexEnabled: true } }), {
    getState: () => ({ settings: { codexEnabled: true } }),
  }),
}))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ markSessionForResumePicker: vi.fn() }))

import { useLaunchConfig } from '../../../src/renderer/hooks/useLaunchConfig'

const config = (over: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  label: 'App Dev',
  workingDirectory: '/x',
  color: '',
  sessionType: 'local',
  provider: 'claude',
  ...over,
}) as any

/** Render a throwaway harness that calls the hook `times` times in a row —
 *  exactly what the ×N control's loop does — and report every returned id. */
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

beforeEach(() => { addSession.mockClear(); liveSessions = [] })

describe('the launch backstop', () => {
  it('refuses the SECOND launch of a one-at-a-time config — returns "" and adds nothing', () => {
    const ids = launchTimes(config(), 2)
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).toBe('')
  })

  it('launches freely while nothing of that config is running', () => {
    liveSessions = [{ id: 's-other', configId: 'cfg-OTHER' }]
    const ids = launchTimes(config(), 1)
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(ids[0]).toBeTruthy()
  })

  it('the Ask Conductor session never blocks a launch (it is config-less)', () => {
    liveSessions = [{ id: 'ask', configId: 'cfg-1', kind: 'ask' }]
    const ids = launchTimes(config(), 1)
    expect(ids[0]).toBeTruthy()
  })

  it('a Multi Spawn config launches again, and again', () => {
    const ids = launchTimes(config({ allowMultiSpawn: true }), 3)
    expect(addSession).toHaveBeenCalledTimes(3)
    expect(ids.every(Boolean)).toBe(true)
  })
})

describe('×N — exactly N sessions, N fresh ids', () => {
  for (const n of [1, 2, 5, 9]) {
    it(`×${n} adds ${n} sessions with ${n} distinct ids`, () => {
      const ids = launchTimes(config({ allowMultiSpawn: true, multiSpawnCount: n }), n)
      expect(addSession).toHaveBeenCalledTimes(n)
      expect(ids).toHaveLength(n)
      expect(new Set(ids).size).toBe(n)
      // Every copy carries the same config, and none is a reattach.
      const added = addSession.mock.calls.map((c) => c[0])
      expect(added.every((s: any) => s.configId === 'cfg-1')).toBe(true)
      expect(added.every((s: any) => s.sshReachedClaudeRunning === undefined)).toBe(true)
    })
  }

  it('a ×N on a one-at-a-time config still stops after the first — the backstop holds', () => {
    const ids = launchTimes(config({ multiSpawnCount: 4 }), 4)
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(ids.filter(Boolean)).toHaveLength(1)
  })
})
