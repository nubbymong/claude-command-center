import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type * as DebugLogger from '../../../src/main/debug-logger'

// The global setup.ts mocks debug-logger entirely (to prevent file I/O during
// other suites). This suite needs the REAL implementation and a real
// (temp-dir) filesystem, so unmock it -- NOT via a vi.mock(...importActual)
// wrapper: that memoizes its own result independent of vi.resetModules(),
// so a SECOND dynamic import() in a later test would silently hand back the
// first test's already-initialized module (its LOG_DIR cached to a tmpDir
// afterEach had already deleted) instead of a fresh instance.
vi.unmock('../../../src/main/debug-logger')

let tmpDir: string

vi.mock('../../../src/main/data-paths', () => ({
  // debug-logger only calls this lazily inside getLogDirPath() -- reading
  // `tmpDir` at call time (not at mock-definition time) is required.
  getDataDirectory: () => tmpDir,
}))

function logDir(): string {
  return path.join(tmpDir, 'debug')
}
function readLogFile(): string {
  const f = path.join(logDir(), 'app.log')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

/** fs.WriteStream opens (and flushes) asynchronously -- a synchronous write
 *  call queues data but does not guarantee it has reached disk by the very
 *  next line. Yield the event loop long enough for that to happen before an
 *  assertion reads the file back. */
function flush(ms = 200): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('debug-logger #487: EPIPE/EIO handling and rotation', () => {
  let mod: typeof DebugLogger

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-debug-logger-test-'))
    // debug-logger keeps its log-stream state (LOG_DIR, the open stream, the
    // running byte count) in module-level `let`s. Without a fresh module
    // instance per test, test N reuses test (N-1)'s cached directory AND its
    // still-open stream -- which afterEach has already rmSync'd out from
    // under it, so writes silently vanish into an unlinked, path-less fd.
    vi.resetModules()
    mod = await import('../../../src/main/debug-logger')
  })

  afterEach(() => {
    // Never let one test's handlers leak into the next, or into the real suite.
    process.removeAllListeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
    mod.closeDebugLogger()
    vi.restoreAllMocks()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('#487-A: a broken pipe cannot recurse the uncaughtException handler', () => {
    mod.installGlobalErrorHandlers()

    let consoleErrorCalls = 0
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      consoleErrorCalls++
      // Simulate the historical bug: writing to a broken stdout/stderr pipe
      // itself raises a fresh EPIPE, which Node re-emits as another
      // uncaughtException on the very listeners we're already inside.
      if (consoleErrorCalls < 25) {
        const epipe = new Error('write EPIPE') as NodeJS.ErrnoException
        epipe.code = 'EPIPE'
        process.emit('uncaughtException', epipe)
      }
    })

    const err = new Error('boom') as NodeJS.ErrnoException
    // Non-EPIPE errors still rethrow to crash properly -- that part of the
    // contract is unchanged. What matters here is what happens BEFORE the throw.
    expect(() => process.emit('uncaughtException', err)).toThrow('boom')

    // The re-entrancy guard must stop this at exactly one console.error call:
    // the reentrant process.emit fired from inside our mock must be swallowed
    // by the guard before it ever reaches logError/console.error again.
    expect(consoleErrorCalls).toBe(1)

    consoleErrorSpy.mockRestore()
  })

  it('#487-A: EPIPE/EIO is suppressed and logged to file WITHOUT touching console', async () => {
    mod.installGlobalErrorHandlers()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const epipe = new Error('write EPIPE') as NodeJS.ErrnoException
    epipe.code = 'EPIPE'
    expect(() => process.emit('uncaughtException', epipe)).not.toThrow()
    await flush()

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(readLogFile()).toContain('Uncaught exception (suppressed):')

    consoleErrorSpy.mockRestore()
  })

  it('#487 (unhandledRejection): EPIPE/EIO reasons are suppressed the same way', async () => {
    mod.installGlobalErrorHandlers()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const epipe = new Error('write EPIPE') as NodeJS.ErrnoException
    epipe.code = 'EPIPE'
    expect(() => process.emit('unhandledRejection', epipe, Promise.resolve())).not.toThrow()
    await flush()

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(readLogFile()).toContain('Unhandled rejection (suppressed):')

    consoleErrorSpy.mockRestore()
  })

  it('a throwing console.log cannot escape logInfo', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('write EPIPE')
    })
    expect(() => mod.logInfo('hello')).not.toThrow()
    await flush()
    expect(readLogFile()).toContain('hello')
  })

  it('#487-B: a hot logger rotates instead of growing app.log without bound', async () => {
    // Never let 15MB of literal 'x's hit the real terminal via console.error.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // One ~1KB message, written well past the 10MB cap, on a single long-lived
    // stream (no restarts) -- the exact shape of the original bug: the old
    // getStream() only rotated when a NEW stream was created. Yielding every
    // few hundred iterations mirrors reality (writes are naturally spaced by
    // real events) and lets each stream's buffered writes actually reach disk
    // before rotateIfNeeded() re-checks size against MAX_LOG_SIZE.
    const line = 'x'.repeat(1024)
    const target = 10 * 1024 * 1024 // MAX_LOG_SIZE, mirrored here (not exported)
    const iterations = Math.ceil((target * 1.5) / line.length)
    for (let i = 0; i < iterations; i++) {
      mod.logError(line)
      if (i % 500 === 0) await flush(10)
    }
    await flush(300)

    const currentSize = fs.statSync(path.join(logDir(), 'app.log')).size
    const rotatedPath = path.join(logDir(), 'app.log.1')

    // The live file must have rotated at least once -- it must NOT be anywhere
    // near the ~15MB actually written, and a .1 rotation file must exist.
    expect(currentSize).toBeLessThan(target)
    expect(fs.existsSync(rotatedPath)).toBe(true)
  })

  // Round-1 adversarial finding (BLOCKER): the #487-B fix above still made
  // its rotate DECISION by re-deriving from fs.statSync() on the next open --
  // which lags a WriteStream's async flush. A tight loop with NO await lets
  // many crossings of MAX_LOG_SIZE happen in the same synchronous tick, well
  // before the OS has actually written any of it out, so statSync() kept
  // reporting a small (pre-flush) size: rotation was skipped AND `streamBytes`
  // was reseeded from that same stale, too-small number, so the running
  // counter never reached the cap again. Root-fix: rotation is decided by an
  // in-process flag (`mustRotate`) set synchronously the instant the counter
  // crosses the cap, and honoured unconditionally on the next open -- never
  // re-derived from a racing stat.
  it('#487 round-1 BLOCKER: a synchronous write burst (no await) still rotates deterministically', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const line = 'x'.repeat(1024)
    const target = 10 * 1024 * 1024 // MAX_LOG_SIZE, mirrored here (not exported)
    // ~30MB in a row with ZERO awaits -- crosses the cap multiple times inside
    // one synchronous JS turn, which is exactly the shape that defeated the
    // stat-based decision (the old code never yields to let a flush land).
    const iterations = Math.ceil((target * 3) / line.length)
    for (let i = 0; i < iterations; i++) {
      mod.logError(line)
    }
    // Only NOW give the OS a chance to flush the final, still-open stream.
    await flush(500)

    const currentSize = fs.statSync(path.join(logDir(), 'app.log')).size
    const rotatedPath = path.join(logDir(), 'app.log.1')

    expect(currentSize).toBeLessThanOrEqual(target)
    expect(fs.existsSync(rotatedPath)).toBe(true)
  })

  // Round-1 adversarial finding (MINOR): a single formatted record bigger than
  // the whole rotation cap used to be written in full before the
  // running-total check ever ran (logError('y'.repeat(50MB)) wrote 50MB in one
  // shot). A single record must be bounded/truncated BEFORE it reaches the
  // stream.
  it('#487 round-1 MINOR: a single oversized record is truncated, not written whole', async () => {
    // Never dump 2MB of literal 'y's to the real terminal via console.error.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const huge = 'y'.repeat(2 * 1024 * 1024) // 2MB in one call
    mod.logError(huge)
    await flush()

    const size = fs.statSync(path.join(logDir(), 'app.log')).size
    // Comfortably above the ~256KB record cap (timestamp/level prefix + the
    // truncation marker add a little) but nowhere near the 2MB passed in.
    expect(size).toBeLessThan(300 * 1024)
    expect(readLogFile()).toContain('[truncated]')
  })

  // Round-1 adversarial coverage gap: the stream's own 'error' listener
  // (openStream(), ~debug-logger.ts:114-116) nulls the module's cached stream
  // so the NEXT write transparently reopens instead of silently going
  // nowhere. Exercise that branch directly rather than relying on it only
  // being incidentally covered by the rotation tests above.
  it('#487 round-1: a stream error nulls logStream and the next write reopens cleanly', async () => {
    // fs.WriteStream doesn't override the public `write` method (only
    // `_write`), so this captures the real per-call stream instance while
    // still performing the actual write -- vi.spyOn can't touch the frozen
    // `fs` module namespace directly (ESM), but the prototype object itself
    // is a plain, mutable object (same technique the reentrancy test above
    // uses successfully).
    const seenStreams: fs.WriteStream[] = []
    const originalWrite = fs.WriteStream.prototype.write
    const writeSpy = vi.spyOn(fs.WriteStream.prototype, 'write').mockImplementation(function (this: fs.WriteStream, ...args: unknown[]) {
      seenStreams.push(this)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalWrite as any).apply(this, args)
    })

    mod.logInfo('first')
    await flush()
    expect(seenStreams.length).toBeGreaterThanOrEqual(1)
    const firstStream = seenStreams[0]!

    // Simulate a stream-level write failure (ENOSPC/EBADF/permission loss).
    expect(() => firstStream.emit('error', new Error('EBADF'))).not.toThrow()

    mod.logInfo('second')
    await flush()

    // A fresh stream instance must have been used for the second write.
    const secondStream = seenStreams[seenStreams.length - 1]!
    expect(secondStream).not.toBe(firstStream)
    const content = readLogFile()
    expect(content).toContain('first')
    expect(content).toContain('second')

    writeSpy.mockRestore()
  })

  // Round-1 adversarial coverage gap: the existing re-entrancy test above
  // drives re-entry through the NON-suppressed branch (console.error, on an
  // error with no .code). Drive it through the SUPPRESSED (EPIPE) branch's
  // own write path instead -- writeToLog() -> stream.write() -- which is the
  // scenario the guard's docstring specifically calls out ("the suppressed-
  // branch write path itself re-enters").
  it('#487-A round-1: the suppressed-branch write path cannot recurse the handler', () => {
    mod.installGlobalErrorHandlers()

    let writeCalls = 0
    const writeSpy = vi.spyOn(fs.WriteStream.prototype, 'write').mockImplementation(function (this: any) {
      writeCalls++
      if (writeCalls === 1) {
        // The write itself re-raises a fresh EPIPE synchronously -- mirrors a
        // stream 'write' that fails immediately while still inside the
        // handler's own suppressed-branch write.
        const epipe = new Error('write EPIPE') as NodeJS.ErrnoException
        epipe.code = 'EPIPE'
        process.emit('uncaughtException', epipe)
      }
      return true
    })

    const epipe = new Error('write EPIPE') as NodeJS.ErrnoException
    epipe.code = 'EPIPE'
    expect(() => process.emit('uncaughtException', epipe)).not.toThrow()

    // With the guard intact, the reentrant emit is swallowed before it can
    // reach writeToLog() a second time -- exactly one write.
    expect(writeCalls).toBe(1)

    writeSpy.mockRestore()
  })
})
