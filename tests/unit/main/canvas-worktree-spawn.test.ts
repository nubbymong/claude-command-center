// Agent Canvas serves the session's DESIGNATED worktree — end to end (ADR-016).
//
// Drives the REAL `spawnPty` (everything around it mocked, as in
// canvas-root-provenance.test.ts) and asks two real things: what CCC told the
// guard through CCC_SESSION_WORKTREE, and what the real canvas store will serve.
// The designated path must come from the CONFIGURED project directory and CCC's
// own session id — a poisoned resume target must not move it — and it must
// serve only once the directory really exists.

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
  /** The env each pty.spawn was given (CCC_SESSION_WORKTREE lives here). */
  spawnEnvs: [] as Array<Record<string, string>>,
}))

vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
    h.spawnEnvs.push(opts?.env ?? {})
    return {
      pid: 4242,
      process: 'pwsh',
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  },
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
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-wt-spawn-res-'))
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
    // Stand in for the real providers, which spread process.env: hand back a
    // STALE inherited CCC_SESSION_WORKTREE so every 'not designated' assertion
    // below verifies it is SCRUBBED, not merely absent.
    buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: { CCC_SESSION_WORKTREE: STALE_WT } }),
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

const SID = 'wtsp1111wtsp1111wtsp1111'

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
  h.spawnEnvs = []
  store._resetCanvasStoreForTest()
})

/** A project that is a PRIMARY checkout (`.git` is a directory), plus the
 *  worktree base beside it, both under one temp parent so cleanup is one rm. */
function makePrimaryProject(prefix: string): { parent: string; project: string; wtBase: string } {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(parent)
  const project = path.join(parent, 'project')
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  fs.mkdirSync(path.join(project, 'dist'))
  fs.writeFileSync(path.join(project, 'dist', 'index.html'), '<html><head></head><body>app</body></html>')
  return { parent, project, wtBase: path.join(parent, 'ccc-wt') }
}
const SHORT = SID.slice(0, 12)
const STALE_WT = path.join('F:', 'stale-outer', 'ccc-wt', 'deadbeefdead')

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

describe('CCC designates the session worktree and serves it once it exists', () => {
  it('tells the guard where (CCC_SESSION_WORKTREE) and serves that directory only once it is real', () => {
    const { project, wtBase } = makePrimaryProject('ccc-wt-spawn-plain-')
    const designated = path.join(wtBase, SHORT)
    const why = spawn({ cwd: project })

    // The env the shell got names the CCC-designated location…
    expect(h.spawnEnvs.length, why).toBeGreaterThan(0)
    expect(h.spawnEnvs[0].CCC_SESSION_WORKTREE, why).toBe(designated)
    // …the project itself is served, as before…
    expect(() => store.resolveInsideCanvasRoot(path.join(project, 'dist', 'index.html'), SID), why).not.toThrow()
    // …the designated worktree is NOT served while it does not exist…
    expect(() => store.resolveInsideCanvasRoot(path.join(designated, 'mock.html'), SID)).toThrow(/registered canvas root/i)
    // …and IS served once the guard has created it and the agent wrote there.
    fs.mkdirSync(designated, { recursive: true })
    fs.writeFileSync(path.join(designated, 'mock.html'), '<html></html>')
    expect(() => store.resolveInsideCanvasRoot(path.join(designated, 'mock.html'), SID), why).not.toThrow()
    // A sibling worktree (another session's) is not.
    fs.mkdirSync(path.join(wtBase, 'other000'), { recursive: true })
    fs.writeFileSync(path.join(wtBase, 'other000', 'mock.html'), '<html></html>')
    expect(() => store.resolveInsideCanvasRoot(path.join(wtBase, 'other000', 'mock.html'), SID)).toThrow(/registered canvas root/i)
    killPty(SID)
  })

  it('a poisoned resume target does not move the designation (configured cwd + CCC id only)', () => {
    const { project, wtBase } = makePrimaryProject('ccc-wt-spawn-poison-')
    const poisonedParent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-wt-spawn-poisoned-')))
    tempDirs.push(poisonedParent)
    const poisoned = path.join(poisonedParent, 'project')
    fs.mkdirSync(path.join(poisoned, '.git'), { recursive: true })
    h.resumeTargetCwd = poisoned
    h.bindTranscript = true

    const why = spawn({ cwd: project })
    expect(h.codexReviewRoots, why).toEqual([{ sessionId: SID, cwd: poisoned }]) // the launch really moved
    expect(h.spawnEnvs[0].CCC_SESSION_WORKTREE, why).toBe(path.join(wtBase, SHORT))
    // The transcript-named neighbourhood is not designated: even if the agent
    // creates it, nothing under it is served.
    const wrong = path.join(poisonedParent, 'ccc-wt', SHORT)
    fs.mkdirSync(wrong, { recursive: true })
    fs.writeFileSync(path.join(wrong, 'mock.html'), '<html></html>')
    expect(() => store.resolveInsideCanvasRoot(path.join(wrong, 'mock.html'), SID)).toThrow(/registered canvas root/i)
    killPty(SID)
  })

  it('designates nothing for a project that is not a primary checkout, nor for a shell-only session', () => {
    const plain = makeDir('ccc-wt-spawn-norepo-') // no .git at all
    const why = spawn({ cwd: plain })
    expect(h.spawnEnvs[0]?.CCC_SESSION_WORKTREE, why).toBeUndefined()
    const guess = path.join(path.dirname(plain), 'ccc-wt', SHORT)
    fs.mkdirSync(guess, { recursive: true })
    tempDirs.push(path.dirname(guess))
    fs.writeFileSync(path.join(guess, 'mock.html'), '<html></html>')
    expect(() => store.resolveInsideCanvasRoot(path.join(guess, 'mock.html'), SID)).toThrow(/registered canvas root/i)
    killPty(SID)

    h.spawnEnvs = []
    const { project } = makePrimaryProject('ccc-wt-spawn-shell-')
    const why2 = spawn({ cwd: project, shellOnly: true })
    expect(h.spawnEnvs[0]?.CCC_SESSION_WORKTREE, why2).toBeUndefined()
    killPty(SID)
  })

  it('SCRUBS an inherited CCC_SESSION_WORKTREE from a non-designated session (never leaks CCC’s own env)', () => {
    // A dev CCC launched from inside a guarded tile inherits the OUTER tile’s
    // CCC_SESSION_WORKTREE; a shell-only / non-repo child must not carry it, or
    // its guard would target the outer tile’s worktree.
    const plain = makeDir('ccc-wt-spawn-scrub-')   // no .git
    const why = spawn({ cwd: plain })
    expect(h.spawnEnvs[0].CCC_SESSION_WORKTREE, why).toBeUndefined()   // scrubbed, not the stale value
    killPty(SID)
    h.spawnEnvs = []
    const { project } = makePrimaryProject('ccc-wt-spawn-scrub2-')
    const why2 = spawn({ cwd: project, shellOnly: true })
    expect(h.spawnEnvs[0].CCC_SESSION_WORKTREE, why2).toBeUndefined()  // shell-only never designates
    killPty(SID)
  })

  it('designates nothing when the project itself is refused (home directory)', () => {
    const why = spawn({ cwd: '.' }) // resolveCwd('.') → home
    expect(h.spawnEnvs[0]?.CCC_SESSION_WORKTREE, why).toBeUndefined()
    killPty(SID)
  })

  it('drops the designated root with the session (revoke on PTY gone)', () => {
    const { project, wtBase } = makePrimaryProject('ccc-wt-spawn-revoke-')
    const designated = path.join(wtBase, SHORT)
    const why = spawn({ cwd: project })
    fs.mkdirSync(designated, { recursive: true })
    fs.writeFileSync(path.join(designated, 'mock.html'), '<html></html>')
    expect(() => store.resolveInsideCanvasRoot(path.join(designated, 'mock.html'), SID), why).not.toThrow()
    killPty(SID)
    expect(() => store.resolveInsideCanvasRoot(path.join(designated, 'mock.html'), SID)).toThrow(/registered canvas root/i)
  })
})
