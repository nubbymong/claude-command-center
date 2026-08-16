// @vitest-environment jsdom
//
// Host-boundary guards for the P3 bridge replies. The content frame can
// postMessage the host directly, so everything that reaches the review store
// or the overlay math must come through these: finite geometry, capped and
// control-stripped strings, chains bounded, resolutions pinned 1:1 to what
// was asked.

import { describe, it, expect } from 'vitest'
import { MAX_INSPECT_CHAIN } from '../../../src/shared/canvas'
import { safeAnchorResolutions, safeHit, safeInspectResult } from '../../../src/renderer/utils/canvas-geometry-guard'

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

// ── The format class, not just C0 (adversarial review, 2026-08-15) ───────────
// The guard stripped C0 and DEL and left the whole bidi family standing:
// overrides, embeddings, isolates and marks rode through `storableString` into
// `focus.label`, the focus chip on the stage, the notes panel and the
// `canvas_review` payload the agent is handed. A single RIGHT-TO-LEFT OVERRIDE
// reverses the rest of the line it sits in — so the label the reviewer reads is
// not the label that was stored, and the text sent to the agent is not the text
// a person was shown. Same expression the snapshot serialiser already used on
// its wire strings; this was the one page-authored path still on the old class.
describe('page-authored strings shed the whole format class', () => {
  /** Written as code points so this file never carries an invisible character. */
  const NUL = String.fromCodePoint(0x0000)
  const NEL = String.fromCodePoint(0x0085) // C1
  const SHY = String.fromCodePoint(0x00ad) // soft hyphen
  const ALM = String.fromCodePoint(0x061c) // arabic letter mark
  const ZWSP = String.fromCodePoint(0x200b)
  const RLM = String.fromCodePoint(0x200f) // right-to-left mark
  const LRE = String.fromCodePoint(0x202a) // left-to-right embedding
  const PDF = String.fromCodePoint(0x202c) // pop directional formatting
  const RLO = String.fromCodePoint(0x202e) // right-to-left override
  const LRI = String.fromCodePoint(0x2066) // left-to-right isolate
  const PDI = String.fromCodePoint(0x2069) // pop directional isolate
  const LSEP = String.fromCodePoint(0x2028) // line separator
  const PSEP = String.fromCodePoint(0x2029) // paragraph separator
  const BOM = String.fromCodePoint(0xfeff)
  const EVERY = NUL + NEL + SHY + ALM + ZWSP + RLM + LRE + PDF + RLO + LRI + PDI + LSEP + PSEP + BOM

  const uxA = { kind: 'ux-id', id: 'save-button' } as const
  const BOX = { x: 1, y: 2, width: 30, height: 40 }

  it('strips them out of an inspect chain — every field the store will hold', () => {
    const out = safeInspectResult({
      chain: [
        {
          role: `but${RLO}ton`,
          name: `Sa${LRI}ve${PDI}`,
          tag: `but${ZWSP}ton`,
          uxId: `save${RLM}-button`,
          box: BOX,
          fingerprint: {
            role: `but${SHY}ton`,
            name: `Sa${BOM}ve`,
            ancestorPath: `main${LSEP}>form`,
            ordinal: 1,
          },
        },
      ],
    })
    const entry = out.chain[0]
    expect(entry.role).toBe('button')
    expect(entry.name).toBe('Save')
    expect(entry.tag).toBe('button')
    expect(entry.uxId).toBe('save-button')
    expect(entry.fingerprint.role).toBe('button')
    expect(entry.fingerprint.name).toBe('Save')
    expect(entry.fingerprint.ancestorPath).toBe('main>form')
  })

  it('leaves not one of the class in a stored string', () => {
    const out = safeInspectResult({
      chain: [
        {
          role: `a${EVERY}b`,
          name: '',
          tag: '',
          box: BOX,
          fingerprint: { role: '', name: '', ancestorPath: '', ordinal: 0 },
        },
      ],
    })
    expect(out.chain[0].role).toBe('ab')
  })

  it('strips them from a resolution before the checklist renders it', () => {
    const out = safeAnchorResolutions(
      { results: [{ found: true, via: 'ux-id', uxId: uxA.id, box: BOX, role: `but${RLO}ton`, name: `Sa${RLO}ve` }] },
      [uxA],
    )
    expect(out[0]).toMatchObject({ found: true, role: 'button', name: 'Save' })
  })

  it('strips them from the transient hover readout too — the chip that carries the marker', () => {
    // Not stored, but it is where the `page-reported` attribution is printed,
    // and an override inside the name reorders the line it sits on.
    const hit = safeHit({
      role: `but${RLO}ton`,
      name: `Sa${LRE}ve${PDF}`,
      tag: `but${ZWSP}ton`,
      uxId: `save${ALM}-button`,
      box: { x: 0, y: 0, width: 1, height: 1 },
    })
    expect(hit.role).toBe('button')
    expect(hit.name).toBe('Save')
    expect(hit.tag).toBe('button')
    expect(hit.uxId).toBe('save-button')
  })

  // ── …on BOTH sides of every equality (adversarial re-attack, 2026-08-15) ───
  // Cleaning only the value on the way IN broke re-anchoring: the content side
  // recomputes a live name and this host checks it against the stored anchor
  // for exact equality, so a class stripped here and not there made a present,
  // unchanged element read as "needs re-pointing" forever. The content side now
  // mints its values with the same `canvasPageText` call
  // (src/main/canvas/bridge/anchors.ts); this half runs the anchor through it
  // too, so an anchor stored before the host cleaned at all still resolves.
  it('matches an anchor stored BEFORE the clean against an honest, cleaned reply', () => {
    const legacy = { kind: 'fingerprint', role: `but${RLO}ton`, name: `Sa${ZWSP}ve`, ancestorPath: 'main>form', ordinal: 0 } as const
    const honest = { found: true, via: 'fingerprint', box: BOX, role: 'button', name: 'Save' }
    const out = safeAnchorResolutions({ results: [honest] }, [legacy])
    // Found — and named with the host's own cleaned copy, not the page's echo.
    expect(out[0]).toMatchObject({ found: true, via: 'fingerprint', role: 'button', name: 'Save' })
  })

  it('matches a legacy ux-id anchor the same way', () => {
    const legacy = { kind: 'ux-id', id: `save${ZWSP}-button` } as const
    const honest = { found: true, via: 'ux-id', uxId: 'save-button', box: BOX, role: 'button', name: 'Save' }
    expect(safeAnchorResolutions({ results: [honest] }, [legacy])[0]).toMatchObject({ found: true, uxId: 'save-button' })
  })

  it('still refuses a reply that does not CARRY the fields, even for an empty role or name', () => {
    // An element with no role has an empty one in its fingerprint, and a
    // missing field must not read as a match for it just because both clean to
    // the empty string.
    const empty = { kind: 'fingerprint', role: '', name: '', ancestorPath: 'main', ordinal: 0 } as const
    expect(safeAnchorResolutions({ results: [{ found: true, via: 'fingerprint', box: BOX }] }, [empty])[0]).toEqual({
      found: false,
    })
    expect(
      safeAnchorResolutions({ results: [{ found: true, via: 'fingerprint', box: BOX, role: '', name: '' }] }, [empty])[0],
    ).toMatchObject({ found: true })
  })

  it('does not eat ordinary text a page might legitimately label with', () => {
    const name = 'Enregistrer — 保存 · ✓'
    const out = safeInspectResult({
      chain: [
        {
          role: 'button',
          name,
          tag: 'button',
          box: BOX,
          fingerprint: { role: 'button', name, ancestorPath: 'main>form', ordinal: 0 },
        },
      ],
    })
    expect(out.chain[0].name).toBe(name)
    expect(out.chain[0].fingerprint.name).toBe(name)
  })
})
