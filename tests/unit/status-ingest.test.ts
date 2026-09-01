import { describe, it, expect, beforeEach, vi } from 'vitest'

// POST /status ingest (harmonise-remote): the remote statusline shim delivers
// its payload through the SSH reverse tunnel instead of an OSC sentinel. The
// security contract under test: the payload's session identity comes from the
// AUTHENTICATED token, never the body — whatever sessionId the remote wrote is
// overwritten, so one host cannot repaint another session's statusline.

const h = vi.hoisted(() => ({
  dispatched: [] as string[],
  throwOnDispatch: false,
}))

vi.mock('../../src/main/statusline-watcher', () => ({
  dispatchSSHStatuslineUpdate: (json: string) => {
    if (h.throwOnDispatch) throw new Error('boom')
    h.dispatched.push(json)
  },
  cleanupStatusFile: () => {},
  startStatuslineWatcher: () => {},
}))
vi.mock('../../src/main/config-manager', () => ({
  readConfig: () => null,
  saveConfig: () => true,
}))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(), logError: vi.fn(), logDebug: vi.fn(), logWarn: vi.fn(),
}))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res', registerSetupHandlers: () => {} }))
vi.mock('../../src/main/clipboard-file', () => ({ mimeForImage: () => 'image/png' }))
vi.mock('../../src/main/providers/codex/mcp-config', () => ({ removeConductorVisionFromCodexConfig: () => {} }))
vi.mock('../../src/main/vision-manager', () => ({ getGlobalManager: () => null, startGlobalVision: () => {}, launchBrowser: () => {} }))
vi.mock('../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../src/main/codex-review-mcp-tool', () => ({ registerCodexReviewTool: () => {} }))

import { ingestStatusPayload, STATUS_BODY_MAX_BYTES } from '../../src/main/conductor-mcp-server'

beforeEach(() => {
  h.dispatched = []
  h.throwOnDispatch = false
})

describe('ingestStatusPayload (POST /status)', () => {
  it('binds the payload to the AUTHENTICATED session, overwriting a spoofed body sessionId', () => {
    const r = ingestStatusPayload('real-session', JSON.stringify({ sessionId: 'victim-session', model: 'Opus', contextUsedPercent: 12 }))
    expect(r.status).toBe(204)
    expect(h.dispatched).toHaveLength(1)
    const sent = JSON.parse(h.dispatched[0])
    expect(sent.sessionId).toBe('real-session')
    expect(sent.model).toBe('Opus')
    expect(sent.contextUsedPercent).toBe(12)
  })

  it('accepts a payload with no sessionId at all (identity comes from the token)', () => {
    const r = ingestStatusPayload('s1', JSON.stringify({ model: 'Fable' }))
    expect(r.status).toBe(204)
    expect(JSON.parse(h.dispatched[0]).sessionId).toBe('s1')
  })

  it('rejects malformed JSON with 400 and dispatches nothing', () => {
    const r = ingestStatusPayload('s1', '{not json')
    expect(r.status).toBe(400)
    expect(h.dispatched).toHaveLength(0)
  })

  it('rejects non-object payloads (array, string, null) with 400', () => {
    for (const raw of [JSON.stringify([1, 2]), JSON.stringify('str'), JSON.stringify(null)]) {
      expect(ingestStatusPayload('s1', raw).status).toBe(400)
    }
    expect(h.dispatched).toHaveLength(0)
  })

  it('fails closed with 401 when the authenticated session is empty', () => {
    const r = ingestStatusPayload('', JSON.stringify({ model: 'Opus' }))
    expect(r.status).toBe(401)
    expect(h.dispatched).toHaveLength(0)
  })

  it('answers 500 (not a crash) when the dispatcher throws', () => {
    h.throwOnDispatch = true
    const r = ingestStatusPayload('s1', JSON.stringify({ model: 'Opus' }))
    expect(r.status).toBe(500)
  })

  it('body cap is a sane constant (route refuses larger bodies with 413)', () => {
    expect(STATUS_BODY_MAX_BYTES).toBe(64 * 1024)
  })
})
