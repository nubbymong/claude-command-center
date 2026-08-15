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
  const uxA = { kind: 'ux-id', id: 'save-button' } as const
  const fp = { kind: 'fingerprint', role: 'button', name: 'Save', ancestorPath: 'main>form', ordinal: 0 } as const
  const BOX = { x: 1, y: 2, width: 30, height: 40 }

  it('pads and trims to exactly what was asked — a page cannot add or shift entries', () => {
    const hit = { found: true, via: 'ux-id', uxId: uxA.id, box: BOX, role: 'button', name: 'Save' }
    // Asked for 3; the page answered 1 real + garbage tail it hopes we take.
    const out = safeAnchorResolutions({ results: [hit, hit, hit, hit, hit] }, [uxA, uxA, uxA])
    expect(out).toHaveLength(3)
    // Asked for 2; the page answered nothing usable.
    expect(safeAnchorResolutions({ results: 'nope' }, [uxA, uxA])).toEqual([{ found: false }, { found: false }])
    expect(safeAnchorResolutions(null, [uxA])).toEqual([{ found: false }])
  })

  it('accepts an honest reply for each anchor kind', () => {
    const out = safeAnchorResolutions(
      {
        results: [
          { found: true, via: 'ux-id', uxId: uxA.id, box: BOX, role: 'button', name: 'Save' },
          { found: true, via: 'fingerprint', box: BOX, role: 'button', name: 'Save' },
        ],
      },
      [uxA, fp],
    )
    expect(out[0]).toEqual({ found: true, via: 'ux-id', box: BOX, role: 'button', name: 'Save', uxId: uxA.id })
    expect(out[1]).toEqual({ found: true, via: 'fingerprint', box: BOX, role: 'button', name: 'Save' })
  })

  it('normalises a found entry and downgrades anything not exactly found:true', () => {
    const out = safeAnchorResolutions(
      {
        results: [
          { found: 'yes', via: 'ux-id', uxId: 'save-button', box: BOX }, // truthy but not true → not found
          { found: true, via: 'ux-id', uxId: 'save-button', box: { x: Number.NaN, y: 0, width: 30, height: 40 }, role: 'r\u0007ole', name: 'n' },
        ],
      },
      [uxA, uxA],
    )
    expect(out[0]).toEqual({ found: false })
    expect(out[1]).toMatchObject({ found: true, via: 'ux-id', role: 'role' })
    expect((out[1] as { box: { x: number } }).box.x).toBe(0)
  })
})

// ── The checklist's own trust boundary (adversarial review, 2026-08-14) ──────
// The re-anchor reply is written BY THE ARTIFACT UNDER REVIEW, and it decides
// what the resolution checklist tells the reviewer about their own open notes.
// Shape bounds alone let a page answer `found: true` to everything and point
// every highlight wherever it liked — the P3 acceptance criterion ("the
// checklist re-anchors at least 4 of 5") was entirely in the hands of the thing
// being reviewed. The host cannot measure a cross-origin page, so it checks the
// claim against the one thing it independently holds: the anchor it sent.
describe('a page cannot grade its own resolution checklist', () => {
  const uxA = { kind: 'ux-id', id: 'save-button' } as const
  const uxB = { kind: 'ux-id', id: 'cancel-button' } as const
  const fp = { kind: 'fingerprint', role: 'button', name: 'Save', ancestorPath: 'main>form', ordinal: 0 } as const
  const BOX = { x: 1, y: 2, width: 30, height: 40 }

  it('answering "found" to everything resolves nothing when the claims do not match the anchors', () => {
    const blanket = { found: true, via: 'ux-id', box: { x: 0, y: 0, width: 9999, height: 9999 }, role: 'x', name: 'y' }
    const out = safeAnchorResolutions({ results: [blanket, blanket, blanket] }, [
      uxB,
      fp,
      { kind: 'plan-step', id: 's1' },
    ])
    // uxB: the reply claims a different id (it echoes none, but the host names
    // the anchor). fp: answered with the wrong mechanism. plan-step: nothing in
    // a web page can resolve it at all.
    expect(out[1]).toEqual({ found: false })
    expect(out[2]).toEqual({ found: false })
  })

  it('rejects a ux-id match that names a different id — the shift attack, one slot over', () => {
    const out = safeAnchorResolutions(
      {
        results: [
          { found: true, via: 'ux-id', uxId: uxB.id, box: BOX, role: 'button', name: 'Cancel' },
          { found: true, via: 'ux-id', uxId: uxB.id, box: BOX, role: 'button', name: 'Cancel' },
        ],
      },
      [uxA, uxB],
    )
    expect(out[0]).toEqual({ found: false })
    expect(out[1]).toMatchObject({ found: true, uxId: uxB.id })
  })

  it('rejects a mechanism the anchor could not have resolved by', () => {
    const viaFp = { found: true, via: 'fingerprint', box: BOX, role: 'button', name: 'Save' }
    const viaId = { found: true, via: 'ux-id', uxId: uxA.id, box: BOX, role: 'button', name: 'Save' }
    expect(safeAnchorResolutions({ results: [viaFp] }, [uxA])[0]).toEqual({ found: false })
    expect(safeAnchorResolutions({ results: [viaId] }, [fp])[0]).toEqual({ found: false })
  })

  it('rejects a fingerprint match whose role/name are not the fingerprint we sent', () => {
    const out = safeAnchorResolutions(
      {
        results: [
          { found: true, via: 'fingerprint', box: BOX, role: 'link', name: 'Save' },
          { found: true, via: 'fingerprint', box: BOX, role: 'button', name: 'Delete' },
        ],
      },
      [fp, fp],
    )
    expect(out).toEqual([{ found: false }, { found: false }])
  })

  it('rejects a zero-area box: a "found" element that is nowhere is nowhere to point a reviewer', () => {
    const out = safeAnchorResolutions(
      {
        results: [
          { found: true, via: 'ux-id', uxId: uxA.id, box: { x: 5, y: 5, width: 0, height: 40 }, role: 'button', name: 'Save' },
          { found: true, via: 'ux-id', uxId: uxA.id, box: { x: 5, y: 5, width: 30, height: -3 }, role: 'button', name: 'Save' },
        ],
      },
      [uxA, uxA],
    )
    expect(out).toEqual([{ found: false }, { found: false }])
  })

  it('emits the identity the HOST holds, not the page’s echo of it', () => {
    const out = safeAnchorResolutions(
      {
        results: [
          // No uxId echoed at all: the host still names the anchor it asked about.
          { found: true, via: 'ux-id', box: BOX, role: 'button', name: 'Save' },
          // Fingerprint role/name are taken from OUR anchor, so a matched
          // fingerprint cannot smuggle a different identity through the fields
          // that name it.
          { found: true, via: 'fingerprint', box: BOX, role: 'button', name: 'Save' },
        ],
      },
      [uxA, fp],
    )
    expect(out[0]).toMatchObject({ uxId: uxA.id })
    expect(out[1]).toMatchObject({ role: fp.role, name: fp.name })
  })

  it('a legitimate re-anchor pass still comes back found', () => {
    // What the honest bridge produces: exact id match, exact fingerprint
    // role/name (its matcher requires equality), a real box.
    const out = safeAnchorResolutions(
      {
        results: [
          { found: true, via: 'ux-id', uxId: uxA.id, box: BOX, role: 'button', name: 'Save' },
          { found: false },
          { found: true, via: 'fingerprint', box: BOX, role: 'button', name: 'Save', uxId: 'other' },
        ],
      },
      [uxA, uxB, fp],
    )
    expect(out.map((r) => r.found)).toEqual([true, false, true])
  })
})
