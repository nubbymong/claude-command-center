// rc.15 review R6 (Codex, 2026-09-06; aicc_planning#53 adjacent): on macOS the
// app stays resident when its last window closes (Dock reopen), and used to
// leave every main-owned PTY running invisibly behind the empty Dock icon. The
// window-all-closed handler now ends the stragglers there; everywhere else it
// quits, as before (positive control).
import { describe, it, expect, vi } from 'vitest'
import { onAllWindowsClosed } from '../../../src/main/window-close-coordinator'

describe('window-all-closed (R6)', () => {
  it('Codex: macOS stays resident AND ends the straggler PTYs', () => {
    const quit = vi.fn()
    const endStragglerPtys = vi.fn()
    expect(onAllWindowsClosed({ platform: 'darwin', quit, endStragglerPtys })).toBe('stay-resident')
    expect(quit).not.toHaveBeenCalled()
    expect(endStragglerPtys).toHaveBeenCalledTimes(1) // 7ef62a2e: never
  })

  for (const platform of ['win32', 'linux'] as const) {
    it(`positive control: ${platform} quits (before-quit tears the PTYs down), no separate sweep`, () => {
      const quit = vi.fn()
      const endStragglerPtys = vi.fn()
      expect(onAllWindowsClosed({ platform, quit, endStragglerPtys })).toBe('quit')
      expect(quit).toHaveBeenCalledTimes(1)
      expect(endStragglerPtys).not.toHaveBeenCalled()
    })
  }
})
