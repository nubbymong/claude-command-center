// ATTACK SUITE (throwaway — do not commit).
// Target: the canvas IPC Zod gate. Does validation stop a hostile distRoot,
// extra fields, prototype pollution, or a smuggled mode? And critically: does
// the schema apply ANY path policy to distRoot before it reaches the store?

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: vi.fn(),
}))

const storeMock = vi.hoisted(() => ({
  getCanvasStateForSession: vi.fn(),
  renderVersion: vi.fn(),
  setActiveVersion: vi.fn(),
}))

vi.mock('../../../src/main/canvas/canvas-store', () => ({
  getCanvasStateForSession: storeMock.getCanvasStateForSession,
  renderVersion: storeMock.renderVersion,
  setActiveVersion: storeMock.setActiveVersion,
  onCanvasChanged: () => () => {},
}))

const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const invoke = (ch: string, args: unknown) => handlers.get(ch)!({} as never, args)

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerCanvasHandlers(() => null as never)
})

describe('ATTACK: IPC schema applies NO path policy to distRoot', () => {
  it.each([
    'C:\\',
    'C:\\Users',
    'C:\\Users\\nicho\\.ssh',
    '/etc',
    '\\\\attacker-share\\dist', // UNC path
  ])('lets distRoot=%j through to the store verbatim', async (distRoot) => {
    storeMock.renderVersion.mockReturnValue({ canvasId: 'c', versionId: 'v1' })
    await invoke(IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'uat', distRoot, entry: 'index.html' } })
    // The store receives the hostile absolute path unchanged — the gate did not
    // constrain it to a project/build directory at all.
    expect(storeMock.renderVersion).toHaveBeenCalledWith(SID, { mode: 'uat', distRoot, entry: 'index.html' })
  })
})

// Fairness: confirm the parts of the gate that DO hold, so the report is honest
// about where the boundary is (input shape) vs where it is missing (path policy).
describe('gate holds: shape/strictness are enforced', () => {
  it('rejects extra fields (.strict)', async () => {
    await expect(
      invoke(IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'uat', distRoot: 'C:\\', sneak: 1 } }),
    ).rejects.toThrow()
    expect(storeMock.renderVersion).not.toHaveBeenCalled()
  })

  it('rejects a smuggled/unknown mode', async () => {
    await expect(
      invoke(IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'plan', html: 'x' } }),
    ).rejects.toThrow()
    expect(storeMock.renderVersion).not.toHaveBeenCalled()
  })

  it('NOTE: .strict() does NOT reject an own __proto__ key, but it is non-exploitable here', async () => {
    // Zod quirk: `'__proto__' in shape` is always true (prototype chain), so
    // strict never counts __proto__ as an unrecognized key. The parse SUCCEEDS.
    storeMock.renderVersion.mockReturnValue({ canvasId: 'c', versionId: 'v1' })
    const args = JSON.parse('{"sessionId":"' + SID + '","source":{"mode":"design","html":"x"},"__proto__":{"polluted":true}}')
    await expect(invoke(IPC.CANVAS_RENDER, args)).resolves.toBeTruthy() // NOT rejected

    // But it does not pollute Object.prototype, and the store receives only the
    // whitelisted fields (Zod's output is a fresh object) — so no impact.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(storeMock.renderVersion).toHaveBeenCalledWith(SID, { mode: 'design', html: 'x' })
    const [, sourceArg] = storeMock.renderVersion.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.prototype.hasOwnProperty.call(sourceArg, '__proto__')).toBe(false)
  })
})
