/**
 * Pure unit tests for buildClaudeLaunchCommand (T8b — exact-conversation resume).
 *
 * This is a plain vitest test — the function under test is a PURE string
 * builder extracted from pty-manager's Claude launch path. It has zero runtime
 * deps (no node-pty, no Electron), so it unit-tests without any native ABI.
 *
 * Two contracts are pinned here:
 *   1. GOLDEN (no resume): when no resumeUuid is supplied the produced command
 *      string is BYTE-IDENTICAL to the pre-refactor inline construction, for
 *      every branch (picker / picker-fallback / direct) × platform.
 *   2. RESUME: when a resumeUuid IS supplied, the picker branch is BYPASSED and
 *      `--resume <uuid>` is emitted FIRST (before --settings/--mcp-config/etc.),
 *      mirroring scripts/resume-picker.js:299 ordering, with the cwd overridden.
 */
import { describe, it, expect } from 'vitest'
import { buildClaudeLaunchCommand } from '../../../src/main/spawn-claude-command'

const CWD = 'F:\\proj\\worktree'
const CLAUDE = 'C:\\bin\\claude.cmd'
const PICKER = 'C:\\res\\scripts\\resume-picker.js'
const UUID = '11111111-2222-3333-4444-555555555555'
const EXTRA = " --settings 'C:\\s.json' --mcp-config 'C:\\m.json'"
const AGENTS = " --agents '[]'"

// --- helper that reproduces the EXACT pre-refactor inline construction -------
// Lifted VERBATIM from pty-manager.ts (HEAD, lines 1024 + 1048-1066) as the
// golden reference, including the original `escapedCwd = resolvedCwd.replace(
// /'/g,"''")` win32-doubling that was applied on BOTH platforms, with the posix
// branch additionally re-escaping it. For quote-free cwds (every parametrized
// case below) both escapings are no-ops, so this proves byte-identity for the
// common case across platforms.
function goldenNoResume(opts: {
  platform: 'win32' | 'posix'
  cwd: string
  claudeBin: string
  extraFlags: string
  agentsFlag: string
  useResumePicker: boolean
  pickerScript: string | null
}): string {
  const { platform, cwd, claudeBin, extraFlags, agentsFlag, useResumePicker, pickerScript } = opts
  const win32 = platform === 'win32'
  // ORIGINAL: escapedCwd always used win32 doubling, posix re-escaped it inline.
  const escapedCwd = cwd.replace(/'/g, "''")
  const posixCwd = escapedCwd.replace(/'/g, "'\\''")
  if (useResumePicker) {
    if (pickerScript && win32) {
      const escapedScript = pickerScript.replace(/'/g, "''")
      return `Set-Location '${escapedCwd}'; node '${escapedScript}'${extraFlags}; exit`
    } else if (pickerScript) {
      return `cd '${posixCwd}' && node '${pickerScript.replace(/'/g, "'\\''")}'${extraFlags}; exit`
    } else {
      return win32
        ? `Set-Location '${escapedCwd}'; & "${claudeBin}"${agentsFlag}${extraFlags}; exit`
        : `cd '${posixCwd}' && "${claudeBin}"${agentsFlag}${extraFlags}; exit`
    }
  }
  return win32
    ? `Set-Location '${escapedCwd}'; & "${claudeBin}"${agentsFlag}${extraFlags}; exit`
    : `cd '${posixCwd}' && "${claudeBin}"${agentsFlag}${extraFlags}; exit`
}

describe('buildClaudeLaunchCommand — GOLDEN (no resumeUuid, byte-identical)', () => {
  const cases: Array<{ platform: 'win32' | 'posix'; useResumePicker: boolean; pickerScript: string | null; label: string }> = [
    { platform: 'win32', useResumePicker: false, pickerScript: null, label: 'win32 direct' },
    { platform: 'posix', useResumePicker: false, pickerScript: null, label: 'posix direct' },
    { platform: 'win32', useResumePicker: true, pickerScript: PICKER, label: 'win32 picker' },
    { platform: 'posix', useResumePicker: true, pickerScript: PICKER, label: 'posix picker' },
    { platform: 'win32', useResumePicker: true, pickerScript: null, label: 'win32 picker-fallback' },
    { platform: 'posix', useResumePicker: true, pickerScript: null, label: 'posix picker-fallback' },
  ]

  for (const c of cases) {
    it(`${c.label} is byte-identical to inline golden`, () => {
      const out = buildClaudeLaunchCommand({
        platform: c.platform,
        cwd: CWD,
        claudeBin: CLAUDE,
        extraFlags: EXTRA,
        agentsFlag: AGENTS,
        useResumePicker: c.useResumePicker,
        pickerScript: c.pickerScript,
      })
      const golden = goldenNoResume({
        platform: c.platform,
        cwd: CWD,
        claudeBin: CLAUDE,
        extraFlags: EXTRA,
        agentsFlag: AGENTS,
        useResumePicker: c.useResumePicker,
        pickerScript: c.pickerScript,
      })
      expect(out).toBe(golden)
    })
  }

  it('preserves single-quote escaping in the cwd (win32 doubling)', () => {
    const out = buildClaudeLaunchCommand({
      platform: 'win32', cwd: "F:\\o'brien", claudeBin: CLAUDE,
      extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null,
    })
    expect(out).toContain("Set-Location 'F:\\o''brien'")
  })

  it('uses clean single-escape for posix cwds with a quote (fixes the old double-escape)', () => {
    // The pre-refactor code applied win32-doubling THEN posix-escaping to the
    // SAME string, mangling posix cwds with single quotes. The builder escapes
    // the raw cwd once for the target shell — a strict improvement. Windows
    // (the shipped platform) is unaffected: its cwds never reach this branch.
    const out = buildClaudeLaunchCommand({
      platform: 'posix', cwd: "/home/o'brien", claudeBin: '/usr/bin/claude',
      extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null,
    })
    expect(out).toContain("cd '/home/o'\\''brien'")
  })
})

describe('buildClaudeLaunchCommand — RESUME (resumeUuid present)', () => {
  it('win32: emits --resume <uuid> FIRST, bypasses the picker, keeps later flags', () => {
    const out = buildClaudeLaunchCommand({
      platform: 'win32', cwd: CWD, claudeBin: CLAUDE,
      extraFlags: EXTRA, agentsFlag: AGENTS,
      useResumePicker: true, pickerScript: PICKER,
      resumeUuid: UUID,
    })
    // picker is bypassed entirely
    expect(out).not.toContain('resume-picker.js')
    expect(out).not.toContain('node ')
    // direct claude launch with --resume first
    expect(out).toBe(`Set-Location '${CWD.replace(/'/g, "''")}'; & "${CLAUDE}" --resume ${UUID}${AGENTS}${EXTRA}; exit`)
    // ordering: --resume precedes --settings / --mcp-config / --agents
    expect(out.indexOf('--resume')).toBeLessThan(out.indexOf('--settings'))
    expect(out.indexOf('--resume')).toBeLessThan(out.indexOf('--agents'))
  })

  it('posix: emits --resume <uuid> FIRST, bypasses the picker', () => {
    const out = buildClaudeLaunchCommand({
      platform: 'posix', cwd: '/work/wt', claudeBin: '/usr/bin/claude',
      extraFlags: EXTRA, agentsFlag: AGENTS,
      useResumePicker: true, pickerScript: PICKER,
      resumeUuid: UUID,
    })
    expect(out).not.toContain('resume-picker.js')
    expect(out).toBe(`cd '/work/wt' && "/usr/bin/claude" --resume ${UUID}${AGENTS}${EXTRA}; exit`)
  })

  it('resume bypasses the picker even when useResumePicker is true', () => {
    const withUuid = buildClaudeLaunchCommand({
      platform: 'win32', cwd: CWD, claudeBin: CLAUDE,
      extraFlags: EXTRA, agentsFlag: AGENTS,
      useResumePicker: true, pickerScript: PICKER, resumeUuid: UUID,
    })
    expect(withUuid).toContain(`--resume ${UUID}`)
    expect(withUuid).not.toContain('node ')
  })
})
