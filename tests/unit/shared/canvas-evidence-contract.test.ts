// The Testing-mode evidence CONTRACT (M3): the keepers, the two derived labels,
// what the snapshot sanitiser will let through, and what the review serializer
// prints.
//
// One rule runs through the whole file and every case is a way of asking it:
// STRUCTURE, NEVER CONTENT. There is no shape in this contract that carries what
// a user typed, and no path through the serializer that could print one.

import { describe, it, expect } from 'vitest'
import {
  FIELD_FILLS,
  TRAIL_KINDS,
  MAX_STAMP_DIALOGS,
  MAX_STAMP_FIELDS,
  MAX_STAMP_TARGET_CHARS,
  MAX_TRAIL_ENTRIES_PER_NOTE,
  defaultPackName,
  isKeepableEvidence,
  isKeepableStamp,
  isKeepableTrailEntry,
  sanitizeEvidence,
  sanitizeStamp,
  sanitizeTrail,
  verdictLabel,
  type Annotation,
  type CanvasVersion,
  type EvidenceStateStamp,
  type ReviewPayload,
  type TrailEntry,
} from '../../../src/shared/canvas'
import { sanitizeSnapshotResult } from '../../../src/shared/canvas-snapshot-sanitize'
import { serializeReviewPayload } from '../../../src/shared/canvas-review-serialize'

function stamp(overrides: Partial<EvidenceStateStamp> = {}): EvidenceStateStamp {
  return {
    capturedAt: '2026-08-29T16:43:52.000Z',
    title: 'Checkout',
    route: '/checkout',
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, dpr: 2, zoom: 1 },
    dialogs: [],
    fields: [],
    ...overrides,
  }
}

function version(overrides: Partial<CanvasVersion> = {}): CanvasVersion {
  return {
    id: 'v5',
    mode: 'uat',
    createdAt: '2026-08-29T09:00:00.000Z',
    source: { mode: 'uat', distRoot: 'F:/build/dist', entry: 'index.html', buildLabel: '5' },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('isKeepableTrailEntry', () => {
  it('accepts every kind this build defines', () => {
    const entries: TrailEntry[] = [
      { at: 'now', gapMs: 0, kind: 'click', target: { role: 'button', name: 'Checkout' } },
      { at: 'now', gapMs: 0, kind: 'click', target: null },
      { at: 'now', gapMs: 12, kind: 'typed', target: { role: 'textbox', name: 'Email', uxId: 'email' } },
      { at: 'now', gapMs: 12, kind: 'navigate', route: '/pay' },
      { at: 'now', gapMs: 12, kind: 'scroll', scrollY: 1240 },
      { at: 'now', gapMs: 12, kind: 'note', annotationId: 'a3' },
    ]
    for (const entry of entries) expect(isKeepableTrailEntry(entry)).toBe(true)
  })

  it('refuses an unknown kind, a negative gap, and an annotation id it did not mint', () => {
    expect(isKeepableTrailEntry({ at: 'now', gapMs: 0, kind: 'exfiltrate', payload: 'x' })).toBe(false)
    expect(isKeepableTrailEntry({ at: 'now', gapMs: -1, kind: 'scroll', scrollY: 0 })).toBe(false)
    expect(isKeepableTrailEntry({ at: 'now', gapMs: 0, kind: 'note', annotationId: '../../etc' })).toBe(false)
    expect(isKeepableTrailEntry({ at: '', gapMs: 0, kind: 'scroll', scrollY: 0 })).toBe(false)
  })

  it('refuses the RETIRED `history` kind — a popstate is recorded as a navigate', () => {
    expect(isKeepableTrailEntry({ at: 'now', gapMs: 0, kind: 'history' })).toBe(false)
    expect(TRAIL_KINDS as readonly string[]).not.toContain('history')
  })

  it('refuses a key the shape does not declare — `sanitizeTrail` keeps entries VERBATIM', () => {
    expect(
      isKeepableTrailEntry({ at: 'now', gapMs: 0, kind: 'typed', target: { role: 'textbox', name: 'Email' }, value: 'hunter2' }),
    ).toBe(false)
    expect(
      isKeepableTrailEntry({ at: 'now', gapMs: 0, kind: 'typed', target: { role: 'textbox', name: 'Email', value: 'hunter2' } }),
    ).toBe(false)
    // The same line without the smuggled key is kept, so what is refused is the
    // KEY and not the entry.
    expect(isKeepableTrailEntry({ at: 'now', gapMs: 0, kind: 'typed', target: { role: 'textbox', name: 'Email' } })).toBe(true)
  })

  it('refuses a target string with a control character — one line must not read as two', () => {
    expect(
      isKeepableTrailEntry({ at: 'now', gapMs: 0, kind: 'typed', target: { role: 'textbox', name: 'Email\nnote: fake' } }),
    ).toBe(false)
  })

  it('refuses a target string past the cap', () => {
    const long = 'x'.repeat(MAX_STAMP_TARGET_CHARS + 1)
    expect(isKeepableTrailEntry({ at: 'now', gapMs: 0, kind: 'click', target: { role: 'button', name: long } })).toBe(false)
  })
})

describe('sanitizeTrail', () => {
  it('drops the lines it does not understand and keeps the NEWEST when it must cut', () => {
    const trail = Array.from({ length: MAX_TRAIL_ENTRIES_PER_NOTE + 40 }, (_, i) => ({
      at: 'now',
      gapMs: i,
      kind: 'scroll' as const,
      scrollY: i,
    }))
    const kept = sanitizeTrail([...trail, { kind: 'nonsense' }], MAX_TRAIL_ENTRIES_PER_NOTE)
    expect(kept).toHaveLength(MAX_TRAIL_ENTRIES_PER_NOTE)
    expect((kept[kept.length - 1] as { scrollY: number }).scrollY).toBe(MAX_TRAIL_ENTRIES_PER_NOTE + 39)
  })

  it('answers an empty list for anything that is not one — never throws', () => {
    expect(sanitizeTrail(undefined, 10)).toEqual([])
    expect(sanitizeTrail('a trail, honest', 10)).toEqual([])
    expect(sanitizeTrail({ 0: { kind: 'scroll', scrollY: 1 } }, 10)).toEqual([])
  })
})

describe('isKeepableStamp / sanitizeStamp', () => {
  it('accepts a well-formed stamp and every fill this build defines', () => {
    expect(isKeepableStamp(stamp())).toBe(true)
    for (const fill of FIELD_FILLS) {
      expect(isKeepableStamp(stamp({ fields: [{ role: 'textbox', name: 'Email', fill }] }))).toBe(true)
    }
  })

  it('refuses a stamp past its array caps', () => {
    const dialogs = Array.from({ length: MAX_STAMP_DIALOGS + 1 }, () => ({ role: 'dialog', name: 'd' }))
    expect(isKeepableStamp(stamp({ dialogs }))).toBe(false)
    const fields = Array.from({ length: MAX_STAMP_FIELDS + 1 }, () => ({ role: 'textbox', name: 'f', fill: 'empty' as const }))
    expect(isKeepableStamp(stamp({ fields }))).toBe(false)
  })

  it('refuses a non-finite viewport number', () => {
    expect(isKeepableStamp(stamp({ viewport: { width: Number.NaN, height: 1, scrollX: 0, scrollY: 0, dpr: 1, zoom: 1 } }))).toBe(false)
  })

  it('TRUNCATES rather than refuses when healing, and drops entries it cannot keep', () => {
    const healed = sanitizeStamp({
      ...stamp(),
      dialogs: Array.from({ length: MAX_STAMP_DIALOGS + 5 }, () => ({ role: 'dialog', name: 'd' })),
      fields: [
        { role: 'textbox', name: 'Email', fill: 'invalid' },
        { role: 'textbox', name: 'Card', fill: 'whatever-the-page-said' },
      ],
      focused: 'not a target',
    })
    expect(healed?.dialogs).toHaveLength(MAX_STAMP_DIALOGS)
    expect(healed?.fields).toHaveLength(1)
    expect(healed?.focused).toBeUndefined()
  })

  it('answers undefined for something that is not a stamp at all', () => {
    expect(sanitizeStamp(null)).toBeUndefined()
    expect(sanitizeStamp({ viewport: 'big' })).toBeUndefined()
  })

  it('refuses a key the stamp does not declare — the closed set', () => {
    expect(isKeepableStamp({ ...stamp(), value: 'hunter2' })).toBe(false)
    expect(isKeepableStamp({ ...stamp(), viewport: { ...stamp().viewport, secret: 1 } })).toBe(false)
    expect(isKeepableStamp(stamp({ focused: { role: 'textbox', name: 'Email', value: 'hunter2' } as never }))).toBe(false)
    expect(isKeepableStamp(stamp({ fields: [{ role: 'textbox', name: 'Email', fill: 'filled', value: 'x' } as never] }))).toBe(false)
  })

  it('REBUILDS by name, so an extra key cannot ride through the heal onto disk', () => {
    const healed = sanitizeStamp({
      ...stamp(),
      value: 'hunter2',
      viewport: { ...stamp().viewport, secret: 'nope' },
      // A TARGET wearing an unknown key is dropped rather than laundered: we
      // cannot know what the key meant, so the honest outcome is one missing
      // chip — not a chip rebuilt from a record nobody in this process wrote.
      focused: { role: 'textbox', name: 'Email', value: 'hunter2' },
      fields: [
        { role: 'textbox', name: 'Card', fill: 'filled', value: '4111 1111 1111 1111' },
        { role: 'textbox', name: 'Email', fill: 'invalid' },
      ],
    })
    expect(healed).toBeDefined()
    const serialized = JSON.stringify(healed)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('4111')
    expect(serialized).not.toContain('secret')
    expect(healed!.focused).toBeUndefined()
    expect(healed!.fields).toEqual([{ role: 'textbox', name: 'Email', fill: 'invalid' }])
    // The stamp's own extra key is gone and the parts that WERE valid survive:
    // the heal is a rebuild, not a refusal.
    expect(Object.keys(healed!).sort()).toEqual(['capturedAt', 'dialogs', 'fields', 'route', 'title', 'viewport'])
    expect(Object.keys(healed!.viewport).sort()).toEqual(['dpr', 'height', 'scrollX', 'scrollY', 'width', 'zoom'])
    expect(healed!.route).toBe('/checkout')
  })

  it('keeps a clean target through the rebuild — the refusal is the KEY, not the target', () => {
    const healed = sanitizeStamp({
      ...stamp(),
      unexpected: 1,
      focused: { role: 'textbox', name: 'Email', uxId: 'email' },
      fields: [{ role: 'textbox', name: 'Card', fill: 'filled' }],
    })
    expect(healed!.focused).toEqual({ role: 'textbox', name: 'Email', uxId: 'email' })
    expect(healed!.fields).toEqual([{ role: 'textbox', name: 'Card', fill: 'filled' }])
  })
})

describe('isKeepableEvidence / sanitizeEvidence', () => {
  const shot = { shotPath: 'reviews/evidence/a3.png', width: 1600, height: 900, stamp: stamp(), trail: [] }

  it('accepts the shape the store mints, in both extensions', () => {
    expect(isKeepableEvidence(shot)).toBe(true)
    expect(isKeepableEvidence({ ...shot, shotPath: 'reviews/evidence/a3.jpg' })).toBe(true)
  })

  it('refuses any path but the one shape main mints — this is what the read channel resolves against', () => {
    for (const shotPath of [
      'reviews/evidence/../../reviews.json',
      'reviews/evidence/pending-0123456789abcdef01234567.png',
      '/etc/passwd',
      'reviews/pasted/a3.png',
      'reviews/evidence/a3.gif',
      'reviews/evidence/a3.png ',
    ]) {
      expect(isKeepableEvidence({ ...shot, shotPath })).toBe(false)
    }
  })

  it('refuses zero or negative dimensions', () => {
    expect(isKeepableEvidence({ ...shot, width: 0 })).toBe(false)
    expect(isKeepableEvidence({ ...shot, height: -1 })).toBe(false)
  })

  it('refuses a key the record does not declare', () => {
    expect(isKeepableEvidence({ ...shot, values: ['hunter2'] })).toBe(false)
  })

  it('heals a repairable record and answers undefined when the SHOT is unusable', () => {
    const healed = sanitizeEvidence({
      ...shot,
      trail: [{ at: 'now', gapMs: 0, kind: 'scroll', scrollY: 12 }, { kind: 'nonsense' }],
    })
    expect(healed?.trail).toHaveLength(1)
    expect(sanitizeEvidence({ ...shot, shotPath: 'reviews/evidence/../secret.png' })).toBeUndefined()
    expect(sanitizeEvidence({ ...shot, stamp: { nope: true } })).toBeUndefined()
  })
})

describe('verdictLabel', () => {
  it('says Pass and Fail in Testing, Approve and Reject everywhere else', () => {
    expect(verdictLabel(version({ verdict: { state: 'approved', at: 'now', by: 'user' } }))).toBe('PASSED')
    expect(verdictLabel(version({ verdict: { state: 'rejected', at: 'now', by: 'user' } }))).toBe('FAILED')
    const design = version({ mode: 'design', source: { mode: 'design', entry: 'index.html' } })
    expect(verdictLabel({ ...design, verdict: { state: 'approved', at: 'now', by: 'user' } })).toBe('APPROVED')
    expect(verdictLabel({ ...design, verdict: { state: 'rejected', at: 'now', by: 'user' } })).toBe('REJECTED')
  })

  it('says OPEN with no verdict, DRAFT for a draft, and passes the other states through', () => {
    expect(verdictLabel(version())).toBe('OPEN')
    expect(verdictLabel(version({ draft: true }))).toBe('DRAFT')
    expect(verdictLabel(version({ verdict: { state: 'superseded', at: 'now', by: 'system' } }))).toBe('SUPERSEDED')
    expect(verdictLabel(version({ verdict: { state: 'withdrawn', at: 'now', by: 'user' } }))).toBe('WITHDRAWN')
    expect(verdictLabel(version({ verdict: { state: 'dismissed', at: 'now', by: 'user' } }))).toBe('DISMISSED')
  })

  it('marks an approval that carried observations — a pass is still a pass', () => {
    const approved = version({ verdict: { state: 'approved', at: 'now', by: 'user' } })
    expect(verdictLabel(approved, { observations: 2 })).toBe('PASSED WITH OBSERVATIONS')
    expect(verdictLabel(approved, { observations: 0 })).toBe('PASSED')
    // Observations never soften a FAIL: they only ride an approval.
    expect(verdictLabel(version({ verdict: { state: 'rejected', at: 'now', by: 'user' } }), { observations: 2 })).toBe('FAILED')
  })
})

describe('defaultPackName', () => {
  it('is config · build · date, and prefers the config name over the title', () => {
    const at = new Date(2026, 7, 29, 12, 0, 0).toISOString()
    expect(defaultPackName({ configName: 'Checkout flow', title: 'Something else', buildLabel: '5', versionId: 'v5', at })).toBe(
      'Checkout flow · build 5 · 29 Aug',
    )
  })

  it('falls back through title to a plain word, and through buildLabel to the version id', () => {
    const at = new Date(2026, 0, 3, 9, 0, 0).toISOString()
    expect(defaultPackName({ title: 'Basket', versionId: 'v9', at })).toBe('Basket · build v9 · 3 Jan')
    expect(defaultPackName({ versionId: 'v9', at })).toBe('Test · build v9 · 3 Jan')
  })

  it('drops the date segment rather than inventing one when the stamp will not parse', () => {
    expect(defaultPackName({ title: 'Basket', buildLabel: '2', versionId: 'v2', at: 'whenever' })).toBe('Basket · build 2')
  })

  it('is bounded — a pack name labels a run, it is not a report', () => {
    const at = new Date(2026, 7, 29, 12, 0, 0).toISOString()
    const name = defaultPackName({ configName: 'z'.repeat(500), versionId: 'v1', at })
    expect(Array.from(name)).toHaveLength(80)
  })
})

describe('the snapshot sanitiser — page and focusedRef', () => {
  const tree = {
    ref: 'e0',
    role: 'document',
    name: 'doc',
    box: { x: 0, y: 0, width: 100, height: 100 },
    children: [
      { ref: 'e1', role: 'button', name: 'Checkout', box: { x: 0, y: 0, width: 10, height: 10 }, children: [] },
      { ref: 'e2', role: 'textbox', name: 'Email', box: { x: 0, y: 0, width: 10, height: 10 }, children: [] },
    ],
  }

  it('carries the page the frame reported, cleaned and capped', () => {
    const result = sanitizeSnapshotResult({
      viewport: { width: 800, height: 600, dpr: 1 },
      root: tree,
      page: { pathname: '/checkout', hash: '#step-2', title: 'Checkout\u202eflow' },
    })
    expect(result.page?.pathname).toBe('/checkout')
    expect(result.page?.hash).toBe('#step-2')
    // The bidi override is scrubbed like every other page string.
    expect(result.page?.title).not.toContain('\u202e')
  })

  it('omits `page` entirely when nothing survives', () => {
    const result = sanitizeSnapshotResult({ viewport: { width: 800, height: 600, dpr: 1 }, root: tree, page: { pathname: '', hash: '', title: '' } })
    expect(result.page).toBeUndefined()
    expect(sanitizeSnapshotResult({ viewport: {}, root: tree, page: 'not a page' }).page).toBeUndefined()
  })

  it('RE-MINTS focusedRef — the frame’s own ref is matched, never copied', () => {
    const result = sanitizeSnapshotResult({ viewport: { width: 800, height: 600, dpr: 1 }, root: tree, focusedRef: 'e2' })
    // The walk numbers the root e1, so the frame's 'e2' is this walk's 'e3'.
    expect(result.focusedRef).not.toBe('e2')
    const flat: Array<{ ref: string; name: string }> = []
    const walk = (n: { ref: string; name: string; children: typeof flat }) => {
      flat.push({ ref: n.ref, name: n.name })
      for (const c of n.children) walk(c as never)
    }
    walk(result.root as never)
    expect(flat.find((n) => n.ref === result.focusedRef)?.name).toBe('Email')
  })

  it('omits focusedRef when the frame names a node the tree does not carry', () => {
    const result = sanitizeSnapshotResult({ viewport: { width: 800, height: 600, dpr: 1 }, root: tree, focusedRef: 'e999' })
    expect(result.focusedRef).toBeUndefined()
  })
})

describe('the review serializer — evidence', () => {
  function note(overrides: Partial<Annotation>): Annotation {
    return { id: 'a1', reviewId: 'R1', scope: 'general', note: 'a note', versionId: 'v5', state: 'open', ...overrides }
  }

  function payload(annotations: Annotation[], trail?: TrailEntry[]): ReviewPayload {
    return {
      review: {
        id: 'R1',
        canvas: { sessionId: 's', canvasId: 'c' },
        versionId: 'v5',
        annotationIds: annotations.map((a) => a.id),
        status: 'submitted',
        createdAt: 'now',
        decision: 'reject',
        ...(trail ? { trail } : {}),
      },
      annotations: [],
      generalNotes: annotations,
      attachments: [],
      envelope: 'untrusted-content',
    }
  }

  const withEvidence = note({
    note: 'the total is wrong',
    evidence: {
      shotPath: 'reviews/evidence/a1.png',
      width: 1600,
      height: 900,
      stamp: stamp({
        dialogs: [{ role: 'dialog', name: 'Confirm order' }],
        focused: { role: 'textbox', name: 'Email' },
        fields: [
          { role: 'textbox', name: 'Name', fill: 'filled' },
          { role: 'textbox', name: 'Card', fill: 'filled' },
          { role: 'textbox', name: 'Email', fill: 'invalid' },
          { role: 'textbox', name: 'Phone', fill: 'empty' },
        ],
      }),
      trail: [
        { at: '2026-08-29T16:43:58.000Z', gapMs: 0, kind: 'click', target: { role: 'button', name: 'Checkout' } },
        { at: '2026-08-29T16:44:01.100Z', gapMs: 3100, kind: 'typed', target: { role: 'textbox', name: 'Email' } },
        { at: '2026-08-29T16:44:01.900Z', gapMs: 800, kind: 'note' },
      ],
    },
  })

  it('prints the stamp as one compact line — counts, and the invalid field BY NAME', () => {
    const { text } = serializeReviewPayload(payload([withEvidence]), [])
    expect(text).toContain(
      'screen: route /checkout · title "Checkout" · dialog "Confirm order" open · focused textbox "Email" · fields: 2 filled, 1 invalid (Email), 1 empty',
    )
  })

  it('prints the trail as timed actions — and NEVER a value', () => {
    const { text } = serializeReviewPayload(payload([withEvidence]), [])
    expect(text).toContain('trail (3 action(s) before this note):')
    expect(text).toMatch(/\d{2}:\d{2}:\d{2} click "Checkout" · \+3\.1s typed into "Email" · \+0\.8s note saved/)
  })

  it('prints the run trail ONCE at the top, before the notes', () => {
    const run: TrailEntry[] = [
      { at: '2026-08-29T16:40:00.000Z', gapMs: 0, kind: 'navigate', route: '/basket' },
      { at: '2026-08-29T16:40:05.000Z', gapMs: 5000, kind: 'scroll', scrollY: 640 },
    ]
    const { text } = serializeReviewPayload(payload([withEvidence], run), [])
    expect(text).toContain('run trail (2 action(s), oldest first)')
    expect(text.indexOf('run trail')).toBeLessThan(text.indexOf('- a1 '))
    expect(text).toContain('navigate /basket')
  })

  it('says the shot is STORED when it was not attached, and names the block when it was', () => {
    const without = serializeReviewPayload(payload([withEvidence]), []).text
    expect(without).toContain('screenshot: the screen as it was, 1600x900 — stored for the user')
    expect(without).toContain('includeShots')
    const withShot = serializeReviewPayload(payload([withEvidence]), [{ annotationId: 'a1', kind: 'evidence' }]).text
    expect(withShot).toContain('screenshot: the screen as it was, attached as attachment 1 (1600x900)')
  })

  it('numbers a shot AFTER the note’s own images, so "Image 2" still points at the right block', () => {
    const both = note({
      ...withEvidence,
      images: [{ pngPath: 'reviews/pasted/a1-0.png' }, { pngPath: 'reviews/pasted/a1-1.png' }],
    })
    const { text } = serializeReviewPayload(payload([both]), [
      { annotationId: 'a1', kind: 'image', imageIndex: 1 },
      { annotationId: 'a1', kind: 'image', imageIndex: 2 },
      { annotationId: 'a1', kind: 'evidence' },
    ])
    expect(text).toContain('images (2): Image 1 = attachment 1; Image 2 = attachment 2')
    expect(text).toContain('attached as attachment 3')
  })

  it('says PASSED / FAILED in Testing and names the pack', () => {
    const { text } = serializeReviewPayload(payload([withEvidence]), [], { uat: true, packName: 'Checkout flow · build 5 · 29 Aug' })
    expect(text.split('\n')[0]).toBe('pack: Checkout flow · build 5 · 29 Aug')
    expect(text).toContain('decision: FAILED')
  })

  it('prints nothing evidence-shaped for a note that has none', () => {
    const { text } = serializeReviewPayload(payload([note({})]), [])
    expect(text).not.toContain('screen:')
    expect(text).not.toContain('screenshot:')
    expect(text).not.toContain('trail')
  })
})
