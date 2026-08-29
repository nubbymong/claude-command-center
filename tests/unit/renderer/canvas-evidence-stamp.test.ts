// The evidence STATE STAMP (M3): how a snapshot folds into "what the screen
// was", and the guarantee that no part of what the user typed can ride along.
//
// The privacy bar is the reason this module exists as a pure function: the test
// hands it a snapshot with a value pushed at it in every shape a careless
// bridge could offer one, serialises what comes out, and greps.

import { describe, it, expect } from 'vitest'
import type { CanvasSnapshotResult, CanvasViewportInfo, SnapshotNode } from '../../../src/shared/canvas'
import { MAX_STAMP_DIALOGS, MAX_STAMP_FIELDS, MAX_STAMP_TARGET_CHARS } from '../../../src/shared/canvas'
import {
  baselineFromSnapshot,
  buildEvidenceStamp,
  reportedStampText,
  stampChips,
  trailLineParts,
} from '../../../src/renderer/canvas/canvas-state-stamp'

const BOX = { x: 0, y: 0, width: 10, height: 10 }

function node(over: Partial<SnapshotNode> = {}): SnapshotNode {
  return { ref: 'e1', role: 'generic', name: '', box: BOX, children: [], ...over } as SnapshotNode
}

function field(ref: string, name: string, over: Partial<NonNullable<SnapshotNode['state']>> = {}): SnapshotNode {
  return node({ ref, role: 'textbox', name, state: { type: 'text', ...over } })
}

function snapshot(root: SnapshotNode, over: Partial<CanvasSnapshotResult> = {}): CanvasSnapshotResult {
  return {
    viewport: { width: 1200, height: 800, dpr: 2 },
    root,
    ...over,
  } as CanvasSnapshotResult
}

const VIEWPORT: CanvasViewportInfo = { scrollX: 0, scrollY: 240, width: 1200, height: 800, dpr: 2, scale: 1 }

describe('the stamp describes structure', () => {
  it('carries route, title, viewport, dialogs, focus and fields', () => {
    const snap = snapshot(
      node({
        ref: 'root',
        children: [
          node({ ref: 'd1', role: 'dialog', name: 'Confirm order' }),
          field('f1', 'Email', { valueLength: 12 }),
          field('f2', 'Card number'),
        ],
      }),
      { page: { pathname: '/checkout', hash: '#pay', title: 'Checkout' }, focusedRef: 'f1' },
    )

    const stamp = buildEvidenceStamp({
      snapshot: snap,
      baseline: null,
      viewport: VIEWPORT,
      zoom: 1.25,
      at: '2026-08-29T16:44:02.000Z',
    })

    expect(stamp.route).toBe('/checkout#pay')
    expect(stamp.title).toBe('Checkout')
    expect(stamp.capturedAt).toBe('2026-08-29T16:44:02.000Z')
    expect(stamp.viewport).toEqual({ width: 1200, height: 800, scrollX: 0, scrollY: 240, dpr: 2, zoom: 1.25 })
    expect(stamp.dialogs).toEqual([{ role: 'dialog', name: 'Confirm order' }])
    expect(stamp.focused).toEqual({ role: 'textbox', name: 'Email' })
    expect(stamp.fields.map((f) => [f.name, f.fill])).toEqual([
      ['Email', 'filled'],
      ['Card number', 'empty'],
    ])
  })

  it('classifies a field CHANGED against the run baseline, not against emptiness', () => {
    const first = snapshot(
      node({ ref: 'root', children: [field('f1', 'Email', { valueLength: 4 }), field('f2', 'Notes')] }),
    )
    const baseline = baselineFromSnapshot(first)

    const later = snapshot(
      node({
        ref: 'root',
        children: [
          // Same prefilled field, edited: length moved.
          field('f9', 'Email', { valueLength: 12 }),
          // Untouched, still empty.
          field('f8', 'Notes'),
        ],
      }),
    )
    const stamp = buildEvidenceStamp({ snapshot: later, baseline, viewport: VIEWPORT, zoom: 1, at: 'now' })
    expect(stamp.fields.map((f) => [f.name, f.fill])).toEqual([
      ['Email', 'changed'],
      ['Notes', 'empty'],
    ])
  })

  it('prefers a data-ux-id over role+name when matching the baseline', () => {
    const first = snapshot(node({ ref: 'root', children: [field('f1', 'Field A', { valueLength: 3 })] }))
    const withUxId = { ...first.root.children[0], uxId: 'email' } as SnapshotNode
    const baseline = baselineFromSnapshot(snapshot(node({ ref: 'root', children: [withUxId] })))

    // The accessible NAME changed (a re-render, a translation) but the ux-id
    // did not — the field is still recognised, so an edit still reads changed.
    const later = snapshot(
      node({
        ref: 'root',
        children: [{ ...field('f7', 'Correo', { valueLength: 9 }), uxId: 'email' } as SnapshotNode],
      }),
    )
    expect(buildEvidenceStamp({ snapshot: later, baseline, viewport: null, zoom: 1, at: 'now' }).fields[0].fill).toBe(
      'changed',
    )
  })

  it('an invalid field outranks every other classification', () => {
    const snap = snapshot(node({ ref: 'root', children: [field('f1', 'Email', { valueLength: 12, ariaInvalid: true })] }))
    const baseline = baselineFromSnapshot(snapshot(node({ ref: 'root', children: [field('f1', 'Email')] })))
    expect(buildEvidenceStamp({ snapshot: snap, baseline, viewport: null, zoom: 1, at: 'now' }).fields[0].fill).toBe(
      'invalid',
    )
  })

  it('counts a dimmed div as chrome, not as a field', () => {
    // `state` rides any node (inert / opacity / srOnly); only `state.type`
    // marks a control.
    const snap = snapshot(
      node({ ref: 'root', children: [node({ ref: 'x', role: 'generic', name: 'panel', state: { opacity: 0.4 } })] }),
    )
    expect(buildEvidenceStamp({ snapshot: snap, baseline: null, viewport: null, zoom: 1, at: 'now' }).fields).toEqual([])
  })

  it('survives a snapshot the frame could not give — the viewport and clock still stand', () => {
    const stamp = buildEvidenceStamp({ snapshot: null, baseline: null, viewport: VIEWPORT, zoom: 2, at: 'now' })
    expect(stamp).toEqual({
      capturedAt: 'now',
      viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 240, dpr: 2, zoom: 2 },
      dialogs: [],
      fields: [],
    })
  })

  it('bounds what a page can put in one stamp', () => {
    const children: SnapshotNode[] = []
    for (let i = 0; i < MAX_STAMP_FIELDS + 10; i++) children.push(field(`f${i}`, `Field ${i}`))
    for (let i = 0; i < MAX_STAMP_DIALOGS + 5; i++) {
      children.push(node({ ref: `d${i}`, role: 'alertdialog', name: `Dialog ${i}` }))
    }
    children.push(field('long', 'x'.repeat(MAX_STAMP_TARGET_CHARS + 50)))
    const stamp = buildEvidenceStamp({
      snapshot: snapshot(node({ ref: 'root', children })),
      baseline: null,
      viewport: null,
      zoom: 1,
      at: 'now',
    })
    expect(stamp.fields).toHaveLength(MAX_STAMP_FIELDS)
    expect(stamp.dialogs).toHaveLength(MAX_STAMP_DIALOGS)
    for (const f of stamp.fields) expect(f.name.length).toBeLessThanOrEqual(MAX_STAMP_TARGET_CHARS)
  })
})

describe('the privacy bar', () => {
  it('never carries a typed value, however the snapshot offers one', () => {
    const SECRET = 'hunter2-PASSPHRASE'
    // Everything a careless or hostile bridge could hang off a node: a `value`
    // it invented, a `state.value`, and the length that IS legitimately in the
    // snapshot but must not travel into the stamp.
    const hostile = {
      ...field('f1', 'Password', { valueLength: SECRET.length }),
      value: SECRET,
      state: { type: 'password', valueLength: SECRET.length, value: SECRET },
    } as unknown as SnapshotNode
    const snap = snapshot(node({ ref: 'root', children: [hostile] }), {
      page: { pathname: '/login', hash: '', title: 'Sign in' },
      focusedRef: 'f1',
    })

    const stamp = buildEvidenceStamp({ snapshot: snap, baseline: null, viewport: VIEWPORT, zoom: 1, at: 'now' })
    const serialised = JSON.stringify(stamp)

    expect(serialised).not.toContain(SECRET)
    expect(serialised).not.toContain('valueLength')
    expect(serialised).not.toContain('"value"')
    // The field is still DESCRIBED — that is the point of the exercise.
    expect(stamp.fields[0]).toEqual({ role: 'textbox', name: 'Password', fill: 'filled' })
  })

  it('strips control characters a page could use to forge a second line', () => {
    const sneaky = `Email${String.fromCharCode(10)}route /admin`
    const snap = snapshot(node({ ref: 'root', children: [field('f1', sneaky)] }))
    const stamp = buildEvidenceStamp({ snapshot: snap, baseline: null, viewport: null, zoom: 1, at: 'now' })
    expect(stamp.fields[0].name).toBe('Email route /admin')
    expect(reportedStampText(`a${String.fromCharCode(0x2028)}b`, 50)).toBe('a b')
    expect(reportedStampText(42, 50)).toBe('')
  })

  it('drops a page-reported query string with the route it never asked for', () => {
    // The bridge is the one that omits the query (shared contract); the stamp
    // simply concatenates what it is given, so this pins that it adds nothing.
    const snap = snapshot(node({ ref: 'root' }), { page: { pathname: '/search', hash: '#r', title: '' } })
    const stamp = buildEvidenceStamp({ snapshot: snap, baseline: null, viewport: null, zoom: 1, at: 'now' })
    expect(stamp.route).toBe('/search#r')
    expect(stamp.title).toBeUndefined()
  })
})

describe('the words the recall view and the agent share', () => {
  it('summarises a stamp as chips, marking what the PAGE said', () => {
    const stamp = buildEvidenceStamp({
      snapshot: snapshot(
        node({
          ref: 'root',
          children: [
            node({ ref: 'd', role: 'dialog', name: 'Confirm' }),
            field('a', 'Email', { valueLength: 5 }),
            field('b', 'Name', { valueLength: 3 }),
            field('c', 'Card', { ariaInvalid: true }),
          ],
        }),
        { page: { pathname: '/checkout', hash: '', title: 'Checkout' } },
      ),
      baseline: null,
      viewport: VIEWPORT,
      zoom: 1,
      at: 'now',
    })
    const chips = stampChips(stamp)
    expect(chips.map((c) => c.text)).toEqual(['route /checkout', 'dialog open', '2 fields filled', '1 invalid'])
    expect(chips.find((c) => c.text === 'route /checkout')?.pageReported).toBe(true)
    expect(chips.find((c) => c.text === '2 fields filled')?.pageReported).toBe(false)
  })

  it('splits a trail line into a verb and a page-reported subject', () => {
    // The CLOCK is deliberately not re-implemented here: `trailClockTime` in
    // src/shared is the one formatter in the product, and this module owns only
    // the part a single string cannot express — which half the page wrote.
    expect(trailLineParts({ kind: 'click', target: { role: 'button', name: 'Checkout' } })).toEqual({
      verb: 'click',
      subject: 'Checkout',
      subjectIsPageReported: true,
    })
    expect(trailLineParts({ kind: 'click', target: null }).subjectIsPageReported).toBe(false)
    expect(trailLineParts({ kind: 'note' })).toEqual({ verb: 'note saved', subject: '', subjectIsPageReported: false })
    expect(trailLineParts({ kind: 'scroll', scrollY: 640.4 }).subject).toBe('640px')
  })
})
