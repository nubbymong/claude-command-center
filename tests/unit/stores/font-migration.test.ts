import { describe, it, expect } from 'vitest'
import { migrateV2Font, DEFAULT_SETTINGS, type AppSettings } from '../../../src/renderer/stores/settingsStore'

const base = (overrides: Partial<AppSettings>): AppSettings => ({ ...DEFAULT_SETTINGS, ...overrides })

describe('migrateV2Font (V2 terminal-font default migration)', () => {
  it('moves the old default Cascadia Code/14 -> JetBrains Mono/13 once', () => {
    const input = base({
      terminal: { ...DEFAULT_SETTINGS.terminal, fontFamily: 'Cascadia Code', fontSize: 14 },
      terminalFontSize: 14,
    })
    const { settings, changed } = migrateV2Font(input)
    expect(changed).toBe(true)
    expect(settings.terminal.fontFamily).toBe('JetBrains Mono')
    expect(settings.terminal.fontSize).toBe(13)
    expect(settings.terminalFontSize).toBe(13)
    expect(settings.fontMigratedV2).toBe(true)
  })

  it('leaves a user-chosen non-default font untouched, but sets the guard', () => {
    const input = base({
      terminal: { ...DEFAULT_SETTINGS.terminal, fontFamily: 'Berkeley Mono', fontSize: 16 },
      terminalFontSize: 16,
    })
    const { settings, changed } = migrateV2Font(input)
    expect(changed).toBe(true)
    expect(settings.terminal.fontFamily).toBe('Berkeley Mono')
    expect(settings.terminal.fontSize).toBe(16)
    expect(settings.terminalFontSize).toBe(16)
    expect(settings.fontMigratedV2).toBe(true)
  })

  it('does not re-migrate once the guard is set (re-picking Cascadia is respected)', () => {
    const input = base({
      fontMigratedV2: true,
      terminal: { ...DEFAULT_SETTINGS.terminal, fontFamily: 'Cascadia Code', fontSize: 14 },
      terminalFontSize: 14,
    })
    const { settings, changed } = migrateV2Font(input)
    expect(changed).toBe(false)
    expect(settings.terminal.fontFamily).toBe('Cascadia Code')
    expect(settings.terminal.fontSize).toBe(14)
  })

  it('migrates an old-default font even if the size was customized', () => {
    const input = base({
      terminal: { ...DEFAULT_SETTINGS.terminal, fontFamily: 'Cascadia Code', fontSize: 16 },
      terminalFontSize: 16,
    })
    const { settings } = migrateV2Font(input)
    expect(settings.terminal.fontFamily).toBe('JetBrains Mono')
    expect(settings.terminal.fontSize).toBe(16) // custom size preserved
  })
})
