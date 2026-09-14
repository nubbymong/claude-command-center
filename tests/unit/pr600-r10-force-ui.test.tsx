// @vitest-environment jsdom
// ADR-009 round 3 (Codex PR600 finding 5): a canvas whose only debt is a
// rejected, unreworked plan must offer the FORCE route -- otherwise Mark
// complete arms, main refuses, and no force is ever offered (a dead button).
// Real canvas stores and the real completion button; only IPC + the temp root
// are synthetic. Desired-behaviour regression: RED before the fix.
import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const fixture = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'pr600-r10-ui-')) }
})
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => fixture.root }))
vi.mock('../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))

const store = await import('../../src/main/canvas/canvas-store')
const reviews = await import('../../src/main/canvas/canvas-review-store')
const completion = await import('../../src/main/canvas/canvas-completion')
const link = await import('../../src/main/canvas/canvas-session-link')
const { useCanvasStore } = await import('../../src/renderer/stores/canvasStore')
const { useCanvasReviewStore } = await import('../../src/renderer/stores/canvasReviewStore')
const CanvasCompleteButton = (await import('../../src/renderer/components/CanvasCompleteButton')).default

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
link.installCanvasSessionLink()
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); container?.remove(); root = undefined; container = undefined; vi.restoreAllMocks() })

describe('PR600 R10 force-complete UI (Codex finding 5)', () => {
  it('a rejected-unreworked plan with no notes routes Mark complete to the force call and completes', async () => {
    const sessionId = 'a'.repeat(24)
    link.noteSessionSpawnForCanvas(sessionId, { cwd: 'C:/synthetic-pr600' })
    const plan = store.renderVersion(sessionId, { title: 'Rej', mode: 'plan', html: '<p>Plan</p>' })
    store.setVersionVerdict(sessionId, plan.versionId, { state: 'rejected', note: 'redo' }, 'user')
    const design = store.renderVersion(sessionId, { title: 'Rej', mode: 'design', html: '<p>Design</p>' })
    store.setVersionVerdict(sessionId, design.versionId, { state: 'approved' }, 'user')
    const canvas = store.getCanvasStateById(plan.canvasId)!
    const mirror = reviews.getReviewStateForSession(sessionId)!
    const convert = (res: ReturnType<typeof completion.completeCanvasGuarded>) => 'error' in res ? { ok: false, reason: res.error } : { ok: true }
    const complete = vi.fn(async () => convert(completion.completeCanvasGuarded(plan.canvasId, 'user', sessionId)))
    const completeForce = vi.fn(async () => convert(completion.completeCanvasGuarded(plan.canvasId, 'user', sessionId, { force: true })))
    Object.assign((window as any).electronAPI.canvas, {
      describeForceClosures: async () => completion.describeForceClosures(plan.canvasId, sessionId), complete, completeForce,
    })
    useCanvasStore.setState({ bySessionId: { [sessionId]: { ...canvas, loaded: true } } } as any)
    useCanvasReviewStore.setState({ bySessionId: { [sessionId]: { ...mirror, loaded: true } } } as any)
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    await act(async () => root!.render(React.createElement(CanvasCompleteButton, { sessionId, canvasId: plan.canvasId, displayedVersionId: design.versionId })))
    const find = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now)
    await act(async () => find('canvas-complete-arm').click())
    // The armed confirm names the rejected debt (without implying approval).
    expect(find('canvas-complete-confirm').textContent).toContain('rejected and not reworked')
    now += 60_000
    await act(async () => find('canvas-complete-confirm').click())
    // 7565739c: complete() called, completeForce never, canvas refused (dead button).
    expect(completeForce).toHaveBeenCalledTimes(1)
    expect(store.getCanvasStateById(plan.canvasId)!.completed).not.toBeUndefined()
  })
})
