import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TERMINAL_SETTINGS,
  gpuRenderingEnabled,
  type TerminalSettings,
} from '../../../src/renderer/stores/settingsStore'

/**
 * GPU (WebGL) terminal rendering is ON unless the user turned it off.
 *
 * beta.16 shipped it OFF as containment: `@xterm/addon-webgl` keeps ONE glyph
 * atlas per process, and `clearTextureAtlas()` wiped it for every terminal while
 * repairing only the caller — so one session repainting blanked the glyphs of
 * every other open session. #312 fixed the cause (a process-wide coordinator
 * repaints the others on the next frame), so the containment is gone and the
 * default is back on.
 *
 * The load-bearing rule now is the one the owner asked for explicitly: **the
 * default moved, stored settings did not.** No migration rewrites anybody's
 * choice, so an install carrying `gpuRendering: false` stays on the DOM
 * renderer until its owner says otherwise. That is what these tests pin.
 *
 * Deliberately behavioural rather than a source-text grep. The guard this
 * replaces asserted with `readFileSync` + a regex over TerminalView.tsx and
 * SettingsPage.tsx, which pins a SPELLING, not a behaviour: reformatting the
 * comparison across two lines, or routing it through a helper, walks straight
 * past it while looking green. Both readers now call `gpuRenderingEnabled`, so
 * testing that function tests both of them.
 */
describe('GPU terminal rendering default', () => {
  it('is ON by default', () => {
    expect(DEFAULT_TERMINAL_SETTINGS.gpuRendering).toBe(true)
    expect(gpuRenderingEnabled(DEFAULT_TERMINAL_SETTINGS)).toBe(true)
  })

  it('treats an unset value as ON', () => {
    // A config written before the field existed, and the field explicitly absent.
    expect(gpuRenderingEnabled({})).toBe(true)
    expect(gpuRenderingEnabled({ gpuRendering: undefined })).toBe(true)
    expect(gpuRenderingEnabled(undefined)).toBe(true)
  })

  it('leaves a stored OFF alone — the default moved, the setting did not', () => {
    // The whole point. An install that persisted `false` (every install that ran
    // beta.16, plus anyone who turned it off deliberately) must keep it. If this
    // ever returns true, a release has silently re-enabled the renderer on
    // machines whose owner switched it off.
    expect(gpuRenderingEnabled({ gpuRendering: false })).toBe(false)
  })

  it('honours a stored ON', () => {
    expect(gpuRenderingEnabled({ gpuRendering: true })).toBe(true)
  })

  it('keeps a stored OFF across a hydration merge against the new default', () => {
    // hydrate() does `{ ...DEFAULT_TERMINAL_SETTINGS, ...(saved.terminal || {}) }`.
    // With the default now `true`, the saved value has to win that spread — this
    // is the exact composition that would silently flip a user back on if the
    // merge order were ever reversed.
    const saved: Partial<TerminalSettings> = { gpuRendering: false }
    const merged = { ...DEFAULT_TERMINAL_SETTINGS, ...saved }
    expect(merged.gpuRendering).toBe(false)
    expect(gpuRenderingEnabled(merged)).toBe(false)
  })

  it('adopts the new default for a saved config that predates the field', () => {
    const saved: Partial<TerminalSettings> = { fontSize: 15 }
    const merged = { ...DEFAULT_TERMINAL_SETTINGS, ...saved }
    expect(gpuRenderingEnabled(merged)).toBe(true)
  })
})
