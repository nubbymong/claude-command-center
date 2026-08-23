// tests/unit/pty-manager-watchdog-teardown.test.ts
//
// Adversarial FINDING 1 (MAJOR): the session watchdog must be torn down from
// cleanupSessionResources — which runs from BOTH killPty and the natural-exit
// path, and UNCONDITIONALLY (not under onExit's weAreCurrent guard that a
// restart's stale exit skips). Without it, a watchdog armed by a local-Claude
// spawn survives a same-sessionId restart into a Codex/SSH/shell-only session
// and can send() its retry into that new PTY. This drives the REAL pty-manager
// (killPty with no live entry still runs cleanupSessionResources), so reverting
// the teardown line fails here rather than leaving the suite green.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ onData() {}, onExit() {}, write() {}, kill() {}, pid: 1 })) }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))

const stopWatchdog = vi.fn()
vi.mock('../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({ stopWatchdog }),
}))

const { killPty } = await import('../../src/main/pty-manager')

describe('pty-manager — watchdog teardown on cleanup (FINDING 1)', () => {
  beforeEach(() => { stopWatchdog.mockClear() })

  it('killPty tears the watchdog down (via cleanupSessionResources), unconditionally', () => {
    // No live PTY entry — killPty still runs cleanupSessionResources, which is
    // exactly the restart/close path that must clear the watcher before respawn.
    killPty('sess-restart-abc')
    expect(stopWatchdog).toHaveBeenCalledWith('sess-restart-abc')
  })
})
