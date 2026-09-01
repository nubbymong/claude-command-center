/**
 * Plan mode (P4/P5), against the real store.
 *
 * The design claim plan mode rests on is that it is a LABEL, not a storage or
 * serving mode: a plan is written, stored and served through the byte-identical
 * path a design document uses, and only `CanvasVersion.mode` differs. These
 * tests hold that claim, because the moment it stops being true plan mode has
 * added surface to a file whose entire job is refusing to serve things.
 *
 * Everything here drives the actual store — a render really lands on disk and is
 * really read back — rather than asserting the shape of a literal written in the
 * test, which would pass no matter what the store did.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-plan-mode-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const { countOpenPlanQuestions, MAX_PLAN_OPEN_QUESTIONS, PLAN_OPEN_QUESTION_ATTR } = await import('../../../src/shared/canvas')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const DOC = '<!doctype html><html><body><p data-ux-id="step-1">first</p></body></html>'

/** A plan document carrying `n` OPEN questions, plus one parked one that must
 *  never count — a parked decision does not hold its own plan hostage. */
const planWithQuestions = (n: number): string =>
  '<!doctype html><html><body>' +
  '<div data-plan-question="parked" data-ux-id="q0">deferred</div>' +
  Array.from({ length: n }, (_, i) => `<div data-plan-question="open" data-ux-id="q${i + 1}">Q${i + 1}</div>`).join('') +
  '</body></html>'

const canvasJson = (canvasId: string) =>
  path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try { fs.rmSync(getResourcesDirectory(), { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('a plan render', () => {
  it('stamps mode "plan" on the version but stores it as a design document', () => {
    const { canvasId, versionId } = store.renderVersion(SID, { mode: 'plan', html: DOC })
    const v = store.getCanvasStateForSession(SID)!.versions.find((x) => x.id === versionId)!
    expect(v.mode).toBe('plan')
    // The half that matters: serving keys on source.mode, and it says design.
    expect(v.source.mode).toBe('design')
    expect(v.source.entry).toBe('index.html')
    expect(canvasId).toBeTruthy()
  })

  it('is served by the identical path a design version is', () => {
    const plan = store.renderVersion(SID, { mode: 'plan', html: DOC })
    const served = store.getServableVersion(plan.canvasId, plan.versionId)
    expect(served).not.toBeNull()
    expect(served!.mode).toBe('design')
    expect(served!.entry).toBe('index.html')
    // The document really is on disk where a design render would have put it.
    expect(fs.readFileSync(path.join(served!.contentRoot, 'index.html'), 'utf8')).toBe(DOC)
  })

  it('produces a version indistinguishable from a design one except for the label', () => {
    const plan = store.renderVersion(SID, { mode: 'plan', html: DOC })
    const design = store.renderVersion(SID, { mode: 'design', html: DOC })
    const versions = store.getCanvasStateForSession(SID)!.versions
    const p = versions.find((v) => v.id === plan.versionId)!
    const d = versions.find((v) => v.id === design.versionId)!
    expect(p.source).toEqual(d.source)
    expect(p.mode).toBe('plan')
    expect(d.mode).toBe('design')
  })

  it('shares the size cap with a design render rather than having its own', () => {
    // The shared cap is 8MiB; this is comfortably past it.
    const huge = '<!doctype html>' + 'x'.repeat(9 * 1024 * 1024)
    expect(() => store.renderVersion(SID, { mode: 'plan', html: huge })).toThrow()
  })

  it('refuses an empty plan document, as design does', () => {
    expect(() => store.renderVersion(SID, { mode: 'plan', html: '' })).toThrow()
  })

  it('adds a version to the same canvas when the title is unchanged', () => {
    const a = store.renderVersion(SID, { mode: 'plan', html: DOC, title: 'Codex ingest' })
    const b = store.renderVersion(SID, { mode: 'plan', html: DOC, title: 'Codex ingest' })
    expect(b.canvasId).toBe(a.canvasId)
    expect(b.versionId).not.toBe(a.versionId)
  })
})

describe('open questions — the count Approve is gated on', () => {
  it('counts the attribute the exported constant NAMES — the skill teaches that name', () => {
    // The counter's own expression is a literal (it must not be built from a
    // string at call time), so this is what stops the two drifting apart: the
    // marker the skill tells agents to emit is the marker the count reads.
    expect(countOpenPlanQuestions(`<div ${PLAN_OPEN_QUESTION_ATTR}="open">Q1</div>`)).toBe(1)
  })

  it('counts only the OPEN marker, whatever the quoting or the case', () => {
    expect(countOpenPlanQuestions('<div data-plan-question="open">a</div>')).toBe(1)
    expect(countOpenPlanQuestions("<div data-plan-question='open'>a</div>")).toBe(1)
    expect(countOpenPlanQuestions('<div DATA-PLAN-QUESTION = "OPEN">a</div>')).toBe(1)
    expect(countOpenPlanQuestions(planWithQuestions(3))).toBe(3)
  })

  it('ignores a parked or answered question, and a plan with none', () => {
    expect(countOpenPlanQuestions('<div data-plan-question="parked">a</div>')).toBe(0)
    expect(countOpenPlanQuestions('<div data-plan-question="answered">a</div>')).toBe(0)
    // The word "open" in prose is not a marker.
    expect(countOpenPlanQuestions('<p>Two questions are still open.</p>')).toBe(0)
    expect(countOpenPlanQuestions(DOC)).toBe(0)
    expect(countOpenPlanQuestions('')).toBe(0)
  })

  it('stops at the cap rather than trusting a document to be sane', () => {
    expect(countOpenPlanQuestions(planWithQuestions(MAX_PLAN_OPEN_QUESTIONS + 40))).toBe(MAX_PLAN_OPEN_QUESTIONS)
  })

  it('stamps the count on the version at render, and leaves zero absent', () => {
    const withQ = store.renderVersion(SID, { mode: 'plan', html: planWithQuestions(2), title: 'Q plan' })
    const clean = store.renderVersion(SID, { mode: 'plan', html: DOC, title: 'Q plan' })
    const versions = store.getCanvasStateForSession(SID)!.versions
    expect(versions.find((v) => v.id === withQ.versionId)!.openQuestions).toBe(2)
    // Absence IS zero — a new version with nothing open is what unlocks Approve.
    expect(versions.find((v) => v.id === clean.versionId)!.openQuestions).toBeUndefined()
  })

  it('never counts them for a DESIGN render — the marker is a plan convention', () => {
    const d = store.renderVersion(SID, { mode: 'design', html: planWithQuestions(2) })
    const v = store.getCanvasStateForSession(SID)!.versions.find((x) => x.id === d.versionId)!
    expect(v.openQuestions).toBeUndefined()
  })
})

describe('a record read back from disk', () => {
  /** Rewrite canvas.json with `mutate` applied, then force a reload. */
  function reloadWith(canvasId: string, mutate: (record: any) => void): void {
    const file = canvasJson(canvasId)
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    // The MAC is computed over the record WITHOUT its own mac field — that is
    // how the writer does it, and recomputing over the stale one produces a
    // record that fails tamper detection instead of reaching the shape check.
    delete record.mac
    mutate(record)
    // Re-MAC so the record is otherwise legitimate: what is under test here is
    // the SHAPE check, not tamper detection (which has its own tests).
    fs.writeFileSync(file, JSON.stringify({ ...record, mac: store._canvasRecordMacForTest(record) }, null, 2))
    store._resetCanvasStoreForTest()
  }

  it('keeps a plan version across a reload', () => {
    const { canvasId, versionId } = store.renderVersion(SID, { mode: 'plan', html: DOC })
    reloadWith(canvasId, () => { /* unchanged */ })
    expect(store.getServableVersion(canvasId, versionId)).not.toBeNull()
  })

  it('DROPS a version whose mode is not one of the three', () => {
    // The mode is rendered as a chip. This store never repairs a hand-edited
    // record, so a version claiming to be a "totally-safe" mode is dropped
    // rather than shown as a chip naming whatever the file said.
    const { canvasId, versionId } = store.renderVersion(SID, { mode: 'plan', html: DOC })
    reloadWith(canvasId, (r) => { r.versions[0].mode = 'totally-safe' })
    expect(store.getServableVersion(canvasId, versionId)).toBeNull()
  })

  it('still drops a version whose SOURCE mode is unknown', () => {
    const { canvasId, versionId } = store.renderVersion(SID, { mode: 'plan', html: DOC })
    reloadWith(canvasId, (r) => { r.versions[0].source.mode = 'plan' })
    expect(store.getServableVersion(canvasId, versionId)).toBeNull()
  })

  it('keeps a legitimate open-question count', () => {
    const { canvasId, versionId } = store.renderVersion(SID, { mode: 'plan', html: planWithQuestions(2) })
    reloadWith(canvasId, () => { /* unchanged */ })
    expect(store.getCanvasStateForSession(SID)!.versions.find((v) => v.id === versionId)!.openQuestions).toBe(2)
  })

  it('DROPS a version whose open-question count was hand-edited out of shape', () => {
    // The count gates the Approve button, so a value this build did not write is
    // not repaired down to zero (which would UNLOCK approval) — the version goes,
    // like every other field read back out of shape.
    for (const bad of [-1, 1.5, 'none', MAX_PLAN_OPEN_QUESTIONS + 1, null]) {
      store._resetCanvasStoreForTest()
      fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
      const { canvasId, versionId } = store.renderVersion(SID, { mode: 'plan', html: planWithQuestions(2) })
      reloadWith(canvasId, (r) => { r.versions[0].openQuestions = bad })
      expect(store.getServableVersion(canvasId, versionId), String(bad)).toBeNull()
    }
  })
})
