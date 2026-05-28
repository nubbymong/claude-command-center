import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
const css = readFileSync('src/renderer/styles.css', 'utf8')

describe('LogViewer transitions (U4.5)', () => {
  it('declares a .log-list-enter transition keyframe / class', () => {
    expect(css).toContain('log-list-enter')
  })
})
