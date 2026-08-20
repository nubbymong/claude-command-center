import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_TERMINAL_SETTINGS } from '../../../src/renderer/stores/settingsStore'

/**
 * GPU (WebGL) terminal rendering must stay OPT-IN.
 *
 * `@xterm/addon-webgl` keeps ONE glyph atlas per process — a module-level cache
 * keyed on font and colours, which every CCC terminal matches. Clearing it
 * repairs the caller and blanks the glyphs of every OTHER open terminal:
 * backgrounds intact, characters gone, until that terminal is resized, scrolled
 * or activated. With several sessions mounted (CCC keeps hidden ones alive) a
 * real machine sat blank most of the time.
 *
 * Two ways this regresses, so both are pinned:
 *   - the default flips back to true, or
 *   - a reader goes back to `!== false`, which treats UNSET as ON and quietly
 *     re-enables it for everyone who has never touched the setting. That is the
 *     subtle one: flipping the default alone would have changed nothing while
 *     any reader still used `!== false`.
 */
describe('GPU terminal rendering is opt-in', () => {
  it('is OFF by default', () => {
    expect(DEFAULT_TERMINAL_SETTINGS.gpuRendering).toBe(false)
  })

  it('is read as opt-IN everywhere, never as `!== false`', () => {
    const root = join(__dirname, '..', '..', '..', 'src', 'renderer')
    const readers = [
      join(root, 'components', 'TerminalView.tsx'),
      join(root, 'components', 'SettingsPage.tsx'),
    ]
    for (const file of readers) {
      const src = readFileSync(file, 'utf8')
      const lines = src.split('\n').filter((l) => l.includes('gpuRendering'))
      expect(lines.length, `${file} should still read gpuRendering`).toBeGreaterThan(0)
      for (const line of lines) {
        // `gpuRendering: e.target.checked` (the writer) is fine; readers are not.
        if (/gpuRendering\s*:/.test(line)) continue
        expect(line, `${file}: unset must not mean ON`).not.toMatch(/gpuRendering\s*!==\s*false/)
      }
      expect(src, `${file} should test for an explicit true`).toMatch(/gpuRendering\s*===\s*true/)
    }
  })
})
