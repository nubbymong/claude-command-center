// The built-in tools switches are read from a CHECKED read of the saved
// settings: a fresh install (no file) keeps them on; settings that are there
// but cannot be read or parsed turn them off until they can be read. Pure:
// the checked reader and the logger are mocked, no file is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  read: { outcome: 'absent', value: null } as { outcome: string; value: unknown },
  throws: false,
  calls: [] as Array<{ key: string; opts: unknown }>,
  warns: [] as string[],
}))

vi.mock('../../../src/main/config-manager', () => ({
  readConfigChecked: (key: string, opts: unknown) => {
    h.calls.push({ key, opts })
    if (h.throws) throw new Error('the reader failed')
    return h.read
  },
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logWarn: (...args: unknown[]) => { h.warns.push(args.map(String).join(' ')) },
  logError: () => {},
  logInfo: () => {},
  logDebug: () => {},
}))

type SwitchModule = typeof import('../../../src/main/conductor-tools-switch')
let mod: SwitchModule

beforeEach(async () => {
  vi.resetModules()
  h.read = { outcome: 'absent', value: null }
  h.throws = false
  h.calls.length = 0
  h.warns.length = 0
  mod = await import('../../../src/main/conductor-tools-switch')
})

const setRead = (outcome: string, value: unknown) => { h.read = { outcome, value } }

describe('the built-in tools switches', () => {
  it('a fresh install keeps the built-in tools on', () => {
    setRead('absent', null)
    expect(mod.readConductorToolSwitches()).toEqual({ master: true, switches: {} })
    expect(mod.conductorToolsMasterOn()).toBe(true)
  })

  it('reads the settings without moving the file aside', () => {
    mod.readConductorToolSwitches()
    expect(h.calls).toEqual([{ key: 'settings', opts: { quarantineUnparseable: false } }])
  })

  it('saved on, and a missing master key, keep the built-in tools on', () => {
    setRead('ok', { conductorToolsEnabled: true })
    expect(mod.conductorToolsMasterOn()).toBe(true)
    setRead('ok', { theme: 'dark' })
    expect(mod.readConductorToolSwitches()).toEqual({ master: true, switches: {} })
  })

  it('saved off turns the built-in tools off, with the groups still known', () => {
    setRead('ok', { conductorToolsEnabled: false, conductorTools: { vision: false } })
    expect(mod.readConductorToolSwitches()).toEqual({ master: false, switches: { vision: false } })
  })

  it.each([
    ['unparseable', null],
    ['failed', null],
    ['ok', null],
    ['ok', 'a string'],
    ['ok', 42],
    ['ok', [{ conductorToolsEnabled: true }]],
  ])('the built-in tools are off while the settings cannot be read (%s, %j)', (outcome, value) => {
    setRead(outcome, value)
    expect(mod.readConductorToolSwitches()).toEqual({ master: false, switches: null })
    expect(mod.conductorToolsMasterOn()).toBe(false)
  })

  it('a reader that throws leaves the built-in tools off', () => {
    h.throws = true
    expect(mod.readConductorToolSwitches()).toEqual({ master: false, switches: null })
    expect(mod.readConductorToolSettings().settings).toBeNull()
  })

  it('keeps only saved true/false group switches (anything else reads as on)', () => {
    setRead('ok', { conductorTools: { vision: false, canvas: true, hostTransfer: 'no', claudeReview: null } })
    expect(mod.readConductorToolSwitches()).toEqual({ master: true, switches: { vision: false, canvas: true } })
    setRead('ok', { conductorTools: 'off' })
    expect(mod.readConductorToolSwitches()).toEqual({ master: true, switches: {} })
  })

  it('a group key named like a prototype is not carried', () => {
    setRead('ok', JSON.parse('{"conductorTools":{"__proto__":false,"vision":false}}'))
    const { switches } = mod.readConductorToolSwitches()
    expect(switches).toEqual({ vision: false })
    expect(Object.getPrototypeOf(switches)).toBe(Object.prototype)
  })

  it('hands back the settings of the same read, and none when they could not be read', () => {
    const saved = { conductorToolsEnabled: true, otherSetting: true }
    setRead('ok', saved)
    expect(mod.readConductorToolSettings()).toEqual({ tools: { master: true, switches: {} }, settings: saved })
    setRead('failed', null)
    expect(mod.readConductorToolSettings()).toEqual({ tools: { master: false, switches: null }, settings: null })
    setRead('absent', null)
    expect(mod.readConductorToolSettings().settings).toBeNull()
  })

  it('settings a caller has already read give the same switches, without a second read', () => {
    expect(mod.conductorToolSwitchesOfSettings({ conductorToolsEnabled: false, conductorTools: { canvas: false } })).toEqual({ master: false, switches: { canvas: false } })
    expect(mod.conductorToolSwitchesOfSettings({ theme: 'dark' })).toEqual({ master: true, switches: {} })
    for (const value of [null, undefined, 'a string', [{ conductorToolsEnabled: true }]]) {
      expect(mod.conductorToolSwitchesOfSettings(value), String(value)).toEqual({ master: false, switches: null })
    }
    expect(h.calls).toEqual([])
  })

  it('says once per run that the settings could not be read', () => {
    setRead('failed', null)
    mod.readConductorToolSwitches()
    setRead('unparseable', null)
    mod.readConductorToolSwitches()
    mod.conductorToolsMasterOn()
    expect(h.warns).toHaveLength(1)
    expect(h.warns[0]).toContain('stay off')
  })

  it('a readable settings file logs nothing', () => {
    setRead('ok', { conductorToolsEnabled: false })
    mod.readConductorToolSwitches()
    setRead('absent', null)
    mod.readConductorToolSwitches()
    expect(h.warns).toEqual([])
  })
})
