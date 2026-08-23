// @vitest-environment jsdom
/**
 * The renderer half of the glyph capture (#374): buildGlyphDiagnostic assembles
 * the bundle from the always-on atlas ring + environment, and
 * captureGlyphDiagnostic hands it to main and never throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(async () => true) }))

import { atlasCoordinator } from '../../../src/renderer/components/terminal/atlasCoordinator'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'
import { buildGlyphDiagnostic, captureGlyphDiagnostic } from '../../../src/renderer/utils/glyphDiagnostic'

const captureGlyph = vi.fn(async () => ({ ok: true, jsonPath: 'C:/r/glyph-diagnostics/glyph-x.json', imagePath: 'C:/r/glyph-diagnostics/glyph-x.png' }))
;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '2.1.0-beta.17'

beforeEach(() => {
  captureGlyph.mockClear()
  ;(globalThis as any).window.electronAPI = { ...(globalThis as any).window?.electronAPI, diagnostics: { captureGlyph } }
})

describe('buildGlyphDiagnostic', () => {
  it('captures the atlas snapshot, version, gpu setting and active session', () => {
    useSettingsStore.getState().hydrate({ terminal: { gpuRendering: true } } as never)
    const reg = atlasCoordinator.register(() => {}, 'sess-live')
    try {
      const d = buildGlyphDiagnostic('sess-live', () => 1_700_000_000_000)
      expect(d.appVersion).toBe('2.1.0-beta.17')
      expect(d.gpuRendering).toBe(true)
      expect(d.activeSessionId).toBe('sess-live')
      expect(d.capturedAt).toBe(new Date(1_700_000_000_000).toISOString())
      expect(d.atlas.live.some((l) => l.label === 'sess-live')).toBe(true)
      expect(d.terminalCount).toBe(d.atlas.liveCount)
      // jsdom has no WebGL, so the adapter probe returns null rather than throwing.
      expect(d.gpuAdapter).toBeNull()
    } finally { reg() }
  })

  it('reflects an explicit GPU opt-out (post-migration)', () => {
    // Guard set so the #374 default-on migration does not flip it back on.
    useSettingsStore.getState().hydrate({ terminal: { gpuRendering: false }, gpuDefaultOnMigrated: true } as never)
    expect(buildGlyphDiagnostic(null).gpuRendering).toBe(false)
  })
})

describe('captureGlyphDiagnostic', () => {
  it('forwards the assembled payload to main and returns its result', async () => {
    const r = await captureGlyphDiagnostic('sess-1')
    expect(captureGlyph).toHaveBeenCalledTimes(1)
    const sent = captureGlyph.mock.calls[0][0] as { appVersion: string; atlas: unknown }
    expect(sent.appVersion).toBe('2.1.0-beta.17')
    expect(sent.atlas).toBeDefined()
    expect(r.ok).toBe(true)
  })

  it('never throws when the diagnostics API is missing', async () => {
    ;(globalThis as any).window.electronAPI = {}
    const r = await captureGlyphDiagnostic('sess-1')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unavailable/)
  })

  it('surfaces a main-side failure without throwing', async () => {
    captureGlyph.mockImplementationOnce(async () => ({ ok: false, error: 'payload too large' }))
    const r = await captureGlyphDiagnostic('sess-1')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('payload too large')
  })
})
