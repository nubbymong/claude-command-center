import { describe, it, expect } from 'vitest'
import { DEFAULT_TERMINAL_SETTINGS } from '../../../src/renderer/stores/settingsStore'

describe('terminal font defaults (V2)', () => {
  it('defaults to bundled JetBrains Mono, weight 450, size 13', () => {
    expect(DEFAULT_TERMINAL_SETTINGS.fontFamily).toBe('JetBrains Mono')
    expect(DEFAULT_TERMINAL_SETTINGS.fontSize).toBe(13)
    expect(DEFAULT_TERMINAL_SETTINGS.fontWeight).toBe(450)
  })
})
