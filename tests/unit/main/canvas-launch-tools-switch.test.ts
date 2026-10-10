// A launch's canvas skills follow the Built-in Tools switch as the saved
// settings hold it: only a switch saved OFF removes the app's skills from the
// user's own folder. Settings that cannot be read say nothing was switched
// off (the launch's tools are off through `toolsOn`), so the user's own copy
// is never removed on a guess. Pure: the checked reader, the guidance builder
// and the folders are mocked; nothing is read or written.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  read: { value: null as unknown, outcome: 'absent' as string },
  guidance: [] as Array<{ toolsOn: boolean; toolsSwitchedOff?: boolean }>,
}))

vi.mock('../../../src/main/config-manager', () => ({
  readConfigChecked: (key: string) => (key === 'settings' ? h.read : { value: null, outcome: 'absent' }),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logWarn: () => {}, logError: () => {}, logInfo: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '' }))
vi.mock('../../../src/main/canvas/codex-canvas-roots', () => ({ codexDesignatedWorktree: () => null }))
vi.mock('../../../src/main/canvas/codex-guidance', () => ({
  codexLaunchGuidance: (input: { toolsOn: boolean; toolsSwitchedOff?: boolean }) => { h.guidance.push(input); return null },
  codexGuidanceNotStaged: () => null,
}))

const { prepareCodexCanvasLaunch } = await import('../../../src/main/canvas/codex-canvas-launch')

function launch(toolsOn: boolean): { toolsOn: boolean; toolsSwitchedOff?: boolean } {
  h.guidance.length = 0
  prepareCodexCanvasLaunch({
    sessionId: 'switch-test',
    configuredCwd: '/project',
    home: '/home/user/.config-home',
    managedSkillsDirFor: () => null,
    toolsOn,
    ownership: 'external-default',
  })
  expect(h.guidance).toHaveLength(1)
  return h.guidance[0]
}

beforeEach(() => { h.read = { value: null, outcome: 'absent' } })

describe('a launch reads the Built-in Tools switch from the saved settings', () => {
  it('a switch saved off is switched off', () => {
    h.read = { value: { conductorToolsEnabled: false }, outcome: 'ok' }
    expect(launch(false).toolsSwitchedOff).toBe(true)
  })

  // The answer is the saved settings' own: what the launch was handed as
  // `toolsOn` never decides it, either way.
  it('the switched-off answer comes from the saved settings, whatever the launch was handed', () => {
    h.read = { value: { conductorToolsEnabled: false }, outcome: 'ok' }
    expect(launch(true).toolsSwitchedOff).toBe(true)
    h.read = { value: { conductorToolsEnabled: true }, outcome: 'ok' }
    expect(launch(false).toolsSwitchedOff).toBe(false)
  })

  it('a switch saved on, or not saved at all, is not switched off', () => {
    h.read = { value: { conductorToolsEnabled: true }, outcome: 'ok' }
    expect(launch(true).toolsSwitchedOff).toBe(false)
    h.read = { value: {}, outcome: 'ok' }
    expect(launch(true).toolsSwitchedOff).toBe(false)
    h.read = { value: null, outcome: 'absent' }
    expect(launch(true).toolsSwitchedOff).toBe(false)
  })

  it.each([
    ['failed', null],
    ['unparseable', null],
    ['ok', 'not an object'],
  ])('settings that cannot be read never remove the user\'s own skills copy (%s)', (outcome, value) => {
    h.read = { value, outcome }
    expect(launch(false).toolsSwitchedOff).toBe(false)
    expect(launch(true).toolsSwitchedOff).toBe(false)
  })
})

// The copies in the user's own skills folder follow the same reading: only a
// switch saved off asks for their removal; settings that are not a settings
// object are no answer at all.
describe('the user\'s own skills copies read the switch the same way', () => {
  it('saved off is "remove", saved on or absent follows the provider, and anything unreadable is no answer', async () => {
    const { codexUserSkillsWanted } = await import('../../../src/main/canvas/codex-user-skills')
    expect(codexUserSkillsWanted({ settings: () => ({ conductorToolsEnabled: false }), codexOn: () => true })).toBe(false)
    expect(codexUserSkillsWanted({ settings: () => ({}), codexOn: () => true })).toBe(true)
    expect(codexUserSkillsWanted({ settings: () => ({ conductorToolsEnabled: true }), codexOn: () => false })).toBe(false)
    expect(codexUserSkillsWanted({ settings: () => null, codexOn: () => true })).toBeNull()
    expect(codexUserSkillsWanted({ settings: () => [{ conductorToolsEnabled: false }] as unknown as Record<string, unknown>, codexOn: () => true })).toBeNull()
  })
})
