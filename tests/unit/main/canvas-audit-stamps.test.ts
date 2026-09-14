// AUDIT STAMPS (M4) — who made a write, and what happens when the record says
// something this build does not understand.
//
// THE RULE, in one line: a stamp is PROVENANCE, not content. A malformed one
// costs a row its audit line and nothing else. Every other optional field in
// these two stores is validated all-or-nothing and takes its VERSION (or its
// whole record) down with it when it fails — which is right for an `entry` that
// decides what gets served, and would be catastrophic here: losing a canvas's
// rendered documents, or a canvas's whole review history, because a later build
// wrote a field this one does not know is exactly the migration failure the
// load heals exist to prevent.
//
// So: absent = unknown, malformed = dropped, never fatal. Proven at three
// levels — the shared healer, the canvas record, and the review record.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-audit-stamps-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')
const shared = await import('../../../src/shared/canvas')

const SID = 'aaaa1111aaaa1111aaaa1111'
const OTHER = 'bbbb2222bbbb2222bbbb2222'

function canvasJsonPath(canvasId: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
}
function reviewsJsonPath(canvasId: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
}
function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}
/** Re-sign a hand-edited canvas record. Without this it fails its MAC and is
 *  refused wholesale, so the heal under test would never run and the test would
 *  pass for the wrong reason. */
function rewriteCanvas(canvasId: string, mutate: (record: Record<string, unknown>) => void): void {
  const record = readJson(canvasJsonPath(canvasId))
  delete record.mac
  mutate(record)
  fs.writeFileSync(
    canvasJsonPath(canvasId),
    JSON.stringify({ ...record, mac: store._canvasRecordMacForTest(record) }, null, 2),
  )
}
function restart(): void {
  store._resetCanvasStoreForTest()
  reviews._resetCanvasReviewStoreForTest()
}
/** A canvas with one version and one submitted note, stamped by SID. */
function seed(): { canvasId: string; annotationId: string } {
  store.setCanvasSessionInfoResolver(() => ({
    cwd: path.join(getResourcesDirectory(), 'project'),
    configId: 'cfg-one',
    auditLabels: { sessionLabel: 'Checkout tile', account: 'Work \u00b7 nick' },
  }))
  const rendered = store.renderVersion(SID, {
    mode: 'design',
    title: 'Checkout flow',
    html: '<!doctype html><p>v1</p>',
  })
  const up = reviews.upsertAnnotation(SID, {
    scope: 'general',
    note: 'the header wraps',
    versionId: rendered.versionId,
  })
  return { canvasId: rendered.canvasId, annotationId: up.annotationId }
}

beforeEach(() => {
  restart()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

describe('sanitizeAuditStamp — the shared healer', () => {
  it('keeps a well-formed stamp, field by field', () => {
    expect(
      shared.sanitizeAuditStamp({ sessionId: SID, sessionLabel: 'Tile', account: 'Work', at: '2026-08-29T00:00:00.000Z' }),
    ).toEqual({ sessionId: SID, sessionLabel: 'Tile', account: 'Work', at: '2026-08-29T00:00:00.000Z' })
  })

  it('drops a stamp with no usable session id or moment', () => {
    for (const bad of [
      null,
      'a string',
      {},
      { sessionId: '../evil', at: 'now' },
      { sessionId: SID },
      { sessionId: SID, at: '' },
      { sessionId: SID, at: 'x'.repeat(65) },
      // A bounded string that is not a MOMENT. Every reader treats `at` as a
      // date — the Library sorts on it and picks the newest stamp with it — so
      // an unparseable value would win or lose those comparisons by accident,
      // depending on its first character.
      { sessionId: SID, at: 'zzz' },
      { sessionId: SID, at: 'now' },
    ]) {
      expect(shared.sanitizeAuditStamp(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('drops the LABELS rather than the stamp when only they are unusable', () => {
    const healed = shared.sanitizeAuditStamp({ sessionId: SID, sessionLabel: 42, account: '   ', at: '2026-08-29T00:00:00.000Z' })
    expect(healed).toEqual({ sessionId: SID, at: '2026-08-29T00:00:00.000Z' })
  })

  it('strips format controls and caps a label', () => {
    // Built from code points \u2014 a literal control character never goes into a
    // tracked file. A bidi override in an audit line reverses the rest of it.
    const RLO = String.fromCodePoint(0x202e)
    const ZWSP = String.fromCodePoint(0x200b)
    const healed = shared.sanitizeAuditStamp({
      sessionId: SID,
      sessionLabel: `Ti${RLO}le${ZWSP}`,
      account: 'x'.repeat(200),
      at: '2026-08-29T00:00:00.000Z',
    })
    expect(healed?.sessionLabel).toBe('Tile')
    expect(healed?.account).toHaveLength(shared.MAX_AUDIT_LABEL_CHARS)
  })

  it('carries NO key it does not declare', () => {
    const healed = shared.sanitizeAuditStamp({
      sessionId: SID,
      at: '2026-08-29T00:00:00.000Z',
      hostileExtra: 'C:/Users/v/.ssh/id_ed25519',
    })
    expect(Object.keys(healed!).sort()).toEqual(['at', 'sessionId'])
  })

  it('pins the config id shape rather than merely bounding it', () => {
    expect(shared.sanitizeCanvasConfigId('cfg-one')).toBe('cfg-one')
    for (const bad of ['../../etc/passwd', 'a/b', '', 'x'.repeat(65), 42, null]) {
      expect(shared.sanitizeCanvasConfigId(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('the canvas record', () => {
  it('stamps createdBy, configId and a per-version renderedBy at render', () => {
    const { canvasId } = seed()
    const state = store.getCanvasStateById(canvasId)!
    expect(state.configId).toBe('cfg-one')
    expect(state.createdBy).toMatchObject({ sessionId: SID, sessionLabel: 'Checkout tile', account: 'Work \u00b7 nick' })
    expect(state.versions[0].renderedBy).toMatchObject({ sessionId: SID })
    expect(Date.parse(state.createdBy!.at)).toBeLessThanOrEqual(Date.now())
  })

  it('does NOT rewrite createdBy or configId on a later render — creation stamps do not drift', () => {
    const { canvasId } = seed()
    const first = store.getCanvasStateById(canvasId)!.createdBy!
    store.setCanvasSessionInfoResolver(() => ({
      cwd: path.join(getResourcesDirectory(), 'elsewhere'),
      configId: 'cfg-two',
      auditLabels: { sessionLabel: 'Another tile', account: 'Personal' },
    }))
    store.renderVersion(SID, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>v2</p>' })

    const after = store.getCanvasStateById(canvasId)!
    expect(after.createdBy).toEqual(first)
    expect(after.configId).toBe('cfg-one')
    // ...but the NEW version records who actually rendered it.
    expect(after.versions[1].renderedBy).toMatchObject({ sessionLabel: 'Another tile', account: 'Personal' })
  })

  it('does not rewrite createdBy when the canvas is RESUMED — a resume moves the work, not its history', () => {
    const { canvasId } = seed()
    const before = store.getCanvasStateById(canvasId)!.createdBy!
    restart()
    expect(store.resumeCanvasForSession(OTHER, canvasId, SID, { isSessionLive: () => false })).toMatchObject({ ok: true })
    const after = store.getCanvasStateById(canvasId)!
    expect(after.sessionId).toBe(OTHER) // the owner moved...
    expect(after.createdBy).toEqual(before) // ...and the authorship did not
  })

  it('DROPS a malformed renderedBy and keeps the version', () => {
    const { canvasId } = seed()
    restart()
    rewriteCanvas(canvasId, (record) => {
      const versions = record.versions as Array<Record<string, unknown>>
      versions[0].renderedBy = { sessionId: '../evil', at: 42, hostile: true }
    })
    const state = store.getCanvasStateById(canvasId)!
    expect(state.versions).toHaveLength(1) // the document survives...
    expect(state.versions[0].renderedBy).toBeUndefined() // ...the audit line does not
  })

  it('DROPS a malformed createdBy / configId and keeps the record', () => {
    const { canvasId } = seed()
    restart()
    rewriteCanvas(canvasId, (record) => {
      record.createdBy = { sessionId: 'not a session id at all!!', at: '' }
      record.configId = '../../etc/passwd'
    })
    const state = store.getCanvasStateById(canvasId)!
    expect(state.canvasId).toBe(canvasId)
    expect(state.versions).toHaveLength(1)
    expect(state.createdBy).toBeUndefined()
    expect(state.configId).toBeUndefined()
  })

  it('heals a partly-usable stamp rather than dropping the whole thing', () => {
    const { canvasId } = seed()
    restart()
    rewriteCanvas(canvasId, (record) => {
      record.createdBy = { sessionId: SID, sessionLabel: 99, account: 'Work', at: '2026-01-01T00:00:00.000Z' }
    })
    expect(store.getCanvasStateById(canvasId)!.createdBy).toEqual({
      sessionId: SID,
      account: 'Work',
      at: '2026-01-01T00:00:00.000Z',
    })
  })

  it('does NOT backfill creation stamps onto a legacy canvas a NEW OWNER re-renders', () => {
    // The resume-rewrites-history case. B picks up a canvas A made before
    // stamps existed and renders once; backfilling `createdBy`/`configId` there
    // would record B as the canvas's author, under B's config, and the Library
    // would print that as its authorship. A resume moves the work, not its
    // history — so a legacy canvas keeps NO creation stamp, forever.
    const { canvasId } = seed()
    restart()
    rewriteCanvas(canvasId, (record) => {
      delete record.createdBy
      delete record.configId
    })
    expect(store.resumeCanvasForSession(OTHER, canvasId, SID, { isSessionLive: () => false })).toMatchObject({ ok: true })

    store.setCanvasSessionInfoResolver(() => ({
      cwd: path.join(getResourcesDirectory(), 'project'),
      configId: 'cfg-other',
      auditLabels: { sessionLabel: 'B tile', account: 'Personal' },
    }))
    store.renderVersion(OTHER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>v2</p>' })

    const after = store.getCanvasStateById(canvasId)!
    expect(after.sessionId).toBe(OTHER)
    expect(after.createdBy).toBeUndefined()
    expect(after.configId).toBeUndefined()
    // ...and the row is still attributable, because the VERSION says who made
    // it. Nothing goes blank; only the false claim of authorship is refused.
    expect(after.versions[1].renderedBy).toMatchObject({ sessionId: OTHER, sessionLabel: 'B tile' })
  })

  it('a record written BEFORE stamps existed loads with none, and is not repaired into having some', () => {
    const { canvasId } = seed()
    restart()
    rewriteCanvas(canvasId, (record) => {
      delete record.createdBy
      delete record.configId
      const versions = record.versions as Array<Record<string, unknown>>
      delete versions[0].renderedBy
    })
    const state = store.getCanvasStateById(canvasId)!
    expect(state.createdBy).toBeUndefined()
    expect(state.configId).toBeUndefined()
    expect(state.versions[0].renderedBy).toBeUndefined()
    expect(state.versions).toHaveLength(1)
  })

  it('DROPS an author stamp whose moment does not parse', () => {
    // The hand-edited `at` the healer now refuses. It reaches the review record
    // rather than the canvas one because reviews.json carries no MAC, which
    // makes it the cheaper of the two to plant.
    const { canvasId, annotationId } = seed()
    restart()
    const record = readJson(reviewsJsonPath(canvasId))
    const annotations = record.annotations as Array<Record<string, unknown>>
    annotations[0].author = { sessionId: SID, at: 'zzz' }
    fs.writeFileSync(reviewsJsonPath(canvasId), JSON.stringify(record, null, 2))

    const note = reviews.getReviewStateForSession(SID)!.annotations.find((a) => a.id === annotationId)!
    expect(note.note).toBe('the header wraps')
    expect(note.author).toBeUndefined()
  })

  it('does not write an unknown stamp key back into a freshly signed record', () => {
    const { canvasId } = seed()
    restart()
    rewriteCanvas(canvasId, (record) => {
      record.createdBy = { sessionId: SID, at: '2026-08-29T00:00:00.000Z', hostileExtra: 'C:/Users/v/.ssh/id_ed25519' }
    })
    // Touch it so the store re-persists, then read what it wrote.
    store.setCanvasSessionInfoResolver(() => ({ cwd: path.join(getResourcesDirectory(), 'project') }))
    store.renderVersion(SID, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>v2</p>' })
    const onDisk = readJson(canvasJsonPath(canvasId))
    expect(onDisk.createdBy).toEqual({ sessionId: SID, at: '2026-08-29T00:00:00.000Z' })
  })
})

describe('the review record', () => {
  it('stamps the author at CREATE', () => {
    const { canvasId, annotationId } = seed()
    const note = reviews.getReviewStateForSession(SID)!.annotations.find((a) => a.id === annotationId)!
    expect(note.author).toMatchObject({ sessionId: SID, sessionLabel: 'Checkout tile', account: 'Work \u00b7 nick' })
    expect(canvasId).toBeTruthy()
  })

  it('does NOT re-stamp on an edit — a later save is the same person\u2019s note', () => {
    const { annotationId } = seed()
    const before = reviews.getReviewStateForSession(SID)!.annotations[0].author!
    const state = reviews.upsertAnnotation(SID, {
      annotationId,
      scope: 'general',
      note: 'the header wraps at 1280, actually',
      versionId: 'v1',
    }).state
    expect(state.annotations[0].note).toContain('actually')
    expect(state.annotations[0].author).toEqual(before)
  })

  it('DROPS a malformed author and keeps the note', () => {
    const { canvasId, annotationId } = seed()
    restart()
    const record = readJson(reviewsJsonPath(canvasId))
    const annotations = record.annotations as Array<Record<string, unknown>>
    annotations[0].author = { sessionId: '../evil', at: null }
    fs.writeFileSync(reviewsJsonPath(canvasId), JSON.stringify(record, null, 2))

    const state = reviews.getReviewStateForSession(SID)!
    const note = state.annotations.find((a) => a.id === annotationId)!
    expect(note.note).toBe('the header wraps') // the user's words survive...
    expect(note.author).toBeUndefined() // ...the audit line does not
  })

  it('a note written BEFORE stamps existed simply has none', () => {
    const { canvasId, annotationId } = seed()
    restart()
    const record = readJson(reviewsJsonPath(canvasId))
    const annotations = record.annotations as Array<Record<string, unknown>>
    delete annotations[0].author
    fs.writeFileSync(reviewsJsonPath(canvasId), JSON.stringify(record, null, 2))

    const note = reviews.getReviewStateForSession(SID)!.annotations.find((a) => a.id === annotationId)!
    expect(note.author).toBeUndefined()
    expect(note.note).toBe('the header wraps')
  })

  it('stamps nothing at all when the session has no spawn record', () => {
    // Absent means unknown, everywhere. A session main never saw spawn gets a
    // stamp with only what main itself knows: the id and its own clock.
    store.setCanvasSessionInfoResolver(null)
    const rendered = store.renderVersion(SID, { mode: 'design', title: 'No stamps', html: '<!doctype html><p>x</p>' })
    const up = reviews.upsertAnnotation(SID, { scope: 'general', note: 'anon', versionId: rendered.versionId })
    const note = up.state.annotations[0]
    expect(note.author).toEqual({ sessionId: SID, at: expect.any(String) })
    expect(store.getCanvasStateById(rendered.canvasId)!.createdBy).toEqual({
      sessionId: SID,
      at: expect.any(String),
    })
  })
})
