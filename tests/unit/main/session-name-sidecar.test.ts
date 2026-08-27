/**
 * Unit tests for session-name-sidecar (#536) — the pure name-carry helpers.
 * All I/O is injected; no disk. Covers path derivation, write/clear, read,
 * injection safety (JSON.stringify), best-effort no-throw, and the pending-name
 * registry that bridges "renamed before the transcript is bound".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  sidecarPathFor,
  writeNameSidecar,
  readNameSidecar,
  rememberSessionName,
  getRememberedName,
  forgetSessionName,
} from '../../../src/main/logging/session-name-sidecar'

const TRANSCRIPT = 'C:\\Users\\jane\\.claude\\projects\\F--repo\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
const SIDECAR = 'C:\\Users\\jane\\.claude\\projects\\F--repo\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.ccc-name.json'

function makeDeps(over: Partial<{ writeFile: any; readFile: any; removeFile: any; now: any }> = {}) {
  return {
    writeFile: vi.fn(over.writeFile),
    readFile: vi.fn(over.readFile ?? (() => { throw new Error('ENOENT') })),
    removeFile: vi.fn(over.removeFile),
    now: over.now ?? (() => 1700000000000),
  }
}

describe('sidecarPathFor', () => {
  it('maps <uuid>.jsonl → <uuid>.ccc-name.json', () => {
    expect(sidecarPathFor(TRANSCRIPT)).toBe(SIDECAR)
  })
  it('returns null for a non-.jsonl path', () => {
    expect(sidecarPathFor('C:\\x\\notes.txt')).toBeNull()
    expect(sidecarPathFor('C:\\x\\file.jsonl.bak')).toBeNull()
  })
  it('returns null for a non-string', () => {
    // @ts-expect-error deliberately wrong type
    expect(sidecarPathFor(undefined)).toBeNull()
  })
})

describe('writeNameSidecar', () => {
  it('writes {name, updatedAt} JSON to the sidecar path', () => {
    const deps = makeDeps()
    writeNameSidecar(TRANSCRIPT, '  aai-core | INSIGHTS FU  ', deps)
    expect(deps.writeFile).toHaveBeenCalledTimes(1)
    const [p, data] = deps.writeFile.mock.calls[0]
    expect(p).toBe(SIDECAR)
    expect(JSON.parse(data)).toEqual({ name: 'aai-core | INSIGHTS FU', updatedAt: 1700000000000 })
  })

  it('an empty / blank name REMOVES the sidecar (rename back to default clears it)', () => {
    const deps = makeDeps()
    writeNameSidecar(TRANSCRIPT, '   ', deps)
    expect(deps.removeFile).toHaveBeenCalledWith(SIDECAR)
    expect(deps.writeFile).not.toHaveBeenCalled()
  })

  it('a non-transcript path is a no-op', () => {
    const deps = makeDeps()
    writeNameSidecar('C:\\x\\notes.txt', 'name', deps)
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(deps.removeFile).not.toHaveBeenCalled()
  })

  it('injection: a name with quotes / newlines / structure is escaped by JSON.stringify (no breakout)', () => {
    const deps = makeDeps()
    const evil = '", "updatedAt": 0, "x": "\n}{ evil'
    writeNameSidecar(TRANSCRIPT, evil, deps)
    const [, data] = deps.writeFile.mock.calls[0]
    // Round-trips to exactly the name; no extra keys, no structure injected.
    expect(JSON.parse(data)).toEqual({ name: evil.trim(), updatedAt: 1700000000000 })
  })

  it('best-effort: a throwing writeFile does not propagate', () => {
    const deps = makeDeps({ writeFile: () => { throw new Error('EACCES') } })
    expect(() => writeNameSidecar(TRANSCRIPT, 'name', deps)).not.toThrow()
  })

  it('best-effort: a throwing removeFile (clearing) does not propagate', () => {
    const deps = makeDeps({ removeFile: () => { throw new Error('EBUSY') } })
    expect(() => writeNameSidecar(TRANSCRIPT, '', deps)).not.toThrow()
  })
})

describe('readNameSidecar', () => {
  it('returns the trimmed name from a valid sidecar', () => {
    const deps = { readFile: () => JSON.stringify({ name: '  my work  ', updatedAt: 1 }) }
    expect(readNameSidecar(TRANSCRIPT, deps)).toBe('my work')
  })
  it('returns null for a blank name', () => {
    const deps = { readFile: () => JSON.stringify({ name: '   ' }) }
    expect(readNameSidecar(TRANSCRIPT, deps)).toBeNull()
  })
  it('returns null on missing file / bad JSON', () => {
    expect(readNameSidecar(TRANSCRIPT, { readFile: () => { throw new Error('ENOENT') } })).toBeNull()
    expect(readNameSidecar(TRANSCRIPT, { readFile: () => 'not json' })).toBeNull()
  })
  it('returns null for a non-transcript path (never reads)', () => {
    const readFile = vi.fn(() => '{"name":"x"}')
    expect(readNameSidecar('C:\\x\\notes.txt', { readFile })).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('pending-name registry', () => {
  beforeEach(() => { forgetSessionName('sid1'); forgetSessionName('sid2') })

  it('remembers and reads back the latest name', () => {
    rememberSessionName('sid1', '  work A  ')
    expect(getRememberedName('sid1')).toBe('work A')
    rememberSessionName('sid1', 'work B')
    expect(getRememberedName('sid1')).toBe('work B')
  })
  it('a blank name clears the remembered entry', () => {
    rememberSessionName('sid1', 'work')
    rememberSessionName('sid1', '   ')
    expect(getRememberedName('sid1')).toBeNull()
  })
  it('forget drops the entry', () => {
    rememberSessionName('sid2', 'work')
    forgetSessionName('sid2')
    expect(getRememberedName('sid2')).toBeNull()
  })
  it('unknown session → null', () => {
    expect(getRememberedName('nope')).toBeNull()
  })

  it('is bounded: past the cap the OLDEST entries are evicted (renderer cannot grow it without limit)', () => {
    // The rename IPC is renderer-reachable with an arbitrary sessionId; the map
    // must never grow unbounded even if entries are never retired.
    const N = 700 // > MAX_PENDING_NAMES (512)
    for (let i = 0; i < N; i++) rememberSessionName(`leak-${i}`, `name-${i}`)
    // The earliest inserted entries were evicted; the most recent survive.
    expect(getRememberedName('leak-0')).toBeNull()
    expect(getRememberedName(`leak-${N - 1}`)).toBe(`name-${N - 1}`)
    for (let i = 0; i < N; i++) forgetSessionName(`leak-${i}`)
  })
})
