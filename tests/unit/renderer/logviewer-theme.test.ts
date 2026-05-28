// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { buildLogTheme } from '../../../src/renderer/components/LogViewer'

describe('LogViewer theme tokens (U4.1)', () => {
  it('derives background from --terminal-background or var(--surface-stage)', () => {
    document.documentElement.style.setProperty('--surface-stage', '#123456')
    document.documentElement.style.setProperty('--terminal-foreground', '#abcdef')
    const t = buildLogTheme()
    expect(t.background).toBe('#123456')
    expect(t.foreground).toBe('#abcdef')
  })
})
