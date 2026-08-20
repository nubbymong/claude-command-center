import { describe, it, expect, vi } from 'vitest'
// hydrate() persists a one-time font migration; stub the writer so these tests
// touch no disk and no IPC.
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(async () => true) }))

import {
  DEFAULT_TERMINAL_SETTINGS,
  gpuRenderingEnabled,
  useSettingsStore,
} from '../../../src/renderer/stores/settingsStore'

/**
 * GPU (WebGL) terminal rendering is OPT-IN. Only a literal `true` enables it.
 *
 * `@xterm/addon-webgl` keeps ONE glyph atlas per process, and
 * `clearTextureAtlas()` wipes it for every terminal while calling
 * `_clearModel(true)` on only the caller. #312 tried to repair the others by
 * calling `term.refresh()` on them; an adversarial pass disproved it in a real
 * WebGL renderer, because `WebglRenderer._updateModel` skips every cell whose
 * contents have not changed, so a victim redraws stale vertices against the
 * emptied texture and goes blank. Until a repair is proven on real hardware,
 * unset must mean OFF.
 *
 * Two ways this regresses, so both are pinned:
 *   - the default flips to true, or
 *   - a reader goes back to `!== false`, which treats UNSET as ON and quietly
 *     re-enables it for everyone who has never touched the setting. That is the
 *     subtle one: flipping the default alone changes nothing while any reader
 *     still uses `!== false`.
 *
 * Behavioural, not a source-text grep. The guard this pattern replaced asserted
 * with `readFileSync` + a regex over TerminalView.tsx, which pins a SPELLING:
 * routing the comparison through a helper walks straight past it while green.
 * The hydration cases drive the REAL `hydrate()` rather than re-spreading it —
 * an earlier version rebuilt the merge inline and therefore tested a copy of
 * the code, letting a reversed spread order through unnoticed.
 */
describe('GPU terminal rendering is opt-in', () => {
  it('is OFF by default', () => {
    expect(DEFAULT_TERMINAL_SETTINGS.gpuRendering).toBe(false)
    expect(gpuRenderingEnabled(DEFAULT_TERMINAL_SETTINGS)).toBe(false)
  })

  it('treats an unset value as OFF', () => {
    expect(gpuRenderingEnabled({})).toBe(false)
    expect(gpuRenderingEnabled({ gpuRendering: undefined })).toBe(false)
    expect(gpuRenderingEnabled(undefined)).toBe(false)
  })

  it('enables only on a literal true', () => {
    expect(gpuRenderingEnabled({ gpuRendering: true })).toBe(true)
    expect(gpuRenderingEnabled({ gpuRendering: false })).toBe(false)
  })

  it('refuses a non-boolean that a corrupt or hand-edited config might hold', () => {
    // JSON is not type-checked on the way in. `!== false` would read every one
    // of these as ON, which is the failure mode this predicate exists to avoid.
    for (const v of ['false', 'true', 0, 1, null, '', 'yes'] as unknown[]) {
      expect(gpuRenderingEnabled({ gpuRendering: v as boolean })).toBe(false)
    }
  })

  it('stays OFF through hydrate() for a config that predates the field', () => {
    useSettingsStore.getState().hydrate({ terminal: { fontSize: 15 } } as never)
    const t = useSettingsStore.getState().settings.terminal
    expect(gpuRenderingEnabled(t)).toBe(false)
    // A genuine merge, not a wholesale replacement that would only look right
    // for this one field.
    expect(t.fontSize).toBe(15)
    expect(t.cursorStyle).toBe(DEFAULT_TERMINAL_SETTINGS.cursorStyle)
  })

  it('stays OFF through hydrate() when there is no terminal block', () => {
    useSettingsStore.getState().hydrate({} as never)
    expect(gpuRenderingEnabled(useSettingsStore.getState().settings.terminal)).toBe(false)
  })

  it('honours a stored ON through hydrate()', () => {
    // The opt-in half: someone who ticked the box keeps it, and the default
    // does not override them either.
    useSettingsStore.getState().hydrate({ terminal: { gpuRendering: true } } as never)
    expect(gpuRenderingEnabled(useSettingsStore.getState().settings.terminal)).toBe(true)
  })
})
