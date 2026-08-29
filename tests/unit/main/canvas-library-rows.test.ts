// THE PROJECT LIBRARY, one row per ARTEFACT RUN (M4) — and the privacy rule
// that decides which rows exist at all.
//
// Driven through the real IPC handler rather than against `buildLibraryRows`
// directly, because three of the things under test only meet there: the
// liveness oracle (canvas-session-link), the config-name lookup
// (config-manager), and the project scope resolved from main's own spawn record
// rather than from anything the caller sends.
//
// The rule that shapes every case: an IN-FLIGHT canvas is PRIVATE to the live
// session that rendered it. Another live session gets no row, and therefore no
// count, no verdict and no note text — the search runs main-side precisely so a
// withheld row's note text never crosses the boundary to be filtered by the
// renderer.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { IPC } from '../../../src/shared/ipc-channels'
import type { CanvasLibraryResult, EvidenceStateStamp } from '../../../src/shared/canvas'

const h = vi.hoisted(() => ({ livePtySessions: new Set<string>() }))

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-library-rows-'))
  return { getResourcesDirectory: () => dir }
})

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {},
  },
  BrowserWindow: { fromWebContents: () => null },
}))
vi.mock('../../../src/main/canvas/canvas-snapshot-broker', () => ({
  resolveCanvasSnapshot: vi.fn(),
  setSnapshotSender: vi.fn(),
}))
vi.mock('../../../src/main/session-registry', () => ({
  getSessionMeta: (id: string) => (h.livePtySessions.has(id) ? { id } : undefined),
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviewStore = await import('../../../src/main/canvas/canvas-review-store')
const evidence = await import('../../../src/main/canvas/canvas-evidence')
const completion = await import('../../../src/main/canvas/canvas-completion')
const link = await import('../../../src/main/canvas/canvas-session-link')
const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')

const OWNER = 'aaaa1111aaaa1111aaaa1111'
const FOREIGN = 'bbbb2222bbbb2222bbbb2222'
const PROJECT = path.join(getResourcesDirectory(), 'project')
const CFG_ID = 'cfg-checkout'

registerCanvasHandlers(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as never)

const listLibrary = async (args: Record<string, unknown>): Promise<CanvasLibraryResult> =>
  (await handlers.get(IPC.CANVAS_LIBRARY_LIST)!({} as never, args)) as CanvasLibraryResult

/** configs.json, as config-manager reads it. Written directly so a RENAME is a
 *  plain file edit — which is exactly the scenario the id-not-label design
 *  exists for. */
function writeConfigs(entries: Array<{ id: string; label: string }>): void {
  const dir = path.join(getResourcesDirectory(), 'CONFIG')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'configs.json'), JSON.stringify(entries))
}

const extraTempDirs: string[] = []
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  extraTempDirs.push(dir)
  return dir
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/** A structural NativeImage — the encode ladder is not what is under test here,
 *  only that a locked evidence record reaches the row. */
function fakeImage(width: number, height: number): Parameters<typeof evidence.encodeEvidenceShot>[0] {
  const make = (w: number, hh: number): Parameters<typeof evidence.encodeEvidenceShot>[0] => ({
    getSize: () => ({ width: w, height: hh }),
    isEmpty: () => false,
    resize: ({ width: rw, height: rh }) => {
      const scale = rw !== undefined ? rw / w : rh !== undefined ? rh / hh : 1
      return make(Math.round(w * scale), Math.round(hh * scale))
    },
    toPNG: () => Buffer.concat([PNG_MAGIC, Buffer.alloc(1000)]),
    toJPEG: () => Buffer.concat([JPEG_MAGIC, Buffer.alloc(900)]),
  })
  return make(width, height)
}

function stamp(route: string): EvidenceStateStamp {
  return {
    capturedAt: new Date('2026-08-29T16:43:52.000Z').toISOString(),
    title: 'Checkout',
    route,
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, dpr: 2, zoom: 1 },
    dialogs: [],
    fields: [],
  }
}

function spawn(sessionId: string, opts: { cwd?: string; configId?: string; configLabel?: string } = {}): void {
  link.noteSessionSpawnForCanvas(sessionId, {
    cwd: opts.cwd ?? PROJECT,
    ...(opts.configId !== undefined ? { configId: opts.configId } : {}),
    ...(opts.configLabel !== undefined ? { configLabel: opts.configLabel } : {}),
  })
}

beforeEach(() => {
  h.livePtySessions.clear()
  store._resetCanvasStoreForTest()
  reviewStore._resetCanvasReviewStoreForTest()
  link._resetCanvasSessionLinkForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
  fs.rmSync(path.join(getResourcesDirectory(), 'CONFIG'), { recursive: true, force: true })
  fs.mkdirSync(PROJECT, { recursive: true })
  link.installCanvasSessionLink()
  writeConfigs([{ id: CFG_ID, label: 'Checkout' }])
})

afterAll(() => {
  for (const d of extraTempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('one row per ARTEFACT, not per canvas', () => {
  it('splits a canvas that has held a mockup, a plan and a test pack', () => {
    spawn(OWNER, { configId: CFG_ID, configLabel: 'Checkout' })
    store.renderVersion(OWNER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>m</p>' })
    store.renderVersion(OWNER, { mode: 'plan', title: 'Checkout flow', html: '<!doctype html><p>p</p>' })
    const dist = tmpDir('ccc-library-dist-')
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><body>build</body>')
    expect(store.registerCanvasUatRoot(OWNER, dist)).toBe(true)
    store.renderVersion(OWNER, { mode: 'uat', distRoot: dist, buildLabel: '5', title: 'Checkout flow' })

    return listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] }).then((result) => {
      expect(result.truncated).toBe(false)
      expect(result.rows.map((r) => r.kind).sort()).toEqual(['mockup', 'pack', 'plan'])
      const pack = result.rows.find((r) => r.kind === 'pack')!
      expect(pack.versionLabel).toBe('build 5')
      expect(result.rows.find((r) => r.kind === 'mockup')!.versionLabel).toBe('v1')
      // A row per artefact means each carries its OWN anchor, which is what the
      // row's actions are addressed by.
      expect(new Set(result.rows.map((r) => r.anchorVersionId)).size).toBe(3)
    })
  })

  it('reports the verdict and the owed text from recorded state, never from a stored phase', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const rendered = store.renderVersion(OWNER, {
      mode: 'design',
      title: 'Checkout flow',
      html: '<!doctype html><p>m</p>',
    })
    let rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0]).toMatchObject({ verdict: 'OPEN', owed: 'v1 awaiting review' })

    // The user rejects with a note: the ball moves to the agent.
    const up = reviewStore.upsertAnnotation(OWNER, {
      scope: 'general',
      note: 'the header wraps at 1280',
      versionId: rendered.versionId,
    })
    reviewStore.submitReview(OWNER, up.state.reviews.find((r) => r.status === 'draft')!.id, [], 'reject')
    rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0]).toMatchObject({ verdict: 'REJECTED', owed: '1 note with the agent', noteCount: 1 })
  })

  it('says how many notes the user has NOT sent yet, when nothing else is owed', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const mock = store.renderVersion(OWNER, {
      mode: 'design',
      title: 'Checkout flow',
      html: '<!doctype html><p>m</p>',
    })
    // A SECOND artefact, deliberately left open: approving the mockup below
    // would otherwise auto-complete the whole canvas (W2), which detaches it
    // from the session and there would be no composer to leave a draft in.
    store.renderVersion(OWNER, { mode: 'plan', title: 'Checkout flow', html: '<!doctype html><p>p</p>' })
    // Approve the MOCKUP so its run has nothing open and no live round, then
    // start a note the user never sends.
    await handlers.get(IPC.CANVAS_VERSION_VERDICT)!({} as never, {
      sessionId: OWNER,
      versionId: mock.versionId,
      state: 'approved',
    })
    reviewStore.upsertAnnotation(OWNER, { scope: 'general', note: 'half a thought', versionId: mock.versionId })

    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows.find((r) => r.kind === 'mockup')!.owed).toBe('1 unsent note')
  })
})

describe('the config name is resolved AT READ, so a rename follows', () => {
  it('shows the configs.json label for the id the record stamped', async () => {
    spawn(OWNER, { configId: CFG_ID, configLabel: 'Checkout' })
    store.renderVersion(OWNER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>m</p>' })

    let rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0].configName).toBe('Checkout')

    // Rename the CONFIG. The canvas record is untouched — its key is the id
    // plus the project, neither of which moved — and the row follows.
    writeConfigs([{ id: CFG_ID, label: 'Checkout (v2)' }])
    rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0].configName).toBe('Checkout (v2)')
    expect(store.getCanvasStateById(rows[0].canvasId)?.configId).toBe(CFG_ID)
  })

  it('falls back to the spawn label when the id names no config any more', async () => {
    spawn(OWNER, { configId: CFG_ID, configLabel: 'Checkout tile' })
    store.renderVersion(OWNER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>m</p>' })
    writeConfigs([])
    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0].configName).toBe('Checkout tile')
  })

  it('carries no config name at all when nothing knows one — never a placeholder', async () => {
    spawn(OWNER)
    store.renderVersion(OWNER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>m</p>' })
    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0]).not.toHaveProperty('configName')
  })

  it('does not print the tile name twice when it IS the config name', async () => {
    spawn(OWNER, { configId: CFG_ID, configLabel: 'Checkout' })
    store.renderVersion(OWNER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>m</p>' })
    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0].configName).toBe('Checkout')
    expect(rows[0].audit.sessionLabel).toBeUndefined()
  })

  it('keeps the tile name when the user has renamed the TILE', async () => {
    spawn(OWNER, { configId: CFG_ID, configLabel: 'the payments spike' })
    store.renderVersion(OWNER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>m</p>' })
    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0].configName).toBe('Checkout')
    expect(rows[0].audit.sessionLabel).toBe('the payments spike')
    expect(rows[0].audit.when).toEqual(expect.any(String))
  })
})

describe('THE PRIVACY RULE — in flight is private to the live session holding it', () => {
  function ownerRenders(): string {
    spawn(OWNER, { configId: CFG_ID })
    return store.renderVersion(OWNER, {
      mode: 'design',
      title: 'Checkout flow',
      html: '<!doctype html><p>secret work</p>',
    }).canvasId
  }

  it('hides another LIVE session’s in-flight canvas entirely', async () => {
    const canvasId = ownerRenders()
    spawn(FOREIGN)
    h.livePtySessions.add(OWNER)
    const result = await listLibrary({ sessionId: FOREIGN, openTileSessionIds: [FOREIGN] })
    expect(result.rows.map((r) => r.canvasId)).not.toContain(canvasId)
  })

  it('hides it when the renderer says its tile is on screen, PTY or not', async () => {
    const canvasId = ownerRenders()
    spawn(FOREIGN)
    const result = await listLibrary({ sessionId: FOREIGN, openTileSessionIds: [FOREIGN, OWNER] })
    expect(result.rows.map((r) => r.canvasId)).not.toContain(canvasId)
  })

  it('shows it OWNERLESS once nothing is live, so it can be resumed', async () => {
    const canvasId = ownerRenders()
    spawn(FOREIGN)
    const result = await listLibrary({ sessionId: FOREIGN, openTileSessionIds: [FOREIGN] })
    expect(result.rows.map((r) => r.canvasId)).toContain(canvasId)
    expect(result.rows[0].readOnly).toBe(false) // in flight and ownerless: resumable, not read-only
  })

  it('shows a COMPLETED canvas even while its owner is live — READ-ONLY', async () => {
    const canvasId = ownerRenders()
    const v = store.getCanvasStateById(canvasId)!.versions[0].id
    await handlers.get(IPC.CANVAS_VERSION_VERDICT)!({} as never, { sessionId: OWNER, versionId: v, state: 'approved' })
    expect(store.getCanvasStateById(canvasId)?.completed).toBeTruthy()

    spawn(FOREIGN)
    h.livePtySessions.add(OWNER)
    const result = await listLibrary({ sessionId: FOREIGN, openTileSessionIds: [FOREIGN] })
    const row = result.rows.find((r) => r.canvasId === canvasId)!
    expect(row.completed).toBe(true)
    expect(row.readOnly).toBe(true)
    expect(row.ownedByThisSession).toBe(false)
    // ...and to its OWNER the same row is not read-only.
    const mine = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })
    expect(mine.rows.find((r) => r.canvasId === canvasId)!.readOnly).toBe(false)
  })

  it('never lets a withheld row leak through the SEARCH', async () => {
    // The search runs main-side over note text; the point of that is that a
    // withheld canvas is not searched at all, rather than searched and then
    // filtered somewhere the data has already crossed the boundary.
    const canvasId = ownerRenders()
    reviewStore.upsertAnnotation(OWNER, { scope: 'general', note: 'unreleased codename', versionId: 'v1' })
    spawn(FOREIGN)
    h.livePtySessions.add(OWNER)
    const result = await listLibrary({ sessionId: FOREIGN, openTileSessionIds: [FOREIGN], query: 'codename' })
    expect(result.rows).toEqual([])
    expect(JSON.stringify(result)).not.toContain(canvasId)
  })

  it('applies the same rule to the totals sweep (canvas:listAll)', async () => {
    // The button's count reads that channel. A row returned there but withheld
    // here would put somebody else's private work into a number on screen.
    const canvasId = ownerRenders()
    spawn(FOREIGN)
    h.livePtySessions.add(OWNER)
    const entries = (await handlers.get(IPC.CANVAS_LIST_ALL)!({} as never, {
      sessionId: FOREIGN,
      openTileSessionIds: [FOREIGN],
    })) as Array<{ canvasId: string }>
    expect(entries.map((e) => e.canvasId)).not.toContain(canvasId)
  })
})

describe('search, tabs, filters and the cap', () => {
  async function seed(): Promise<void> {
    spawn(OWNER, { configId: CFG_ID })
    const mock = store.renderVersion(OWNER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>m</p>' })
    reviewStore.upsertAnnotation(OWNER, {
      scope: 'general',
      note: 'the FOOTER overlaps',
      versionId: mock.versionId,
    })
    store.renderVersion(OWNER, { mode: 'plan', title: 'Checkout flow', html: '<!doctype html><p>p</p>' })
  }

  it('matches the title', async () => {
    await seed()
    const result = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], query: 'checkout' })
    expect(result.rows.length).toBe(2)
    expect((await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], query: 'zzz' })).rows).toEqual([])
  })

  it('matches NOTE TEXT, which is the thing a user actually remembers', async () => {
    await seed()
    const result = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], query: 'footer' })
    expect(result.rows.map((r) => r.kind)).toEqual(['mockup'])
  })

  it('matches the CANVAS TITLE beneath a pack row the user has renamed', async () => {
    // The gap this closes. A pack row's title IS its packName once the user
    // sets one, so the subject the canvas was made under — which is very
    // likely what they type — was searchable on every row EXCEPT the ones most
    // likely to have been renamed. The subject is deliberately unlike the
    // config name here, so only the canvas title can produce the match.
    spawn(OWNER, { configId: CFG_ID, configLabel: 'Checkout' })
    const dist = tmpDir('ccc-library-rename-')
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><body>build</body>')
    expect(store.registerCanvasUatRoot(OWNER, dist)).toBe(true)
    const pack = store.renderVersion(OWNER, {
      mode: 'uat',
      distRoot: dist,
      buildLabel: '5',
      title: 'Zebra crossing',
    })
    expect(store.setPackName(OWNER, pack.canvasId, pack.versionId, 'Smoke run 3')).not.toHaveProperty('error')

    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0].title).toBe('Smoke run 3') // the row shows the pack's name...

    const hit = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], query: 'zebra' })
    expect(hit.rows.map((r) => r.canvasId)).toEqual([pack.canvasId]) // ...and the subject still finds it
    // The pack name itself still matches, so this ADDS a haystack rather than
    // swapping one for another.
    expect((await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], query: 'smoke' })).rows).toHaveLength(1)
  })

  it('matches the config name', async () => {
    await seed()
    const result = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], query: 'checkou' })
    expect(result.rows.length).toBeGreaterThan(0)
  })

  it('narrows to one kind on a tab', async () => {
    await seed()
    expect((await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], tab: 'plan' })).rows.map((r) => r.kind))
      .toEqual(['plan'])
    expect((await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], tab: 'pack' })).rows).toEqual([])
  })

  it('applies the chips: needs-you, open, signed-off, archived', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const owed = store.renderVersion(OWNER, { mode: 'design', title: 'Owed', html: '<!doctype html><p>a</p>' })
    // A second subject, approved, so it is signed off and owes nothing.
    const doneRender = store.renderVersion(OWNER, { mode: 'design', title: 'Done', html: '<!doctype html><p>b</p>' })
    await handlers.get(IPC.CANVAS_VERSION_VERDICT)!({} as never, {
      sessionId: OWNER,
      versionId: doneRender.versionId,
      state: 'approved',
    })

    const kinds = async (filter?: string) =>
      (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], ...(filter ? { filter } : {}) })).rows.map(
        (r) => r.canvasId,
      )

    expect(await kinds('needs-you')).toEqual([owed.canvasId])
    expect(await kinds('signed-off')).toEqual([doneRender.canvasId])
    expect(await kinds('open')).toEqual([owed.canvasId])
    expect(await kinds('archived')).toEqual([])

    // Archive the owed artefact: it leaves the default view and appears under
    // its own chip.
    await handlers.get(IPC.CANVAS_ARCHIVE_ARTIFACT)!({} as never, {
      sessionId: OWNER,
      canvasId: owed.canvasId,
      versionId: owed.versionId,
      archived: true,
      openTileSessionIds: [OWNER],
    })
    expect(await kinds()).not.toContain(owed.canvasId)
    expect(await kinds('archived')).toEqual([owed.canvasId])
  })

  it('caps the rows and says so, having applied the narrowing FIRST', async () => {
    // 210 artefact runs on one canvas: `artifactRuns` breaks a run on a kind
    // change, so alternating design/plan renders make one run each.
    spawn(OWNER, { configId: CFG_ID })
    for (let i = 0; i < 210; i++) {
      store.renderVersion(OWNER, {
        mode: i % 2 === 0 ? 'design' : 'plan',
        title: 'Checkout flow',
        html: `<!doctype html><p>${i}</p>`,
      })
    }
    const all = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })
    expect(all.rows).toHaveLength(200)
    expect(all.truncated).toBe(true)

    // ...and `truncated` is honest: with the tab applied there are 105 plan
    // runs, which fit, so nothing is cut.
    const plans = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], tab: 'plan' })
    expect(plans.rows).toHaveLength(105)
    expect(plans.truncated).toBe(false)
  }, 60_000)
})

describe('a test pack row carries its evidence', () => {
  it('offers up to six note summaries with the paths the record itself holds', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const dist = tmpDir('ccc-library-pack-')
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><body>build</body>')
    expect(store.registerCanvasUatRoot(OWNER, dist)).toBe(true)
    const pack = store.renderVersion(OWNER, {
      mode: 'uat',
      distRoot: dist,
      buildLabel: '5',
      title: 'Checkout flow',
    })

    for (let i = 0; i < 8; i++) {
      const shot = evidence.encodeEvidenceShot(fakeImage(1200, 800))!
      const evidenceId = evidence.storePendingEvidence({
        canvasId: pack.canvasId,
        versionId: pack.versionId,
        shot,
        stamp: stamp(`/step-${i}`),
        trail: [],
      })
      reviewStore.upsertAnnotation(OWNER, {
        scope: 'general',
        note: `defect ${i}`,
        versionId: pack.versionId,
        evidenceId,
      })
    }

    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    const row = rows.find((r) => r.kind === 'pack')!
    expect(row.noteCount).toBe(8)
    expect(row.evidence).toHaveLength(6)
    for (const card of row.evidence!) {
      expect(card.shotPath).toMatch(/^reviews\/evidence\/a[0-9]{1,9}\.(png|jpg)$/)
      expect(card.route).toMatch(/^\/step-[0-7]$/)
      expect(card.at).toBe('2026-08-29T16:43:52.000Z')
    }
  })

  it('gives a MOCKUP row no evidence field at all', async () => {
    spawn(OWNER, { configId: CFG_ID })
    store.renderVersion(OWNER, { mode: 'design', title: 'Checkout flow', html: '<!doctype html><p>m</p>' })
    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0]).not.toHaveProperty('evidence')
  })
})

describe('delete is guarded at the seam (M4)', () => {
  it('refuses to destroy a canvas a LIVE other session is working in', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const { canvasId } = store.renderVersion(OWNER, {
      mode: 'design',
      title: 'Checkout flow',
      html: '<!doctype html><p>m</p>',
    })
    spawn(FOREIGN)
    h.livePtySessions.add(OWNER)

    const result = await handlers.get(IPC.CANVAS_DELETE)!({} as never, {
      sessionId: FOREIGN,
      canvasId,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toEqual({ ok: false, reason: 'owner-live' })
    expect(store.getCanvasStateById(canvasId)).not.toBeNull()
  })

  it('lets the OWNER delete its own, live or not', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const { canvasId } = store.renderVersion(OWNER, {
      mode: 'design',
      title: 'Checkout flow',
      html: '<!doctype html><p>m</p>',
    })
    h.livePtySessions.add(OWNER)
    const result = await handlers.get(IPC.CANVAS_DELETE)!({} as never, {
      sessionId: OWNER,
      canvasId,
      openTileSessionIds: [OWNER],
    })
    expect(result).toEqual({ ok: true })
    expect(store.getCanvasStateById(canvasId)).toBeNull()
  })

  it('refuses a non-owner’s delete of a COMPLETED canvas — shared history is not housekeeping', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const rendered = store.renderVersion(OWNER, {
      mode: 'design',
      title: 'Checkout flow',
      html: '<!doctype html><p>m</p>',
    })
    // Approve it: with nothing else owed anywhere, the approval IS the sign-off
    // (W2), which is how a canvas becomes memorialised in the first place.
    // `completeCanvasGuarded` alone would refuse here — the version was still
    // awaiting review, which is exactly what an approval settles.
    await handlers.get(IPC.CANVAS_VERSION_VERDICT)!({} as never, {
      sessionId: OWNER,
      versionId: rendered.versionId,
      state: 'approved',
    })
    expect(store.getCanvasStateById(rendered.canvasId)?.completed).toBeTruthy()
    spawn(FOREIGN)

    const result = await handlers.get(IPC.CANVAS_DELETE)!({} as never, {
      sessionId: FOREIGN,
      canvasId: rendered.canvasId,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toEqual({ ok: false, reason: 'not-eligible' })
    expect(store.getCanvasStateById(rendered.canvasId)).not.toBeNull()
  })
})

describe('resume, at the IPC seam', () => {
  const listResumables = async (sessionId: string, tiles: string[]) =>
    (await handlers.get(IPC.CANVAS_LIST_RESUMABLES)!({} as never, {
      sessionId,
      openTileSessionIds: tiles,
    })) as Array<{ canvasId: string; configName?: string; expectedOwnerSessionId: string; noteCount: number }>

  function strandOne(): string {
    spawn(OWNER, { configId: CFG_ID, configLabel: 'Checkout' })
    const { canvasId, versionId } = store.renderVersion(OWNER, {
      mode: 'design',
      title: 'Checkout flow',
      html: '<!doctype html><p>m</p>',
    })
    reviewStore.upsertAnnotation(OWNER, { scope: 'general', note: 'a note', versionId })
    spawn(FOREIGN, { configId: CFG_ID })
    return canvasId
  }

  it('resolves the config id to its CURRENT display name, never to a raw id', async () => {
    const canvasId = strandOne()
    let rows = await listResumables(FOREIGN, [FOREIGN])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ canvasId, configName: 'Checkout', expectedOwnerSessionId: OWNER, noteCount: 1 })

    writeConfigs([])
    rows = await listResumables(FOREIGN, [FOREIGN])
    // The config is gone: no name rather than the id, which would be noise.
    expect(rows[0]).not.toHaveProperty('configName')
  })

  it('takes the canvas on the first call and refuses the second with "changed"', async () => {
    const canvasId = strandOne()
    const [row] = await listResumables(FOREIGN, [FOREIGN])
    const resume = (sessionId: string) =>
      handlers.get(IPC.CANVAS_RESUME)!({} as never, {
        sessionId,
        canvasId,
        expectedOwnerSessionId: row.expectedOwnerSessionId,
        openTileSessionIds: [FOREIGN],
      })

    const first = (await resume(FOREIGN)) as { ok: boolean; state?: { canvasId: string } }
    expect(first.ok).toBe(true)
    expect(first.state?.canvasId).toBe(canvasId)
    expect(store.getCanvasStateById(canvasId)?.sessionId).toBe(FOREIGN)
    // The reviews follow the canvas: reviews.json carries the owner too.
    expect(reviewStore.getReviewStateForSession(FOREIGN)?.canvasId).toBe(canvasId)

    // A second session holding the SAME stale token loses.
    const second = await resume('cccc3333cccc3333cccc3333')
    expect(second).toEqual({ ok: false, reason: 'changed' })
  })

  it('refuses while the owner is live, and offers nothing to look at either', async () => {
    const canvasId = strandOne()
    h.livePtySessions.add(OWNER)
    expect(await listResumables(FOREIGN, [FOREIGN])).toEqual([])
    expect(
      await handlers.get(IPC.CANVAS_RESUME)!({} as never, {
        sessionId: FOREIGN,
        canvasId,
        expectedOwnerSessionId: OWNER,
        openTileSessionIds: [FOREIGN],
      }),
    ).toEqual({ ok: false, reason: 'owner-live' })
  })

  it('dismiss discards the canvas AND its review record', async () => {
    const canvasId = strandOne()
    expect(
      await handlers.get(IPC.CANVAS_DISMISS)!({} as never, {
        sessionId: FOREIGN,
        canvasId,
        openTileSessionIds: [FOREIGN],
      }),
    ).toEqual({ ok: true })
    expect(store.getCanvasStateById(canvasId)).toBeNull()
    expect(fs.existsSync(path.join(getResourcesDirectory(), 'canvas', canvasId))).toBe(false)
  })
})

describe('"Needs you" is the USER\u2019s move, not merely "something is outstanding"', () => {
  /** A canvas with an OPEN version: the user owes a decision. */
  async function needsYouRow(title: string): Promise<string> {
    return store.renderVersion(OWNER, { mode: 'design', title, html: '<!doctype html><p>x</p>' }).canvasId
  }

  /** A canvas whose round is WITH THE AGENT: outstanding, but not the user's. */
  async function withAgentRow(title: string): Promise<string> {
    const rendered = store.renderVersion(OWNER, { mode: 'design', title, html: '<!doctype html><p>y</p>' })
    const up = reviewStore.upsertAnnotation(OWNER, {
      scope: 'general',
      note: 'the header wraps',
      versionId: rendered.versionId,
    })
    reviewStore.submitReview(OWNER, up.state.reviews.find((r) => r.status === 'draft')!.id, [], 'reject')
    return rendered.canvasId
  }

  it('EXCLUDES a with-agent row from the chip, and INCLUDES an open version', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const mine = await needsYouRow('Mine to decide')
    const theirs = await withAgentRow('Agent is holding it')

    const all = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })
    // Both are OUTSTANDING — the old chip swept in both, which is the defect.
    expect(all.rows.filter((r) => !!r.owed).map((r) => r.canvasId).sort()).toEqual([mine, theirs].sort())
    expect(all.rows.find((r) => r.canvasId === theirs)!.owed).toBe('1 note with the agent')

    const chip = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], filter: 'needs-you' })
    expect(chip.rows.map((r) => r.canvasId)).toEqual([mine])
  })

  it('INCLUDES a row whose only debt is the user\u2019s own unsent note', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const rendered = store.renderVersion(OWNER, { mode: 'design', title: 'Drafting', html: '<!doctype html><p>x</p>' })
    // A second artefact keeps the canvas from auto-completing on the approve.
    store.renderVersion(OWNER, { mode: 'plan', title: 'Drafting', html: '<!doctype html><p>p</p>' })
    await handlers.get(IPC.CANVAS_VERSION_VERDICT)!({} as never, {
      sessionId: OWNER,
      versionId: rendered.versionId,
      state: 'approved',
    })
    reviewStore.upsertAnnotation(OWNER, { scope: 'general', note: 'half a thought', versionId: rendered.versionId })

    const chip = await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], filter: 'needs-you' })
    const row = chip.rows.find((r) => r.kind === 'mockup')
    expect(row?.owed).toBe('1 unsent note')
  })

  it('SORTS by whose move it is, not by whether anything is outstanding', async () => {
    spawn(OWNER, { configId: CFG_ID })
    // The needs-you row is rendered FIRST, so recency alone would put the
    // with-agent row above it. Whose move it is has to win.
    const mine = await needsYouRow('Older, and mine')
    const theirs = await withAgentRow('Newer, and the agent\u2019s')

    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows.map((r) => r.canvasId)).toEqual([mine, theirs])
  })

  it('leaves a settled row out of the chip entirely', async () => {
    spawn(OWNER, { configId: CFG_ID })
    const rendered = store.renderVersion(OWNER, { mode: 'design', title: 'Done', html: '<!doctype html><p>x</p>' })
    await handlers.get(IPC.CANVAS_VERSION_VERDICT)!({} as never, {
      sessionId: OWNER,
      versionId: rendered.versionId,
      state: 'approved',
    })
    expect((await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER], filter: 'needs-you' })).rows).toEqual([])
  })
})

describe('the audit moment is a DATE, not a string', () => {
  it('loses an unparseable author stamp rather than letting it win the comparison', async () => {
    // `sanitizeAuditStamp` refuses an unparseable `at` on load, and `newestAudit`
    // parses rather than string-compares — two lines against the same fault,
    // because a value like "zzz" sorts ABOVE every real ISO stamp lexically and
    // would take over the row's audit line and its recency for ever.
    spawn(OWNER, { configId: CFG_ID, configLabel: 'Checkout tile' })
    const rendered = store.renderVersion(OWNER, {
      mode: 'design',
      title: 'Checkout flow',
      html: '<!doctype html><p>x</p>',
    })
    reviewStore.upsertAnnotation(OWNER, { scope: 'general', note: 'a note', versionId: rendered.versionId })

    const reviewsPath = path.join(getResourcesDirectory(), 'canvas', rendered.canvasId, 'reviews.json')
    const record = JSON.parse(fs.readFileSync(reviewsPath, 'utf8')) as { annotations: Array<Record<string, unknown>> }
    record.annotations[0].author = { sessionId: OWNER, at: 'zzz' }
    fs.writeFileSync(reviewsPath, JSON.stringify(record, null, 2))
    reviewStore._resetCanvasReviewStoreForTest()

    const rows = (await listLibrary({ sessionId: OWNER, openTileSessionIds: [OWNER] })).rows
    expect(rows[0].audit.when).not.toBe('zzz')
    expect(rows[0].updatedAt).not.toBe('zzz')
    // It fell back to the version's own render stamp, which is a real moment.
    expect(Number.isFinite(Date.parse(rows[0].audit.when))).toBe(true)
    expect(rows[0].audit.when).toBe(store.getCanvasStateById(rendered.canvasId)!.versions[0].createdAt)
  })
})
