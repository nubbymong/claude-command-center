import { describe, it, expect } from 'vitest'
import { isGlyphDiagnosticPayload, sanitizeGlyphDiagnosticPayload, GLYPH_DIAGNOSTIC_MAX_BYTES } from '../../../src/shared/glyph-diagnostic'

/**
 * Main treats the renderer's diagnostic as untrusted and re-checks its shape
 * before writing it (a compromised renderer must not steer the writer with a
 * malformed or unbounded blob). These pin what the validator accepts.
 */
const valid = () => ({
  capturedAt: '2026-08-22T09:00:00.000Z',
  appVersion: '2.1.0-beta.17',
  gpuRendering: true,
  gpuAdapter: 'ANGLE (NVIDIA RTX)',
  activeSessionId: 'sess-1',
  terminalCount: 2,
  atlas: { generation: 3, liveCount: 2, live: [{ label: 'sess-1', generation: 3, behind: 0 }], events: [] },
})

describe('isGlyphDiagnosticPayload', () => {
  it('accepts a well-formed payload, including null adapter / null session', () => {
    expect(isGlyphDiagnosticPayload(valid())).toBe(true)
    expect(isGlyphDiagnosticPayload({ ...valid(), gpuAdapter: null, activeSessionId: null })).toBe(true)
  })

  it('rejects non-objects and a missing/mistyped field', () => {
    for (const bad of [null, undefined, 'x', 42, []]) expect(isGlyphDiagnosticPayload(bad)).toBe(false)
    expect(isGlyphDiagnosticPayload({ ...valid(), capturedAt: 123 })).toBe(false)
    expect(isGlyphDiagnosticPayload({ ...valid(), gpuRendering: 'yes' })).toBe(false)
    expect(isGlyphDiagnosticPayload({ ...valid(), gpuAdapter: 5 })).toBe(false)
    expect(isGlyphDiagnosticPayload({ ...valid(), terminalCount: '2' })).toBe(false)
  })

  it('rejects a missing or malformed atlas block', () => {
    const { atlas: _drop, ...noAtlas } = valid()
    expect(isGlyphDiagnosticPayload(noAtlas)).toBe(false)
    expect(isGlyphDiagnosticPayload({ ...valid(), atlas: { generation: 1, liveCount: 1, live: 'x', events: [] } })).toBe(false)
    expect(isGlyphDiagnosticPayload({ ...valid(), atlas: { generation: 1, liveCount: 1, live: [], events: {} } })).toBe(false)
  })

  it('exposes a sane byte cap', () => {
    expect(GLYPH_DIAGNOSTIC_MAX_BYTES).toBeGreaterThan(10_000)
  })
})

describe('sanitizeGlyphDiagnosticPayload', () => {
  it('keeps only the known fields — an extra field is dropped', () => {
    const withExtra = { ...valid(), evil: { nested: [1, 2, 3] }, another: 'x' } as never
    const clean = sanitizeGlyphDiagnosticPayload(withExtra)
    expect(Object.keys(clean).sort()).toEqual(
      ['activeSessionId', 'appVersion', 'atlas', 'capturedAt', 'gpuAdapter', 'gpuRendering', 'terminalCount'].sort(),
    )
    expect((clean as Record<string, unknown>).evil).toBeUndefined()
  })

  it('flattens each atlas event to four primitives, so nesting cannot survive', () => {
    const evil = { ...valid(), atlas: { generation: 1, liveCount: 1, live: [], events: [
      { t: 1, kind: 'clear', label: 'A', generation: 1, junk: { deep: [[[[1]]]] } },
    ] } } as never
    const clean = sanitizeGlyphDiagnosticPayload(evil)
    expect(Object.keys(clean.atlas.events[0]).sort()).toEqual(['generation', 'kind', 'label', 't'])
    expect(JSON.stringify(clean)).not.toContain('junk')
  })

  it('caps the event and live arrays', () => {
    const flood = { ...valid(), atlas: {
      generation: 1, liveCount: 9999,
      live: Array.from({ length: 9999 }, () => ({ label: 'x', generation: 1, behind: 0 })),
      events: Array.from({ length: 9999 }, (_, i) => ({ t: i, kind: 'clear', label: 'x', generation: i })),
    } } as never
    const clean = sanitizeGlyphDiagnosticPayload(flood)
    expect(clean.atlas.events.length).toBeLessThanOrEqual(500)
    expect(clean.atlas.live.length).toBeLessThanOrEqual(200)
  })

  it('truncates over-long strings and coerces non-finite numbers', () => {
    const clean = sanitizeGlyphDiagnosticPayload({ ...valid(), gpuAdapter: 'a'.repeat(5000), terminalCount: Infinity } as never)
    expect((clean.gpuAdapter as string).length).toBeLessThanOrEqual(512)
    expect(clean.terminalCount).toBe(0)
  })

  it('preserves null adapter / null session', () => {
    const clean = sanitizeGlyphDiagnosticPayload({ ...valid(), gpuAdapter: null, activeSessionId: null } as never)
    expect(clean.gpuAdapter).toBeNull()
    expect(clean.activeSessionId).toBeNull()
  })
})
