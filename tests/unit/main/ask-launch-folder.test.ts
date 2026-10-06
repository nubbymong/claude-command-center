// [host] WP2 PR 4, P4.3 review RASK-1: an Ask Conductor launch runs in the
// help folder main has just rebuilt, on either assistant, on every route.
// pty:spawn makes that folder the launch's own (ask-conductor-handoff-ipc
// pins it there); here the REAL spawnPty (src/main/pty-manager.ts) holds a
// RESUMED conversation to it, which would otherwise start the CLI in the
// folder the conversation ran in:
//  - Claude Code: a restored tab's persisted conversation, and a Restart's
//    self-captured one (`claude --resume` runs in that conversation's folder);
//  - Codex: a restored tab's persisted conversation, and the one a Restart
//    resumes (main's kept conversation, starting where it ran).
// A conversation of another folder (the old help folder, after the resources
// folder moved) is not resumed: the launch starts afresh in the help folder.
// One of the help folder is resumed there. A session that is not Ask's is
// unchanged. Real temporary folders; node-pty records, nothing is started.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const UUID = '11111111-2222-3333-4444-555555555555'
const CODEX_ID = '019dd000-0001-7000-8000-0000000000a7'
const h = vi.hoisted(() => ({
  spawns: [] as Array<{ cwd: string }>,
  writes: [] as string[],
  built: [] as Array<Record<string, unknown>>,
  captured: null as { uuid: string; cwd: string } | null,
  // A stand-in for the volume's real-path answer for paths under the help
  // folder's parent (undefined: the real one).
  realpath: null as null | ((p: string) => string | undefined),
}))

// The real file system, with the native real path answerable per case (a
// case-sensitive volume, or a real path that cannot be read).
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const native = (p: import('fs').PathLike, o?: unknown): string => {
    const stood = h.realpath?.(String(p))
    return stood !== undefined ? stood : (real.realpathSync.native as (p: import('fs').PathLike, o?: unknown) => string)(p, o)
  }
  const realpathSync = Object.assign((p: import('fs').PathLike, o?: unknown) => (real.realpathSync as (p: import('fs').PathLike, o?: unknown) => string)(p, o), { native })
  return { ...real, default: { ...real, realpathSync }, realpathSync }
})

vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: unknown, opts: { cwd: string }) => {
    h.spawns.push({ cwd: opts.cwd })
    return {
      pid: 7400, process: 'x',
      onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }),
      write: (d: string) => { h.writes.push(d) }, resize: () => {}, kill: () => {},
    }
  },
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
// The Claude resume's own disk checks are upstream of what is under test: the
// stub answers as the real helper does when the conversation's folder and
// transcript exist (canvas-root-provenance.test.ts does the same).
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  resolveResumeLaunch: (target?: { uuid: string; cwd: string }) => (target ? { resumeUuid: target.uuid, claudeCwd: target.cwd } : null),
}))
vi.mock('../../../src/main/logging/transcript-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/logging/transcript-discovery')>()),
  resolveResumeTargetFromTranscript: () => h.captured,
}))
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => null,
  // A Restart's self-captured conversation: the exact bind of the run it ends.
  getTranscriptBinder: () => (h.captured ? { getExactResumeTarget: () => `/transcripts/${UUID}.jsonl`, getLatestTranscriptPath: () => `/transcripts/${UUID}.jsonl` } : null),
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {}, releaseMcpSessionProvider: () => {} }))
vi.mock('../../../src/main/providers', () => ({
  getProvider: (id: string) => (id === 'codex'
    ? {
        // A Codex builder that resumes what it is handed, where it is handed
        // it (the real builder's lookup is spawn-resume.test.ts's).
        buildSpawnCommand: (opts: Record<string, unknown>) => {
          h.built.push(opts)
          const resume = opts.resume as { uuid: string; cwd: string } | undefined
          return { cmd: '/proven/codex', args: [], env: {}, logLine: '', ...(resume ? { resumeId: resume.uuid, cwd: resume.cwd } : {}) }
        },
        ingestSessionTelemetry: () => ({ stop: () => {} }),
      }
    : { resolveBinary: () => ({ cmd: 'claude', source: 'system' }), buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../../src/main/canvas/codex-canvas-launch', () => ({ prepareCodexCanvasLaunch: () => ({ designatedWorktree: null, guidance: null }) }))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {}, writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
let tmp = ''
let help = ''
let old = ''
let seq = 0
let SID = ''
const codexLaunch = () => ({ lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: path.join(tmp, 'codex-home') }, sessionsDir: path.join(tmp, 'codex-home', 'sessions'), home: path.join(tmp, 'codex-home') }) as unknown as SpawnOpts['codexLaunch']
const claude = (extra: Partial<SpawnOpts>): void => { spawnPty(fakeWin, SID, { cols: 100, rows: 30, ...extra }) }
const codex = (extra: Partial<SpawnOpts>): void => {
  spawnPty(fakeWin, SID, { cols: 100, rows: 30, provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch(), ...extra })
}
/** The Claude launch command, written into the PTY once its shell is up. */
const launchLine = async (): Promise<string> => {
  const deadline = Date.now() + 5_000
  while (!h.writes.some((w) => w.includes('claude')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return h.writes.find((w) => w.includes('claude')) ?? ''
}

beforeEach(() => {
  SID = `askf${String(++seq).padStart(20, '0')}`
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ask-folder-')))
  help = path.join(tmp, 'res-now', 'help')
  old = path.join(tmp, 'res-before', 'help')
  fs.mkdirSync(help, { recursive: true })
  fs.mkdirSync(old, { recursive: true })
  h.spawns = []
  h.writes = []
  h.built = []
  h.captured = null
  h.realpath = null
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Claude Code: a resumed Ask conversation is held to the help folder', () => {
  it('[host] a restored tab whose conversation ran in another folder: started afresh in the help folder', async () => {
    claude({ cwd: help, isAsk: true, resume: { uuid: UUID, cwd: old } })
    expect(h.spawns[0].cwd).toBe(help)
    expect(await launchLine()).not.toContain('--resume')
  })

  it('[host] a Restart whose conversation ran in another folder (self-captured): the same', async () => {
    h.captured = { uuid: UUID, cwd: old }
    claude({ cwd: help, isAsk: true })
    expect(h.spawns[0].cwd).toBe(help)
    expect(await launchLine()).not.toContain('--resume')
  })

  it('[host] a conversation of the help folder itself: resumed there', async () => {
    claude({ cwd: help, isAsk: true, resume: { uuid: UUID, cwd: help } })
    expect(h.spawns[0].cwd).toBe(help)
    expect(await launchLine()).toContain(`--resume ${UUID}`)
  })

  it('[host] a session that is not Ask\'s: resumed in its conversation\'s folder, as before', async () => {
    claude({ cwd: help, resume: { uuid: UUID, cwd: old } })
    expect(h.spawns[0].cwd).toBe(old)
    expect(await launchLine()).toContain(`--resume ${UUID}`)
  })
})

describe('Codex: a resumed Ask conversation is held to the help folder', () => {
  it('[host] a restored tab whose conversation ran in another folder: started afresh in the help folder', () => {
    codex({ cwd: help, isAsk: true, resume: { uuid: CODEX_ID, cwd: old } })
    expect(h.built[0].resume).toBeUndefined()
    expect(h.spawns[0].cwd).toBe(help)
  })

  it('[host] a Restart after the resources folder moved: the kept conversation ran in the old folder, so it is not resumed', () => {
    // The tab's run in the old folder resumed (and keeps) its conversation.
    codex({ cwd: old, isAsk: true, resume: { uuid: CODEX_ID, cwd: old } })
    expect(h.built[0].resume).toEqual({ uuid: CODEX_ID, cwd: old })
    // Restart, after the move: the folder main rebuilt is the new one.
    codex({ cwd: help, isAsk: true })
    expect(h.built[1].resume).toBeUndefined()
    expect(h.spawns[1].cwd).toBe(help)
  })

  it('[host] a conversation of the help folder itself: resumed, starting there', () => {
    codex({ cwd: help, isAsk: true, resume: { uuid: CODEX_ID, cwd: help } })
    expect(h.built[0].resume).toEqual({ uuid: CODEX_ID, cwd: help })
    expect(h.spawns[0].cwd).toBe(help)
    // And a Restart resumes it again.
    codex({ cwd: help, isAsk: true })
    expect(h.built[1].resume).toEqual({ uuid: CODEX_ID, cwd: help })
  })

  it('[host] Past discussions (the picker): runs in the help folder', () => {
    codex({ cwd: help, isAsk: true, useResumePicker: true })
    expect(h.built[0].useResumePicker).toBe(true)
    expect(h.built[0].resume).toBeUndefined()
    expect(h.spawns[0].cwd).toBe(help)
  })

  it('[host] a session that is not Ask\'s: resumed where its conversation ran, as before', () => {
    codex({ cwd: help, resume: { uuid: CODEX_ID, cwd: old } })
    expect(h.built[0].resume).toEqual({ uuid: CODEX_ID, cwd: old })
    expect(h.spawns[0].cwd).toBe(old)
  })
})

describe('the help folder is compared by its real path, then its exact spelling (U4.11; the PR 4 final VM run)', () => {
  // A folder named in other letters: on a case-insensitive volume (Windows,
  // macOS) the same folder, whose real path comes back in the on-disk case;
  // on a case-sensitive one, another folder.
  const otherCase = (p: string): string => path.join(path.dirname(p), path.basename(p).toUpperCase())
  /** This volume ignores case (the temporary folder answers in other letters),
   *  probed when the tests are collected, so a skip shows in the report. */
  const CASELESS = ((): boolean => {
    try {
      const t = fs.realpathSync.native(os.tmpdir())
      return t.toUpperCase() !== t && fs.realpathSync.native(t.toUpperCase()) === t
    } catch { return false }
  })()
  const under = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep)

  // On a case-sensitive volume no other spelling of the same folder exists:
  // skipped there (visibly), the stand-in case-sensitive case below runs.
  it.skipIf(!CASELESS)('[host] the resources setting spelled in other letters (the same folder on this volume): Codex resumes, in the folder the rebuild returned', () => {
    const setting = otherCase(help)
    codex({ cwd: setting, isAsk: true, resume: { uuid: CODEX_ID, cwd: help } })
    expect(h.built[0].resume).toEqual({ uuid: CODEX_ID, cwd: setting })
    expect(h.spawns[0].cwd).toBe(setting)
  })

  it.skipIf(!CASELESS)('[host] Claude Code the same: a Restart resumes its conversation', async () => {
    const setting = otherCase(help)
    claude({ cwd: setting, isAsk: true, resume: { uuid: UUID, cwd: help } })
    expect(h.spawns[0].cwd).toBe(setting)
    expect(await launchLine()).toContain(`--resume ${UUID}`)
  })

  it('[host] a case-sensitive volume (its real paths stood in): a folder differing only in case is another folder, so started fresh', async () => {
    const root = path.dirname(help)
    h.realpath = (p) => (under(path.resolve(p), root) ? path.resolve(p) : undefined)
    codex({ cwd: help, isAsk: true, resume: { uuid: CODEX_ID, cwd: otherCase(help) } })
    expect(h.built[0].resume).toBeUndefined()
    expect(h.spawns[0].cwd).toBe(help)
    claude({ cwd: help, isAsk: true, resume: { uuid: UUID, cwd: otherCase(help) } })
    expect(await launchLine()).not.toContain('--resume')
  })

  it('[host] a real path that cannot be read: started fresh, never guessed from the spelling', async () => {
    const root = path.dirname(help)
    h.realpath = (p) => {
      if (under(path.resolve(p), root)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return undefined
    }
    codex({ cwd: help, isAsk: true, resume: { uuid: CODEX_ID, cwd: help } })
    expect(h.built[0].resume).toBeUndefined()
    claude({ cwd: help, isAsk: true, resume: { uuid: UUID, cwd: help } })
    expect(await launchLine()).not.toContain('--resume')
  })

  it('[host] separators and a trailing one: the same folder, resumed', () => {
    const spellings = [help + path.sep, help + path.sep + path.sep, ...(process.platform === 'win32' ? [help.replace(/\\/g, '/'), help.replace(/\\/g, '/') + '/'] : [])]
    for (const spelled of spellings) {
      h.built = []
      codex({ cwd: help, isAsk: true, resume: { uuid: CODEX_ID, cwd: spelled } })
      expect(h.built[0].resume, spelled).toEqual({ uuid: CODEX_ID, cwd: help })
    }
  })

  it('[host] a spelling through `..` that reaches the help folder: the same folder, resumed', () => {
    fs.mkdirSync(path.join(path.dirname(help), 'x'))
    const roundabout = path.join(path.dirname(help), 'x') + path.sep + '..' + path.sep + 'help'
    codex({ cwd: help, isAsk: true, resume: { uuid: CODEX_ID, cwd: roundabout } })
    expect(h.built[0].resume).toEqual({ uuid: CODEX_ID, cwd: help })
  })
})
