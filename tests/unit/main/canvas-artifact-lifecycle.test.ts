// Artifact archive + permanent delete (item C, phase 5) — the store half, which
// is where the security-critical properties live: durability (a deleted version
// id is never reissued), path-safe version-file removal, review-note deletion,
// and the refusal to delete a canvas's only artifact.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-artifact-life-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const TITLE = 'Feature X'

/** Render one version on the session's single canvas (same title = same
 *  subject, so versions accrue on ONE canvas). */
function render(mode: 'plan' | 'design', n: number) {
  return store.renderVersion(SID, { mode, html: `<!doctype html><p>${mode} ${n}</p>`, title: TITLE })
}

function stateVersions(): string[] {
  return store.getCanvasStateForSession(SID)!.versions.map((v) => v.id)
}

/** A three-version canvas: plan v1, plan v2, mockup v3 — two artifacts. */
function seedTwoArtifacts() {
  render('plan', 1)
  render('plan', 2)
  render('design', 3)
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  reviews._resetCanvasReviewStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})
afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('archive is reversible', () => {
  it('marks every version of the artifact archived, and clears it again', () => {
    seedTwoArtifacts()
    const s1 = store.setArtifactArchived(store.getCanvasStateForSession(SID)!.canvasId, 'v1', true)!
    const byId = (id: string) => s1.versions.find((v) => v.id === id)!
    expect(byId('v1').archived).toBe(true)
    expect(byId('v2').archived).toBe(true) // same plan run
    expect(byId('v3').archived).toBeUndefined() // the mockup is untouched

    const s2 = store.setArtifactArchived(s1.canvasId, 'v2', false)!
    expect(s2.versions.find((v) => v.id === 'v1')!.archived).toBeUndefined()
    expect(s2.versions.find((v) => v.id === 'v2')!.archived).toBeUndefined()
  })

  it('survives a restart', () => {
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    store.setArtifactArchived(canvasId, 'v1', true)
    store._resetCanvasStoreForTest()
    const after = store.getCanvasStateForSession(SID)!
    expect(after.versions.find((v) => v.id === 'v1')!.archived).toBe(true)
  })
})

describe('delete-artifact durability', () => {
  it('removes the run and never reissues a deleted id on the next render', () => {
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    // Delete the mockup artifact (v3, the LATEST) — the case where a max+1
    // scheme would reuse the id.
    const res = store.deleteArtifact(canvasId, 'v3')
    expect(res).toEqual({ ok: true, deletedVersionIds: ['v3'] })
    expect(stateVersions()).toEqual(['v1', 'v2'])

    // A fresh render mints v4, NOT a second v3.
    const next = render('design', 4)
    expect(next.versionId).toBe('v4')
    expect(stateVersions()).toEqual(['v1', 'v2', 'v4'])
  })

  it('keeps the counter across a restart, so a reload cannot reuse the id either', () => {
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    store.deleteArtifact(canvasId, 'v3')
    store._resetCanvasStoreForTest()
    const next = render('design', 4)
    expect(next.versionId).toBe('v4')
  })

  it('repoints the active version when the active one was deleted', () => {
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    expect(store.getCanvasStateForSession(SID)!.activeVersionId).toBe('v3')
    store.deleteArtifact(canvasId, 'v3')
    expect(store.getCanvasStateForSession(SID)!.activeVersionId).toBe('v2')
  })

  it('removes the deleted versions’ files from disk, keeping the survivors', () => {
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    const vdir = (id: string) => path.join(getResourcesDirectory(), 'canvas', canvasId, 'versions', id)
    expect(fs.existsSync(vdir('v3'))).toBe(true)
    store.deleteArtifact(canvasId, 'v3')
    expect(fs.existsSync(vdir('v3'))).toBe(false)
    expect(fs.existsSync(vdir('v1'))).toBe(true)
  })

  it('refuses to delete the canvas’s ONLY artifact', () => {
    render('plan', 1)
    render('plan', 2) // one artifact, two versions
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    expect(store.deleteArtifact(canvasId, 'v1')).toEqual({ ok: false, reason: 'only-artifact' })
    expect(stateVersions()).toEqual(['v1', 'v2'])
  })

  it('reports not-found for an unknown canvas or version', () => {
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    expect(store.deleteArtifact(canvasId, 'v99').ok).toBe(false)
    expect(store.deleteArtifact('deadbeefdeadbeefdeadbeef', 'v1').ok).toBe(false)
  })

  it('refuses to delete THROUGH a junction planted at the versions/ dir (ADR-009)', () => {
    // A reparse point at <canvasDir>/versions is resolved transparently by the
    // OS, so a per-version removal that starts below the checked canvas dir
    // would delete out of tree. The realpath identity check on each version dir
    // must refuse it — the victim survives, and the metadata delete still lands.
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    const versionsDir = path.join(getResourcesDirectory(), 'canvas', canvasId, 'versions')
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-victim-'))
    fs.mkdirSync(path.join(victim, 'v3'))
    fs.writeFileSync(path.join(victim, 'v3', 'precious.txt'), 'keep me')
    fs.rmSync(versionsDir, { recursive: true, force: true })
    try {
      fs.symlinkSync(victim, versionsDir, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Some CI shells cannot create a link without privilege — skip rather than
      // fail; the win32 leg (where junctions need none) is the one that matters.
      fs.rmSync(victim, { recursive: true, force: true })
      return
    }
    const res = store.deleteArtifact(canvasId, 'v3')
    expect(res.ok).toBe(true) // metadata delete still succeeds
    expect(fs.existsSync(path.join(victim, 'v3', 'precious.txt'))).toBe(true) // NOT deleted
    // cleanup: detach the link (never the target), then the victim
    try {
      fs.rmdirSync(versionsDir)
    } catch {
      try { fs.unlinkSync(versionsDir) } catch { /* ignore */ }
    }
    fs.rmSync(victim, { recursive: true, force: true })
  })
})

describe('delete-artifact takes its review notes with it', () => {
  it('drops notes anchored to the deleted versions and keeps the rest', () => {
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    // A note on v1 (plan) and a note on v3 (mockup, the active version).
    store.setActiveVersion(SID, 'v1')
    reviews.upsertAnnotation(SID, { scope: 'general', note: 'about the plan', versionId: 'v1' })
    store.setActiveVersion(SID, 'v3')
    reviews.upsertAnnotation(SID, { scope: 'general', note: 'about the mockup', versionId: 'v3' })
    expect(reviews.getReviewStateForSession(SID)!.annotations).toHaveLength(2)

    // Delete the mockup artifact, then drop its notes (the two-store step the
    // IPC handler performs).
    const res = store.deleteArtifact(canvasId, 'v3')
    expect(res.ok).toBe(true)
    const dropped = reviews.deleteAnnotationsForVersions(canvasId, (res as { deletedVersionIds: string[] }).deletedVersionIds)
    expect(dropped).toBe(1)

    const left = reviews.getReviewStateForSession(SID)!.annotations
    expect(left).toHaveLength(1)
    expect(left[0].versionId).toBe('v1')
  })

  it('deleteAnnotationsForVersions removes a review left with no notes', () => {
    seedTwoArtifacts()
    const canvasId = store.getCanvasStateForSession(SID)!.canvasId
    store.setActiveVersion(SID, 'v3')
    reviews.upsertAnnotation(SID, { scope: 'general', note: 'only note', versionId: 'v3' })
    const beforeReviews = reviews.getReviewStateForSession(SID)!.reviews.length
    expect(beforeReviews).toBeGreaterThan(0)
    reviews.deleteAnnotationsForVersions(canvasId, ['v3'])
    expect(reviews.getReviewStateForSession(SID)!.reviews).toHaveLength(0)
  })
})
