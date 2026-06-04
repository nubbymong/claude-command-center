/**
 * Tests: session-logger error surfacing + defensive startSessionLog.
 *
 * Test seam: two exported test hooks on the module:
 *   _setLogRootForTest(p: string | null)
 *       – overrides the log root so tests never touch real data dirs.
 *   _setErrorReporterForTest(fn: ((msg: string, err?: unknown) => void) | null)
 *       – replaces the module-local error reporter so tests can capture
 *         calls without fighting ESM spy binding restrictions on logError.
 *
 * Because debug-logger is globally mocked to vi.fn() stubs in setup.ts, and
 * session-logger now delegates through its own reporter indirection, spying on
 * the injected reporter is the reliable approach here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Import after mock declarations so the module picks up the setup.ts mocks.
import * as logger from '../../../src/main/session-logger'

describe('session-logger surfacing', () => {
  let sandbox: string
  let errors: Array<{ msg: string; err?: unknown }>
  let fakeReporter: (msg: string, err?: unknown) => void

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'sl-test-'))
    errors = []
    fakeReporter = (msg, err) => errors.push({ msg, err })
    logger._setErrorReporterForTest(fakeReporter)
  })

  afterEach(() => {
    // Reset test seams
    logger._setLogRootForTest(null)
    logger._setErrorReporterForTest(null)
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('startSessionLog with invalid log root', () => {
    it('does NOT throw even when the log root is an invalid/unwritable path', () => {
      // Use a regular FILE as the log root — mkdir inside a file fails on all
      // platforms, giving us a controlled unwritable/invalid path scenario.
      const blocker = join(sandbox, 'blocker-file')
      writeFileSync(blocker, 'x')
      logger._setLogRootForTest(blocker)

      expect(() => {
        logger.startSessionLog('sid-fail', 'testConfig', 'user@test.com', 'prof-1')
      }).not.toThrow()
    })

    it('surfaces an error via the reporter when dir creation fails', () => {
      const blocker = join(sandbox, 'blocker-file2')
      writeFileSync(blocker, 'x')
      logger._setLogRootForTest(blocker)

      logger.startSessionLog('sid-fail2', 'testConfig', 'user@test.com', 'prof-1')

      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(errors[0].msg).toContain('startSessionLog failed')
    })
  })

  describe('startSessionLog with valid log root', () => {
    it('writes to disk without errors when the root is writable', () => {
      logger._setLogRootForTest(sandbox)

      expect(() => {
        logger.startSessionLog('sid-ok', 'testConfig', 'user@test.com', 'prof-ok')
      }).not.toThrow()

      expect(errors.length).toBe(0)
    })
  })

  describe('logSessionData for unknown session', () => {
    it('does NOT throw for an unknown session', () => {
      logger._setLogRootForTest(sandbox)

      expect(() => {
        logger.logSessionData('sid-unknown', 'some data chunk')
      }).not.toThrow()
    })

    it('surfaces a warning exactly ONCE even when called many times', () => {
      logger._setLogRootForTest(sandbox)
      const warnings: string[] = []
      logger._setErrorReporterForTest((msg) => warnings.push(msg))

      // Simulate many PTY data chunks for the same unknown sessionId.
      for (let i = 0; i < 50; i++) {
        logger.logSessionData('sid-no-meta', `chunk-${i}`)
      }

      // Exactly one warning for this session — no per-chunk flood.
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toMatch(/sid-no-meta/)
    })

    it('surfaces one warning per distinct unknown session (not repeated per call)', () => {
      logger._setLogRootForTest(sandbox)
      const warnings: string[] = []
      logger._setErrorReporterForTest((msg) => warnings.push(msg))

      for (let i = 0; i < 10; i++) logger.logSessionData('sid-a', `a-${i}`)
      for (let i = 0; i < 10; i++) logger.logSessionData('sid-b', `b-${i}`)

      // One warning per distinct unknown session.
      expect(warnings.length).toBe(2)
    })
  })
})
