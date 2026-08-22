import { describe, it, expect } from 'vitest'
import { isGlyphDiagnosticPayload, GLYPH_DIAGNOSTIC_MAX_BYTES } from '../../../src/shared/glyph-diagnostic'

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
