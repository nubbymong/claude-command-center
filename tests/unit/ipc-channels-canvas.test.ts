// Canvas channel constants — pinned strings (renames are breaking: the
// preload bridge and the d.ts mirror both hang off these) + global uniqueness.

import { describe, it, expect } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'
import { CANVAS_BRIDGE_PATH, CANVAS_ID_RE, CANVAS_VERSION_ID_RE, canvasContentUrl } from '../../src/shared/canvas'

describe('canvas IPC channels', () => {
  it('pins the exact channel strings', () => {
    expect(IPC.CANVAS_GET_STATE).toBe('canvas:getState')
    expect(IPC.CANVAS_RENDER).toBe('canvas:render')
    expect(IPC.CANVAS_SET_ACTIVE_VERSION).toBe('canvas:setActiveVersion')
    expect(IPC.CANVAS_CHANGED).toBe('canvas:changed')
    expect(IPC.CANVAS_REVIEW_GET_STATE).toBe('canvas:reviewGetState')
    expect(IPC.CANVAS_ANNOTATION_UPSERT).toBe('canvas:annotationUpsert')
    expect(IPC.CANVAS_ANNOTATION_DELETE).toBe('canvas:annotationDelete')
    expect(IPC.CANVAS_REVIEW_SUBMIT).toBe('canvas:reviewSubmit')
    expect(IPC.CANVAS_VERSION_VERDICT).toBe('canvas:versionVerdict')
    // The ONLY two revivals of a settled round — both the user's own gesture.
    expect(IPC.CANVAS_ANNOTATION_REOPEN).toBe('canvas:annotationReopen')
    expect(IPC.CANVAS_REVIEW_REOPEN).toBe('canvas:reviewReopen')
    // The seen report — renderer-only, and the one input to the agent's
    // close-out barrier that no MCP tool can produce.
    expect(IPC.CANVAS_REVIEW_MARK_SEEN).toBe('canvas:reviewMarkSeen')
    // W14 — the half-written note, persisted. Renderer-only, like mark-seen:
    // the payload is the user's unsent words and no MCP tool may reach it.
    expect(IPC.CANVAS_COMPOSER_DRAFT_SET).toBe('canvas:composerDraftSet')
    expect(IPC.CANVAS_COMPOSER_DRAFT_CLEAR).toBe('canvas:composerDraftClear')
    // W3 — the user's force exit, and the read that lets the confirm name it.
    expect(IPC.CANVAS_COMPLETE_FORCE).toBe('canvas:completeForce')
    expect(IPC.CANVAS_DESCRIBE_FORCE_CLOSURES).toBe('canvas:describeForceClosures')
    expect(IPC.CANVAS_REVIEW_CHANGED).toBe('canvas:reviewChanged')
    // M3 — Testing-mode evidence. Capture and discard are the pair that make a
    // note a locked record; read is the recall view's only way to a picture;
    // frameNavigated is main telling the trail the page moved.
    expect(IPC.CANVAS_EVIDENCE_CAPTURE).toBe('canvas:evidenceCapture')
    expect(IPC.CANVAS_EVIDENCE_DISCARD).toBe('canvas:evidenceDiscard')
    expect(IPC.CANVAS_EVIDENCE_READ).toBe('canvas:evidenceRead')
    expect(IPC.CANVAS_SET_PACK_NAME).toBe('canvas:setPackName')
    expect(IPC.CANVAS_FRAME_NAVIGATED).toBe('canvas:frameNavigated')
  })

  it('no longer carries the channels the settled machine removed', () => {
    // Per-note verdicts, the library close-out and the session-wide dismiss-all
    // are gone (W6). Pinned as ABSENT so a revival has to be deliberate.
    const channels = IPC as unknown as Record<string, string | undefined>
    expect(channels.CANVAS_ANNOTATION_RESOLVE).toBeUndefined()
    expect(channels.CANVAS_REVIEW_CLOSE_OUT).toBeUndefined()
    expect(channels.CANVAS_REVIEW_DISMISS_ALL).toBeUndefined()
  })

  it('keeps every channel value unique', () => {
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('canvas id contracts', () => {
  it('accepts the shapes the store mints and nothing pathological', () => {
    expect(CANVAS_ID_RE.test('a1b2c3d4e5f6a7b8c9d0e1f2')).toBe(true)
    expect(CANVAS_ID_RE.test('ABC')).toBe(false) // URL hosts lowercase; ids are minted lowercase
    expect(CANVAS_ID_RE.test('a/b')).toBe(false)
    expect(CANVAS_ID_RE.test('..')).toBe(false)
    expect(CANVAS_ID_RE.test('')).toBe(false)
    expect(CANVAS_VERSION_ID_RE.test('v1')).toBe(true)
    expect(CANVAS_VERSION_ID_RE.test('v123456789')).toBe(true)
    expect(CANVAS_VERSION_ID_RE.test('v')).toBe(false)
    expect(CANVAS_VERSION_ID_RE.test('1')).toBe(false)
    expect(CANVAS_VERSION_ID_RE.test('v1/..')).toBe(false)
  })

  it('builds content URLs with the bridge on a reserved absolute path', () => {
    expect(canvasContentUrl('abc123', 'v2', 'index.html')).toBe('ccc-ux://abc123/v2/index.html')
    expect(canvasContentUrl('abc123', 'v2', '/index.html')).toBe('ccc-ux://abc123/v2/index.html')
    expect(CANVAS_BRIDGE_PATH.startsWith('/__ccc__/')).toBe(true)
  })
})
