/**
 * One log record is one physical line, so a CR or LF inside an interpolated
 * value ends the record early and everything after it becomes a line the value's
 * author controls -- fabricated timestamp, level and subsystem tag included.
 *
 * Several values interpolated into log lines in this app are remote-influenced:
 * a transcript path lifted off an SSH statusline sentinel (the remote host
 * decides it), and fields from a hook POST body. Forging `[ERROR] [ssh] ...`
 * records is a cheap way to mislead whoever reads app.log after an incident, and
 * flooding rotates genuine history away. Found by the adversarial pass on #180.
 *
 * Escaped at the SINK, not at each caller: the callers are many, several are on
 * hot paths, and one that forgets is invisible until a human reads the log.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The real debug-logger, not the global test mock — the formatting IS the subject.
vi.unmock('../../../src/main/debug-logger')

const writes: string[] = []
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: () => true,
    mkdirSync: vi.fn(),
    statSync: () => ({ size: 0 }),
    // The write path now opens the fd synchronously (fs.openSync) and hands it to
    // createWriteStream (#487 rotation fix, so a sync burst rotates deterministically).
    // Mock openSync too: otherwise the REAL openSync runs against a dir mkdirSync
    // was mocked away, throws ENOENT in a clean env (CI), drops the logger to
    // console-only, and captures nothing — the formatting under test never runs.
    openSync: () => 1,
    createWriteStream: () => ({
      write: (chunk: string) => { writes.push(String(chunk)); return true },
      end: vi.fn(),
      on: vi.fn(),
    }),
  }
})

const { logInfo, logError, setVerboseMode } = await import('../../../src/main/debug-logger')

beforeEach(() => {
  writes.length = 0
  setVerboseMode?.(true)
})

/** Every physical line the logger produced. */
function lines(): string[] {
  return writes.join('').split('\n').filter((l) => l.length > 0)
}

describe('a logged value cannot forge a log record', () => {
  it('escapes an embedded LF instead of ending the record', () => {
    logInfo('[binder] rawPath=/x\n[2026-08-03T00:00:00.000Z] [ERROR] [ssh] host key verified OK')
    // The forged half must NOT become a record of its own. Asserted by looking
    // for a line the attacker would have authored, rather than by counting lines
    // (the logger may emit its own header on first use).
    expect(lines().some((l) => l.startsWith('[2026-08-03T00:00:00.000Z] [ERROR]'))).toBe(false)
    const record = lines().find((l) => l.includes('rawPath='))
    expect(record).toBeDefined()
    // ...and the whole value is still there, on that one record, escaped.
    expect(record).toContain('\\n')
    expect(record).toContain('host key verified OK')
  })

  it('escapes CR as well, so a lone CR cannot split a record either', () => {
    logInfo('a\rb')
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toContain('\\r')
  })

  it('escapes newlines inside a stringified object argument', () => {
    logInfo('ctx', { path: 'x\n[FAKE] injected' })
    expect(lines()).toHaveLength(1)
  })

  it('still writes the record, with the value visible and escaped', () => {
    // Escaping, not dropping: a reader must still be able to see what arrived.
    logInfo('[binder] rawPath=/tmp/a\nb')
    expect(lines()[0]).toContain('/tmp/a\\nb')
  })

  it('KEEPS a real stack trace multi-line — those newlines are ours', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at frameOne\n    at frameTwo'
    logError('failed:', err)
    // A stack is meant to be read across lines; escaping it would make every
    // error report unreadable to buy nothing.
    expect(lines().length).toBeGreaterThan(1)
    expect(writes.join('')).toContain('at frameOne')
  })

  it('leaves an ordinary single-line message byte-identical', () => {
    logInfo('[hooks] 200 sid=abc bytes=123')
    expect(lines()[0]).toMatch(/\[INFO\] \[hooks\] 200 sid=abc bytes=123$/)
    expect(lines()[0]).not.toContain('\\n')
  })
})
