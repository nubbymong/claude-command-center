// BLOCKER 1, second pass (adversarial review, 2026-08-15) — WHERE THE SERVED
// ROOT COMES FROM.
//
// The first fix moved `registerCanvasUatRoot` out of the pty:spawn IPC seam and
// into pty-manager, and its three tests asserted that by GREPPING THE SOURCE for
// the literal call `registerCanvasUatRoot(sessionId, claudeCwd)`. The call was
// indeed in the right file. The value was not: `claudeCwd` starts as the
// configured cwd and is then OVERWRITTEN by
// `resolveResumeLaunch(effectiveTarget).claudeCwd`, which is `target.cwd`, which
// for the self-captured route is the first `cwd` string in the conversation's
// transcript JSONL — a file the agent writes. A prompt-injected agent could
// therefore rewrite its own transcript's first line to `~/.claude`, wait for the
// user to press Restart, and have the canvas serve the OAuth token.
//
// A source-text assertion cannot see that. It can only see that a call exists,
// and the laundering happened three files upstream of the call. So these tests
// DRIVE THE REAL `spawnPty` with a poisoned resume target and ask the real store
// what it will serve — the only question that was ever load-bearing.
//
// Everything around the spawn is mocked down to the bone; the modules under test
// (pty-manager's registration block and canvas-store) are real.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  /** What the transcript claims the conversation's cwd is. Set per test. */
  resumeTargetCwd: null as string | null,
  /** Set when the self-captured (in-session Restart / Switch-account) route is
   *  the one under test — that route reads the transcript through the binder. */
  bindTranscript: false,
  codexReviewRoots: [] as Array<{ sessionId: string; cwd: string }>,
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 4242,
    process: 'pwsh',
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    kill: () => {},
  }),
}))

// The canvas store writes under `getResourcesDirectory()/canvas`. Unmocked that
// resolves to the platform fallback (`/mock/...` here, since `app.getPath` is a
// stub), which happens to be creatable at the drive root on Windows and is NOT
// creatable at `/` on macOS or Linux — so the store's first mkdir threw there
// and the whole file was Windows-only by accident. Give it a real temp root.
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-root-prov-res-'))
  return {
    getResourcesDirectory: () => dir,
    getDataDirectory: () => dir,
    registerSetupHandlers: () => {},
    writeCliSetupPty: () => {},
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))

// The resume gate itself is upstream of what is under test: these tests are
// about what pty-manager DOES with a resolved launch, not about whether the
// transcript file exists. The stub returns exactly what the real helper returns
// on a successful gate — `{ resumeUuid: target.uuid, claudeCwd: target.cwd }` —
// so the poisoned value arrives by the production route.
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  resolveResumeLaunch: (target?: { uuid: string; cwd: string }) =>
    target ? { resumeUuid: target.uuid, claudeCwd: target.cwd } : null,
}))

vi.mock('../../../src/main/logging/transcript-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/logging/transcript-discovery')>()),
  // The verbatim first-`cwd`-in-the-JSONL read, standing in for a poisoned file.
  resolveResumeTargetFromTranscript: () =>
    h.resumeTargetCwd ? { uuid: '11111111-2222-3333-4444-555555555555', cwd: h.resumeTargetCwd } : null,
}))

vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => null,
  getTranscriptBinder: () =>
    h.bindTranscript ? {
      getLatestTranscriptPath: () => '/transcripts/11111111-2222-3333-4444-555555555555.jsonl',
      // #480: restart resume now reads the EXACT bind; mirror the path so this
      // exercises the same resume the test intends.
      getExactResumeTarget: () => '/transcripts/11111111-2222-3333-4444-555555555555.jsonl',
    } : null,
}))

vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  registerCodexReviewSession: (sessionId: string, cwd: string) => {
    h.codexReviewRoots.push({ sessionId, cwd })
  },
  unregisterCodexReviewSession: () => {},
}))

vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
  }),
}))

vi.mock('../../../src/main/providers/claude/spawn', () => ({
  resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }),
  resolveHostColorScheme: () => 'dark',
}))

vi.mock('../../../src/main/vision-manager', () => ({
  isGlobalVisionRunning: () => false,
  getGlobalVisionConfig: () => null,
  teardownVisionSession: () => {},
}))

vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null,
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null,
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {},
  clearClaudeAccount: () => {},
  getAccountIdentity: () => null,
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  stopWatchingAccountIdentity: () => {},
  getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({
  updateSessionMeta: () => {},
  clearSessionMeta: () => {},
  // The PTY-lifecycle set the canvas ownership lease reads. Stubbed here
  // because `spawnPty` marks it, and a missing export would make the real
  // spawn throw at that line rather than wherever this harness runs out.
  markPtySessionAlive: () => {},
  markPtySessionGone: () => {},
}))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  // mkdirSecure / atomicWriteSecure are the canvas store's own writers — keep them.
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
}))

const store = await import('../../../src/main/canvas/canvas-store')
const { spawnPty, killPty } = await import('../../../src/main/pty-manager')

const SID = 'prov1111prov1111prov1111'

const tempDirs: string[] = []
function makeDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<html><head></head><body>app</body></html>')
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'PRIVATE')
  return dir
}

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {} },
} as unknown as Parameters<typeof spawnPty>[0]

/** Run the real spawn. It may throw somewhere PAST the registration block (the
 *  mock stack stops well short of a complete session); the registration has
 *  already happened by then, and the thrown text is carried into the assertions
 *  so a failure that is really an incomplete mock says so. */
function spawn(options: Parameters<typeof spawnPty>[2]): string {
  try {
    spawnPty(fakeWin, SID, options)
    return ''
  } catch (err) {
    return ` (spawnPty threw: ${(err as Error)?.message ?? err})`
  }
}

beforeEach(() => {
  h.resumeTargetCwd = null
  h.bindTranscript = false
  h.codexReviewRoots = []
  store._resetCanvasStoreForTest()
})

afterAll(() => {
  try {
    killPty(SID)
  } catch {
    /* best-effort */
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

describe('the canvas served root comes from the configured project directory', () => {
  it('registers the configured cwd on an ordinary spawn (the guard is not a blanket refusal)', () => {
    const project = makeDir('ccc-prov-plain-')
    const why = spawn({ cwd: project })
    expect(() => store.resolveInsideCanvasRoot(path.join(project, 'dist', 'index.html'), SID), why).not.toThrow()
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: path.join(project, 'dist') }), why).not.toThrow()
    killPty(SID)
  })

  it('does NOT register a transcript-named cwd carried by the persisted resume target', () => {
    // The app-relaunch route: the renderer hands back the {uuid, cwd} it
    // persisted, and `cwd` was read out of the transcript when it was captured.
    const project = makeDir('ccc-prov-persisted-project-')
    const poisoned = makeDir('ccc-prov-persisted-dotclaude-')

    const why = spawn({
      cwd: project,
      resume: { uuid: '11111111-2222-3333-4444-555555555555', cwd: poisoned },
    })

    // The launch really did move: this is not a test that quietly failed to
    // exercise the resume path.
    expect(h.codexReviewRoots, why).toEqual([{ sessionId: SID, cwd: poisoned }])
    // …and the canvas did not follow it.
    expect(() => store.resolveInsideCanvasRoot(path.join(poisoned, 'secret.txt'), SID)).toThrow(
      /registered canvas root/i,
    )
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: path.join(poisoned, 'dist') })).toThrow(
      /registered canvas UAT root/i,
    )
    // The configured directory is what it serves.
    expect(() => store.resolveInsideCanvasRoot(path.join(project, 'dist', 'index.html'), SID), why).not.toThrow()
    killPty(SID)
  })

  it('does NOT register a transcript-named cwd captured in-session (Restart / Switch-account)', () => {
    // The route the finding actually used: no persisted target at all. Main
    // reads the live conversation's transcript itself, and
    // resolveResumeTargetFromTranscript returns the first `cwd` string in that
    // JSONL verbatim — the agent-writable value.
    const project = makeDir('ccc-prov-selfcap-project-')
    const poisoned = makeDir('ccc-prov-selfcap-dotclaude-')
    h.resumeTargetCwd = poisoned
    h.bindTranscript = true

    const why = spawn({ cwd: project })

    expect(h.codexReviewRoots, why).toEqual([{ sessionId: SID, cwd: poisoned }])
    expect(() => store.resolveInsideCanvasRoot(path.join(poisoned, 'secret.txt'), SID)).toThrow(
      /registered canvas root/i,
    )
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: path.join(poisoned, 'dist') })).toThrow(
      /registered canvas UAT root/i,
    )
    expect(() => store.resolveInsideCanvasRoot(path.join(project, 'dist', 'index.html'), SID), why).not.toThrow()
    killPty(SID)
  })

  it('registers nothing at all when the configured cwd resolves to the home directory', () => {
    // resolveCwd('.') → os.homedir(). The home refusal is the #188 one, applied
    // to the configured directory rather than the launch directory.
    const poisoned = makeDir('ccc-prov-home-dotclaude-')
    h.resumeTargetCwd = poisoned
    h.bindTranscript = true

    const why = spawn({ cwd: '.' })

    expect(() => store.resolveInsideCanvasRoot(path.join(os.homedir(), '.claude'), SID), why).toThrow(
      /registered canvas root/i,
    )
    expect(() => store.resolveInsideCanvasRoot(path.join(poisoned, 'secret.txt'), SID)).toThrow(
      /registered canvas root/i,
    )
    killPty(SID)
  })

  it('drops the session’s roots when its PTY is gone', () => {
    const project = makeDir('ccc-prov-revoke-')
    const why = spawn({ cwd: project })
    expect(() => store.resolveInsideCanvasRoot(path.join(project, 'dist', 'index.html'), SID), why).not.toThrow()
    killPty(SID)
    expect(() => store.resolveInsideCanvasRoot(path.join(project, 'dist', 'index.html'), SID)).toThrow(
      /registered canvas root/i,
    )
  })
})
