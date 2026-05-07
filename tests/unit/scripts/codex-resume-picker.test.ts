import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Helper module is plain Node.js (CommonJS); use require() to import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as {
  parseRollout: (text: string) => null | { id: string; cwd: string; model: string; effort?: string; label: string }
  walkRollouts: (home: string, maxDays: number, cwd: string) => Array<{ id: string; cwd: string; model: string; effort?: string; label: string; mtime: number }>
  buildResumeArgs: (uuid: string | null, flags: string[]) => string[]
  shouldFallback: (resumeUuid: string | null, exitStatus: number | null | undefined) => boolean
  shouldUseShell: (cmd: string, platform: string) => boolean
}

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'codex-rollouts')

describe('codex-resume-picker parseRollout', () => {
  it('returns id/cwd/model/effort/label for a matching-cwd rollout', () => {
    const text = readFileSync(join(FIXTURES, 'matching-cwd.jsonl'), 'utf-8')
    const r = lib.parseRollout(text)
    expect(r).not.toBeNull()
    expect(r!.id).toBe('019dd000-0001-7000-0000-000000000001')
    expect(r!.cwd).toBe('F:\\test\\fixture-cwd')
    expect(r!.model).toBe('gpt-5.5')
    expect(r!.effort).toBe('xhigh')
    expect(r!.label).toBe('refactor the auth module')
  })

  it('extracts cwd from session_meta even when turn_context is missing', () => {
    // Single-line file with only session_meta.
    const text = '{"type":"session_meta","payload":{"id":"u-1","cwd":"/some/cwd","cli_version":"0.128.0"}}\n'
    const r = lib.parseRollout(text)
    expect(r).not.toBeNull()
    expect(r!.cwd).toBe('/some/cwd')
    expect(r!.label).toBe('(continued session)')
  })

  it('returns null when first line is malformed', () => {
    const text = readFileSync(join(FIXTURES, 'malformed.jsonl'), 'utf-8')
    const r = lib.parseRollout(text)
    expect(r).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(lib.parseRollout('')).toBeNull()
  })

  it('finds turn_context even when not on line 2', () => {
    // session_meta on line 1, then noise, then turn_context on line 4
    const lines = [
      '{"type":"session_meta","payload":{"id":"u-2","cwd":"/x","cli_version":"0.1"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"message"}}',
      '{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}',
    ].join('\n')
    const r = lib.parseRollout(lines)
    expect(r).not.toBeNull()
    expect(r!.model).toBe('gpt-5.4')
    expect(r!.effort).toBe('high')
  })
})

describe('codex-resume-picker walkRollouts', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ccc-codex-walk-'))
    // Layout under home/sessions/YYYY/MM/DD/rollout-*.jsonl
    const today = new Date()
    const y = String(today.getUTCFullYear())
    const m = String(today.getUTCMonth() + 1).padStart(2, '0')
    const d = String(today.getUTCDate()).padStart(2, '0')
    const dir = join(home, 'sessions', y, m, d)
    mkdirSync(dir, { recursive: true })
    // Two matching, one non-matching
    copyFileSync(join(FIXTURES, 'matching-cwd.jsonl'), join(dir, 'rollout-001-aaa.jsonl'))
    copyFileSync(join(FIXTURES, 'matching-cwd.jsonl'), join(dir, 'rollout-002-bbb.jsonl'))
    copyFileSync(join(FIXTURES, 'non-matching-cwd.jsonl'), join(dir, 'rollout-003-ccc.jsonl'))
  })

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  })

  it('filters to matching cwd only', () => {
    const out = lib.walkRollouts(home, 30, 'F:\\test\\fixture-cwd')
    expect(out).toHaveLength(2)
    for (const r of out) expect(r.cwd).toBe('F:\\test\\fixture-cwd')
  })

  it('returns empty array when no rollouts match', () => {
    const out = lib.walkRollouts(home, 30, 'F:\\unrelated\\cwd')
    expect(out).toHaveLength(0)
  })

  it('returns empty array when sessions dir does not exist', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ccc-codex-empty-'))
    try {
      const out = lib.walkRollouts(empty, 30, 'F:\\anything')
      expect(out).toHaveLength(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('codex-resume-picker buildResumeArgs', () => {
  it('prepends `resume <uuid>` then forwards flags when uuid is given', () => {
    const flags = ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=xhigh', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
    const out = lib.buildResumeArgs('uuid-abc', flags)
    expect(out[0]).toBe('resume')
    expect(out[1]).toBe('uuid-abc')
    expect(out.slice(2)).toEqual(flags)
  })

  it('returns just the flags when uuid is null (fresh session)', () => {
    const flags = ['-m', 'gpt-5.5']
    const out = lib.buildResumeArgs(null, flags)
    expect(out).toEqual(flags)
  })
})

describe('codex-resume-picker shouldFallback', () => {
  it('returns true when resume was attempted and exited non-zero', () => {
    expect(lib.shouldFallback('uuid-abc', 1)).toBe(true)
    expect(lib.shouldFallback('uuid-abc', 127)).toBe(true)
  })

  it('returns false when resume was attempted and exited 0', () => {
    expect(lib.shouldFallback('uuid-abc', 0)).toBe(false)
  })

  it('returns false when resume was not attempted (uuid null), regardless of exitStatus', () => {
    expect(lib.shouldFallback(null, 1)).toBe(false)
    expect(lib.shouldFallback(null, 0)).toBe(false)
  })

  it('returns false when exitStatus is null (spawn failure -- fresh fallback would also fail)', () => {
    expect(lib.shouldFallback('uuid-abc', null)).toBe(false)
  })

  it('returns false when exitStatus is undefined (defensive, same reasoning as null)', () => {
    expect(lib.shouldFallback('uuid-abc', undefined)).toBe(false)
  })
})

describe('codex-resume-picker shouldUseShell', () => {
  it('returns false on linux for any cmd (including .exe paths)', () => {
    expect(lib.shouldUseShell('/usr/local/bin/codex.exe', 'linux')).toBe(false)
  })

  it('returns false on darwin for a bare command name', () => {
    expect(lib.shouldUseShell('codex', 'darwin')).toBe(false)
  })

  it('returns false on win32 when cmd ends with .exe', () => {
    expect(lib.shouldUseShell('C:\\path\\codex.exe', 'win32')).toBe(false)
  })

  it('returns true on win32 when cmd ends with .cmd', () => {
    expect(lib.shouldUseShell('C:\\path\\codex.cmd', 'win32')).toBe(true)
  })

  it('returns true on win32 with uppercase .CMD (case insensitive)', () => {
    expect(lib.shouldUseShell('C:\\path\\codex.CMD', 'win32')).toBe(true)
  })

  it('returns true on win32 when cmd ends with .bat', () => {
    expect(lib.shouldUseShell('C:\\path\\codex.bat', 'win32')).toBe(true)
  })
})
