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
import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { buildClaudeLaunchCommand, resolveResumeLaunch, buildResumeTranscriptPath } from '../../../src/main/spawn-claude-command'

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
  // The binary and picker paths are SINGLE-quoted. This is a deliberate,
  // security-driven move of the golden: they used to be interpolated into
  // DOUBLE quotes, where PowerShell expands `$(...)` and POSIX expands
  // `$(...)`/backticks — a path containing either executed at launch. The
  // shape is otherwise byte-identical to the pre-refactor construction.
  const quotedBin = `'${claudeBin.replace(/'/g, win32 ? "''" : "'\\''")}'`
  const quotedPicker = pickerScript ? `'${pickerScript.replace(/'/g, win32 ? "''" : "'\\''")}'` : null
  if (useResumePicker) {
    // P1.1: the picker branch now also forwards agentsFlag (it previously
    // dropped --agents on a restored session). Oracle updated to the fixed shape.
    if (quotedPicker) {
      return win32
        ? `Set-Location '${escapedCwd}'; node ${quotedPicker}${agentsFlag}${extraFlags}; exit`
        : `cd '${posixCwd}' && node ${quotedPicker}${agentsFlag}${extraFlags}; exit`
    } else {
      return win32
        ? `Set-Location '${escapedCwd}'; & ${quotedBin}${agentsFlag}${extraFlags}; exit`
        : `cd '${posixCwd}' && ${quotedBin}${agentsFlag}${extraFlags}; exit`
    }
  }
  return win32
    ? `Set-Location '${escapedCwd}'; & ${quotedBin}${agentsFlag}${extraFlags}; exit`
    : `cd '${posixCwd}' && ${quotedBin}${agentsFlag}${extraFlags}; exit`
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

describe('buildClaudeLaunchCommand — picker forwards --agents (P1.1)', () => {
  // resume-picker.js forwards its own argv (process.argv.slice(2)) to
  // `claude --resume <id> ...`, so any flag passed to the picker survives the
  // launch. The picker branch previously appended extraFlags but NOT agentsFlag,
  // so a restored session silently lost its --agents subagents.
  it('win32 picker launch includes the --agents flag', () => {
    const out = buildClaudeLaunchCommand({
      platform: 'win32', cwd: CWD, claudeBin: CLAUDE,
      extraFlags: EXTRA, agentsFlag: AGENTS,
      useResumePicker: true, pickerScript: PICKER,
    })
    expect(out).toContain('resume-picker.js')
    expect(out).toContain(AGENTS.trim()) // --agents '[]'
  })

  it('posix picker launch includes the --agents flag', () => {
    const out = buildClaudeLaunchCommand({
      platform: 'posix', cwd: CWD, claudeBin: CLAUDE,
      extraFlags: EXTRA, agentsFlag: AGENTS,
      useResumePicker: true, pickerScript: PICKER,
    })
    expect(out).toContain('resume-picker.js')
    expect(out).toContain(AGENTS.trim())
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
    expect(out).toBe(`Set-Location '${CWD.replace(/'/g, "''")}'; & '${CLAUDE}' --resume ${UUID}${AGENTS}${EXTRA}; exit`)
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
    expect(out).toBe(`cd '/work/wt' && '/usr/bin/claude' --resume ${UUID}${AGENTS}${EXTRA}; exit`)
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

// ---------------------------------------------------------------------------
// resolveResumeLaunch — pure resume-launch decision (Fix 1 + Fix 2)
// ---------------------------------------------------------------------------
//
// Encapsulates the cwd/path existence gate that used to live inline in
// spawnPty. The CRITICAL contract (Fix 1) is the deleted-worktree case: when
// the resume target's REAL cwd no longer exists as a directory, the helper
// returns null (fall back to picker/direct) — it MUST NOT launch --resume from
// the homedir. The provider / discoveryOn gating stays in spawnPty (Fix 3); the
// helper is concerned only with paths.
describe('resolveResumeLaunch — gate', () => {
  const HOME = 'C:\\Users\\jane'
  const PROJECTS_ROOT = path.join(HOME, '.claude', 'projects')
  const T_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const REAL_CWD = 'F:\\proj\\worktree'

  // Build the canonical transcript + companion paths the way the helper does.
  const mangle = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
  const transcriptOf = (cwd: string, uuid: string) =>
    path.join(PROJECTS_ROOT, mangle(cwd), `${uuid}.jsonl`)
  const companionOf = (cwd: string, uuid: string) =>
    path.join(PROJECTS_ROOT, mangle(cwd), uuid)

  // A deps factory: by default every required path exists and is a directory
  // where it must be. Tests override the predicate to simulate misses.
  function makeDeps(opts: {
    existsPaths?: Set<string>
    dirPaths?: Set<string>
    homedir?: string
    projectsRoot?: string
    ensureCompanionDir?: (projectDir: string, uuid: string) => void
  } = {}) {
    const exists = opts.existsPaths
    const dirs = opts.dirPaths
    return {
      existsSync: (p: string) => (exists ? exists.has(p) : true),
      statSync: (p: string) => ({ isDirectory: () => (dirs ? dirs.has(p) : true) }),
      homedir: () => opts.homedir ?? HOME,
      mangleCwdToProjectDir: mangle,
      projectsRoot: opts.projectsRoot ?? PROJECTS_ROOT,
      ensureCompanionDir: opts.ensureCompanionDir ?? vi.fn(),
    }
  }

  const projDirOf = (cwd: string) => path.join(PROJECTS_ROOT, mangle(cwd))

  it('happy path: all paths present → returns { resumeUuid, claudeCwd }', () => {
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: REAL_CWD }, makeDeps())
    expect(out).toEqual({ resumeUuid: T_UUID, claudeCwd: path.resolve(REAL_CWD) })
  })

  it('REGRESSION (Fix 1): missing target cwd (deleted worktree) → null, never homedir', () => {
    // The transcript + companion still exist on disk, but the worktree dir is
    // GONE. The old inline gate let resolveCwd() collapse this to homedir and
    // launched --resume there. The helper must return null instead.
    const existsPaths = new Set<string>([
      transcriptOf(REAL_CWD, T_UUID),
      companionOf(REAL_CWD, T_UUID),
      // REAL_CWD intentionally absent.
    ])
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: REAL_CWD }, makeDeps({ existsPaths, dirPaths: existsPaths }))
    expect(out).toBeNull()
  })

  it('target cwd exists but is a FILE not a directory → null', () => {
    const existsPaths = new Set<string>([
      transcriptOf(REAL_CWD, T_UUID),
      companionOf(REAL_CWD, T_UUID),
      path.resolve(REAL_CWD),
    ])
    // present but NOT a directory
    const dirPaths = new Set<string>([
      transcriptOf(REAL_CWD, T_UUID),
      companionOf(REAL_CWD, T_UUID),
    ])
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: REAL_CWD }, makeDeps({ existsPaths, dirPaths }))
    expect(out).toBeNull()
  })

  it('missing transcript file → null', () => {
    const existsPaths = new Set<string>([
      companionOf(REAL_CWD, T_UUID),
      path.resolve(REAL_CWD),
    ])
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: REAL_CWD }, makeDeps({ existsPaths, dirPaths: existsPaths }))
    expect(out).toBeNull()
  })

  it('missing companion dir → ENSURES it and still returns the launch (no longer a precondition)', () => {
    // THE FIX: a direct-work conversation (transcript present, companion dir
    // never created by the CLI) must still be resumable. The gate no longer
    // drops it — it ensures the companion dir and proceeds.
    const existsPaths = new Set<string>([
      transcriptOf(REAL_CWD, T_UUID),
      path.resolve(REAL_CWD),
      // companion dir intentionally absent
    ])
    const ensureCompanionDir = vi.fn()
    const out = resolveResumeLaunch(
      { uuid: T_UUID, cwd: REAL_CWD },
      makeDeps({ existsPaths, dirPaths: existsPaths, ensureCompanionDir }),
    )
    expect(out).toEqual({ resumeUuid: T_UUID, claudeCwd: path.resolve(REAL_CWD) })
    expect(ensureCompanionDir).toHaveBeenCalledWith(projDirOf(REAL_CWD), T_UUID)
  })

  it('happy path ensures the companion dir with the project dir + uuid', () => {
    const ensureCompanionDir = vi.fn()
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: REAL_CWD }, makeDeps({ ensureCompanionDir }))
    expect(out).toEqual({ resumeUuid: T_UUID, claudeCwd: path.resolve(REAL_CWD) })
    expect(ensureCompanionDir).toHaveBeenCalledTimes(1)
    expect(ensureCompanionDir).toHaveBeenCalledWith(projDirOf(REAL_CWD), T_UUID)
  })

  it('a throwing ensureCompanionDir still returns the launch (best-effort ensure, never drops resume)', () => {
    const ensureCompanionDir = vi.fn(() => { throw new Error('EACCES') })
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: REAL_CWD }, makeDeps({ ensureCompanionDir }))
    expect(out).toEqual({ resumeUuid: T_UUID, claudeCwd: path.resolve(REAL_CWD) })
  })

  it('a MISSING transcript still drops resume (we never resume a conversation with no transcript)', () => {
    // Guard against over-correction: ungating the companion dir must NOT also
    // ungate the transcript. No transcript => no conversation => fall back.
    const existsPaths = new Set<string>([path.resolve(REAL_CWD)])
    const ensureCompanionDir = vi.fn()
    const out = resolveResumeLaunch(
      { uuid: T_UUID, cwd: REAL_CWD },
      makeDeps({ existsPaths, dirPaths: existsPaths, ensureCompanionDir }),
    )
    expect(out).toBeNull()
    expect(ensureCompanionDir).not.toHaveBeenCalled()
  })

  it('undefined target → null', () => {
    expect(resolveResumeLaunch(undefined, makeDeps())).toBeNull()
  })

  it('cwd === homedir is allowed when the home really is the captured cwd', () => {
    const existsPaths = new Set<string>([
      transcriptOf(HOME, T_UUID),
      companionOf(HOME, T_UUID),
      path.resolve(HOME),
    ])
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: HOME }, makeDeps({ existsPaths, dirPaths: existsPaths }))
    expect(out).toEqual({ resumeUuid: T_UUID, claudeCwd: path.resolve(HOME) })
  })

  it('expands a leading ~ to homedir for the cwd', () => {
    const home = os.homedir()
    const expanded = path.join(home, 'work', 'wt')
    const tildeCwd = '~/work/wt'
    const deps = {
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      homedir: () => home,
      mangleCwdToProjectDir: mangle,
      projectsRoot: path.join(home, '.claude', 'projects'),
      ensureCompanionDir: () => {},
    }
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: tildeCwd }, deps)
    expect(out).toEqual({ resumeUuid: T_UUID, claudeCwd: expanded })
  })

  it('bare ~ expands to homedir', () => {
    const home = os.homedir()
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: '~' }, {
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      homedir: () => home,
      mangleCwdToProjectDir: mangle,
      projectsRoot: path.join(home, '.claude', 'projects'),
      ensureCompanionDir: () => {},
    })
    expect(out).toEqual({ resumeUuid: T_UUID, claudeCwd: home })
  })

  it('fails open (returns null) if a dep throws', () => {
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: REAL_CWD }, {
      existsSync: () => { throw new Error('boom') },
      statSync: () => ({ isDirectory: () => true }),
      homedir: () => HOME,
      mangleCwdToProjectDir: mangle,
      projectsRoot: PROJECTS_ROOT,
      ensureCompanionDir: () => {},
    })
    expect(out).toBeNull()
  })

  it('FIX 4 (defense-in-depth): a non-UUID uuid → null, builds no command', () => {
    // Even with every path present, a uuid that is not the canonical UUID format
    // must be rejected before it can be interpolated UNQUOTED into the spawn
    // shell command. Belt-and-suspenders over the Zod schema; fail-open.
    const malicious = '$(rm -rf /)'
    const out = resolveResumeLaunch({ uuid: malicious, cwd: REAL_CWD }, makeDeps())
    expect(out).toBeNull()
  })

  it('FIX 4: a partial/garbage uuid string → null', () => {
    const out = resolveResumeLaunch({ uuid: 'not-a-uuid', cwd: REAL_CWD }, makeDeps())
    expect(out).toBeNull()
  })

  it('FIX 4: a canonical uuid still passes the new guard (no regression)', () => {
    const out = resolveResumeLaunch({ uuid: T_UUID, cwd: REAL_CWD }, makeDeps())
    expect(out).toEqual({ resumeUuid: T_UUID, claudeCwd: path.resolve(REAL_CWD) })
  })
})

// ---------------------------------------------------------------------------
// buildResumeTranscriptPath — deterministic resume-bind path (Part A)
// ---------------------------------------------------------------------------
//
// When pty-manager applies a resume with a KNOWN uuid + the conversation's real
// launch cwd, it binds that exact transcript IMMEDIATELY (no waiting for hooks /
// statusline / heuristic). This pure helper constructs the canonical transcript
// path it hands to binder.notifyTranscriptPath.
describe('buildResumeTranscriptPath — canonical ~/.claude/projects path', () => {
  const HOME = 'C:\\Users\\jane'
  const UUID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('joins homedir/.claude/projects/<mangle(cwd)>/<uuid>.jsonl', () => {
    const out = buildResumeTranscriptPath('F:\\proj\\worktree', UUID2, () => HOME)
    expect(out).toBe(path.join(HOME, '.claude', 'projects', 'F--proj-worktree', `${UUID2}.jsonl`))
  })

  it('mangles every non-alphanumeric char individually (no run-collapse)', () => {
    const out = buildResumeTranscriptPath('F:\\MY_PROJECT', UUID2, () => HOME)
    expect(out).toBe(path.join(HOME, '.claude', 'projects', 'F--MY-PROJECT', `${UUID2}.jsonl`))
  })

  it('returns null for a non-UUID stem (never builds a path from garbage)', () => {
    expect(buildResumeTranscriptPath('F:\\proj', 'not-a-uuid', () => HOME)).toBeNull()
  })

  it('returns null for an empty cwd', () => {
    expect(buildResumeTranscriptPath('', UUID2, () => HOME)).toBeNull()
  })
})
