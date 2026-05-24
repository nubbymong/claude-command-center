// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { getTerminalTheme } from '../../../src/renderer/components/terminal/terminalTheme'

afterEach(() => { document.documentElement.style.cssText = '' })

describe('getTerminalTheme', () => {
  it('reads background from --surface-stage', () => {
    document.documentElement.style.setProperty('--surface-stage', '#123456')
    expect(getTerminalTheme().background).toBe('#123456')
  })
  it('reads foreground from --terminal-foreground', () => {
    document.documentElement.style.setProperty('--terminal-foreground', '#abcdef')
    expect(getTerminalTheme().foreground).toBe('#abcdef')
  })
  it('maps ansi red to --status-danger', () => {
    document.documentElement.style.setProperty('--status-danger', '#ff0000')
    expect(getTerminalTheme().red).toBe('#ff0000')
  })
  it('honors a user terminal-background override when provided', () => {
    document.documentElement.style.setProperty('--surface-stage', '#111111')
    expect(getTerminalTheme('#00ff00').background).toBe('#00ff00')
  })
})
