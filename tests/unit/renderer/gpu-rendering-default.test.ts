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
 * GPU (WebGL) terminal rendering is **default ON** (owner decision 2026-08-22,
 * #374): on unless the user has explicitly turned it OFF. The shared-atlas
 * corruption is repaired the way a resize repairs it — a victim drops its OWN
 * render model first, then repaints (`atlasCoordinator` / `createAtlasResync`),
 * not the #312 refresh-the-others attempt that was disproved — so default-on is
 * safe, and an always-on atlas event ring + the Ctrl+Alt+G glyph capture exist
 * to catch any residual in the field.
 *
 * Two ways this regresses, so both are pinned:
 *   - the default flips back to false, or
 *   - a reader goes back to `=== true`, which treats UNSET as OFF and quietly
 *     disables it for everyone who has never touched the setting. Flipping the
 *     default alone does nothing while any reader still uses `=== true`.
 *
 * Behavioural, not a source-text grep: the hydration cases drive the REAL
 * `hydrate()` rather than re-spreading it, so a reversed merge order is caught.
 */
describe('GPU terminal rendering is default-on', () => {
  it('is ON by default', () => {
    expect(DEFAULT_TERMINAL_SETTINGS.gpuRendering).toBe(true)
    expect(gpuRenderingEnabled(DEFAULT_TERMINAL_SETTINGS)).toBe(true)
  })

  it('treats an unset value as ON (on unless explicitly off)', () => {
    expect(gpuRenderingEnabled({})).toBe(true)
    expect(gpuRenderingEnabled({ gpuRendering: undefined })).toBe(true)
    expect(gpuRenderingEnabled(undefined)).toBe(true)
  })

  it('is disabled only by a literal false', () => {
    expect(gpuRenderingEnabled({ gpuRendering: false })).toBe(false)
    expect(gpuRenderingEnabled({ gpuRendering: true })).toBe(true)
  })

  it('a non-boolean a corrupt config might hold falls to the ON default (only the boolean false opts out)', () => {
    for (const v of ['false', 'true', 0, 1, null, '', 'yes'] as unknown[]) {
      expect(gpuRenderingEnabled({ gpuRendering: v as boolean })).toBe(true)
    }
  })

  it('stays ON through hydrate() for a config that predates the field', () => {
    useSettingsStore.getState().hydrate({ terminal: { fontSize: 15 } } as never)
    const t = useSettingsStore.getState().settings.terminal
    expect(gpuRenderingEnabled(t)).toBe(true)
    // A genuine merge, not a wholesale replacement that would only look right
    // for this one field.
    expect(t.fontSize).toBe(15)
    expect(t.cursorStyle).toBe(DEFAULT_TERMINAL_SETTINGS.cursorStyle)
  })

  it('stays ON through hydrate() when there is no terminal block', () => {
    useSettingsStore.getState().hydrate({} as never)
    expect(gpuRenderingEnabled(useSettingsStore.getState().settings.terminal)).toBe(true)
  })

  it('honours a stored OFF through hydrate() — an explicit opt-out survives', () => {
    useSettingsStore.getState().hydrate({ terminal: { gpuRendering: false } } as never)
    expect(gpuRenderingEnabled(useSettingsStore.getState().settings.terminal)).toBe(false)
  })
})
