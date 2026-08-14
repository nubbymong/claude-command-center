// @vitest-environment jsdom
//
// Host-boundary guards for the P3 bridge replies. The content frame can
// postMessage the host directly, so everything that reaches the review store
// or the overlay math must come through these: finite geometry, capped and
// control-stripped strings, chains bounded, resolutions pinned 1:1 to what
// was asked.

import { describe, it, expect } from 'vitest'
import { MAX_INSPECT_CHAIN } from '../../../src/shared/canvas'
import { safeAnchorResolutions, safeInspectResult } from '../../../src/renderer/utils/canvas-geometry-guard'

describe('safeInspectResult', () => {
  it('caps the chain, strips control characters, and finite-guards every number', () => {
    const entry = {
      role: 'but\u0000ton',
      name: 'Sa\u001fve',
      tag: 'button',
      uxId: 'ok-id',
      box: { x: Number.NaN, y: Infinity, width: -5, height: 10 },
      fingerprint: { role: 'button', name: 'Save', ancestorPath: 'a>b', ordinal: 2.9 },
    }
    const raw = { chain: Array.from({ length: MAX_INSPECT_CHAIN + 10 }, () => entry) }
    const out = safeInspectResult(raw)
    expect(out.chain).toHaveLength(MAX_INSPECT_CHAIN)
    expect(out.chain[0].role).toBe('button')
    expect(out.chain[0].name).toBe('Save')
    expect(out.chain[0].box).toEqual({ x: 0, y: 0, width: 0, height: 10 })
    expect(out.chain[0].fingerprint.ordinal).toBe(2)
  })

  it('answers garbage with an empty chain', () => {
    expect(safeInspectResult(null)).toEqual({ chain: [] })
    expect(safeInspectResult({ chain: 'not-an-array' })).toEqual({ chain: [] })
    expect(safeInspectResult(42)).toEqual({ chain: [] })
  })

  it('caps a runaway ordinal instead of storing it', () => {
    const out = safeInspectResult({
      chain: [
        {
          role: 'button',
          name: '',
          tag: 'button',
          box: { x: 0, y: 0, width: 1, height: 1 },
          fingerprint: { role: 'button', name: '', ancestorPath: '', ordinal: Number.MAX_SAFE_INTEGER },
        },
      ],
    })
    expect(out.chain[0].fingerprint.ordinal).toBe(1_000_000)
  })
})

describe('safeAnchorResolutions', () => {
  it('pads and trims to exactly what was asked — a page cannot add or shift entries', () => {
    const hit = { found: true, via: 'ux-id', box: { x: 1, y: 2, width: 3, height: 4 }, role: 'button', name: 'Save' }
    // Asked for 3; the page answered 1 real + garbage tail it hopes we take.
    const out = safeAnchorResolutions({ results: [hit, hit, hit, hit, hit] }, 3)
    expect(out).toHaveLength(3)
    // Asked for 2; the page answered nothing usable.
    expect(safeAnchorResolutions({ results: 'nope' }, 2)).toEqual([{ found: false }, { found: false }])
    expect(safeAnchorResolutions(null, 1)).toEqual([{ found: false }])
  })

  it('normalises a found entry and downgrades anything not exactly found:true', () => {
    const out = safeAnchorResolutions(
      {
        results: [
          { found: 'yes', via: 'ux-id' }, // truthy but not true → not found
          { found: true, via: 'weird', box: { x: Number.NaN }, role: 'r\u0007ole', name: 'n' },
        ],
      },
      2,
    )
    expect(out[0]).toEqual({ found: false })
    expect(out[1]).toMatchObject({ found: true, via: 'ux-id', role: 'role' })
    expect((out[1] as { box: { x: number } }).box.x).toBe(0)
  })
})
