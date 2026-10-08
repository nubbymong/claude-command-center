// Switch account / Restart must resume the conversation even when the old
// process has ENDED before the respawn arrives (operator's Mac test of PR
// #629: "When switching users on Mac, the session isn't automatically
// resumed").
//
// The renderer's Restart (and Switch account, which routes through it) sends
// pty:kill with reason 'restart' FIRST, then remounts the view, whose spawn
// is a second IPC. The resume target is self-captured in spawnPty from the
// transcript binder's exact bind -- but the old process's exit ends the run
// and the binder forgets the bind (endRun). On macOS a killed process exits
// within milliseconds, so the exit lands between the two IPCs, the spawn's
// capture found nothing, and the session opened the resume PICKER instead of
// resuming. The fix captures the target at the Restart's kill, while the bind
// is still held, and the spawn uses it when its own capture comes up empty.
//
// Driven through the REAL killPty / spawnPty / exit handler with a real
// managed profile and the real project gate; node-pty records and lets the
// test fire each process's exit; the binder holds its bind until endRun, as
// the real one does. Run on the host platform and as macOS with the
// experimental multi-account setting on (the operator's configuration).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  /** The live conversation's cwd (the binder's exact bind), or null. */
  conversationCwd: null as string | null,
  /** Whether the binder still holds the bind; endRun drops it. */
  bound: false,
  spawns: [] as Array<{ cwd: string; env: Record<string, string | undefined>; exit: ((e: { exitCode: number }) => void) | null }>,
  writes: [] as string[],
}))
const UUID = '11111111-2222-3333-4444-555555555555'

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP ?? os.tmpdir(), getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => {
    const rec: { cwd: string; env: Record<string, string | undefined>; exit: ((e: { exitCode: number }) => void) | null } = { cwd: opts.cwd, env: opts.env, exit: null }
    h.spawns.push(rec)
    return { pid: 4242, cols: 80, rows: 24, process: 'sh',
      onData: () => ({ dispose() {} }), onExit: (cb: (e: { exitCode: number }) => void) => { rec.exit = cb; return { dispose() {} } },
      write(data: string) { h.writes.push(data) }, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
  },
}))
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  resolveResumeLaunch: (target?: { uuid: string; cwd: string }) => (target ? { resumeUuid: target.uuid, claudeCwd: target.cwd } : null),
}))
vi.mock('../../../src/main/logging/transcript-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/logging/transcript-discovery')>()),
  resolveResumeTargetFromTranscript: () => (h.conversationCwd ? { uuid: UUID, cwd: h.conversationCwd } : null),
}))
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => null,
  getTranscriptBinder: () => ({
    getLatestTranscriptPath: () => (h.bound ? `/transcripts/${UUID}.jsonl` : null),
    getExactResumeTarget: () => (h.bound ? `/transcripts/${UUID}.jsonl` : null),
    // The run's end forgets the bind, as the real binder's endRun does.
    endRun: () => { h.bound = false },
    registerRun: () => {},
    notifyTranscriptPath: () => {},
  }),
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, unregisterCodexReviewSession: () => {}, releaseMcpSessionProvider: () => {},
  registerClaudeReviewSession: () => {},
}))
vi.mock('../../../src/main/providers/claude/spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/providers/claude/spawn')>()),
  resolveClaudeBinary: () => ({ cmd: 'claude', args: [] }),
  resolveHostColorScheme: () => 'dark',
}))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/session-registry', () => ({
  updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {},
}))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))

const profiles = await import('../../../src/main/account-profiles')
const consumers = await import('../../../src/main/profile-consumers')
const identity = await import('../../../src/main/claude-account-identity')
const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { _resetProjectScanStateForTest, _resetManagedLaunchReportsForTest } = await import('../../../src/main/managed-launch-diagnostics')
const { _resetMacRealmVerdictsForTest } = await import('../../../src/main/mac-realm-verdict')
const { seedMacRealmVerdict } = await import('../helpers/mac-realm-verdict-seed')
const { registerFakeClaudePackage } = await import('../../helpers/claude-package')

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SID = 'switch-resume'
const until = async (cond: () => boolean, why: string) => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting: ${why}`)
}
const tmp: string[] = []
const makeDir = (prefix: string): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmp.push(dir)
  return dir
}

const HOST_PLATFORM = process.platform
// The 'host' variant is the per-profile-home path (win32/linux). On a macOS
// host it would run with the multi-account setting OFF, where a non-primary
// launch is refused by design (aicc_planning#172 decision 3) -- nothing to
// resume (macOS CI, PR #629). Run it as linux there, the pattern of
// pty-spawn-waits-for-refresh.test.ts; macOS itself is the 'darwin-realm'
// variant (setting on).
const PER_PROFILE_PLATFORM: NodeJS.Platform = HOST_PLATFORM === 'darwin' ? 'linux' : HOST_PLATFORM
let hostPlatformDescriptor: PropertyDescriptor | undefined

for (const mode of ['host', 'darwin-realm'] as const) {
  describe(`Switch account resumes the conversation when the old process ended first (${mode})`, () => {
    let primaryId = ''
    let workId = ''
    let thirdId = ''
    beforeEach(() => {
      hostPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: mode === 'darwin-realm' ? 'darwin' : PER_PROFILE_PLATFORM, configurable: true })
      const root = makeDir('switch-resume-root-')
      fs.mkdirSync(path.join(root, 'global', '.claude'), { recursive: true })
      profiles._setRootsForTest({ resourcesDir: root, sharedRoot: path.join(root, 'global', '.claude') })
      const p1 = profiles.createProfile('Primary')
      profiles.setPrimaryProfile(p1.id)
      primaryId = p1.id
      workId = profiles.createProfile('Work').id
      thirdId = profiles.createProfile('Third').id
      profiles.setMacMultiAccountProbe(() => mode === 'darwin-realm')
      _resetMacRealmVerdictsForTest()
      if (mode === 'darwin-realm') seedMacRealmVerdict(root, profiles.getProfileConfigDir(workId), profiles.getProfileConfigDir(thirdId))
      identity._resetForTest(); consumers._resetProfileConsumersForTest()
      h.conversationCwd = null; h.bound = false; h.spawns.length = 0; h.writes.length = 0
      _resetProjectScanStateForTest()
      _resetManagedLaunchReportsForTest()
      registerFakeClaudePackage({ resolveBinary: () => ({ cmd: 'claude', args: [] }) } as never)
    })
    afterEach(() => {
      killPty(SID, { reason: 'close' })
      identity._resetForTest(); consumers._resetProfileConsumersForTest()
      profiles.setMacMultiAccountProbe(() => false)
      _resetMacRealmVerdictsForTest()
      profiles._setRootsForTest(null)
      for (const d of tmp.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
      _resetProjectScanStateForTest()
      if (hostPlatformDescriptor) Object.defineProperty(process, 'platform', hostPlatformDescriptor)
      expect(process.platform).toBe(HOST_PLATFORM)
    })

    /** Start the session on `from`, bind its conversation, then Switch to
     *  `to` as the renderer does: kill (reason 'restart'), the old process
     *  exits, THEN the new spawn (picker marked, as a Restart marks it). */
    const switchAfterExit = async (from: () => string, to: () => string) => {
      const configured = makeDir('switch-configured-')
      const conversation = makeDir('switch-conversation-')
      spawnPty(win, SID, { profileId: from(), cwd: configured })
      await until(() => h.spawns.length === 1, 'the first managed spawn')
      h.conversationCwd = conversation
      h.bound = true // the SessionStart hook's exact bind for this session
      killPty(SID, { reason: 'restart' })
      h.spawns[0].exit?.({ exitCode: 0 }) // the old process ends BEFORE the respawn arrives
      expect(h.bound, 'the harness: the exit must end the run and drop the bind').toBe(false)
      h.writes.length = 0
      spawnPty(win, SID, { profileId: to(), cwd: configured, useResumePicker: true })
      await until(() => h.spawns.length === 2, 'the respawn on the new account')
      await until(() => h.writes.length > 0, 'the launch command')
      return { conversation, line: h.writes.join('') }
    }

    it('primary -> other profile: the respawn resumes the conversation by id in its own folder', async () => {
      const { conversation, line } = await switchAfterExit(() => primaryId, () => workId)
      expect(h.spawns[1].cwd).toBe(conversation)
      expect(line).toContain(`--resume ${UUID}`)
      expect(line).not.toContain('resume-picker')
      // The respawn really ran on the other profile's sign-in: its own
      // config directory on the macOS realm, none elsewhere.
      if (mode === 'darwin-realm') expect(h.spawns[1].env.CLAUDE_CONFIG_DIR).toBe(path.resolve(profiles.getProfileConfigDir(workId), '.claude').normalize('NFC'))
      else expect(h.spawns[1].env.CLAUDE_CONFIG_DIR).toBeUndefined()
    })

    it('other profile -> primary: the respawn resumes the conversation too', async () => {
      const { conversation, line } = await switchAfterExit(() => workId, () => primaryId)
      expect(h.spawns[1].cwd).toBe(conversation)
      expect(line).toContain(`--resume ${UUID}`)
      // The primary: the real ~/.claude, never a config directory.
      expect(h.spawns[1].env.CLAUDE_CONFIG_DIR).toBeUndefined()
      // ...and the run it replaced was the other profile's realm on macOS.
      if (mode === 'darwin-realm') expect(h.spawns[0].env.CLAUDE_CONFIG_DIR).toBe(path.resolve(profiles.getProfileConfigDir(workId), '.claude').normalize('NFC'))
    })

    it('other profile -> another profile: the respawn resumes it on the second one', async () => {
      const { conversation, line } = await switchAfterExit(() => workId, () => thirdId)
      expect(h.spawns[1].cwd).toBe(conversation)
      expect(line).toContain(`--resume ${UUID}`)
      if (mode === 'darwin-realm') expect(h.spawns[1].env.CLAUDE_CONFIG_DIR).toBe(path.resolve(profiles.getProfileConfigDir(thirdId), '.claude').normalize('NFC'))
    })

    it('a close (not a Restart) keeps nothing for a later spawn of the id', async () => {
      const configured = makeDir('switch-close-')
      h.conversationCwd = makeDir('switch-close-conv-')
      spawnPty(win, SID, { profileId: primaryId, cwd: configured })
      await until(() => h.spawns.length === 1, 'the first managed spawn')
      h.bound = true
      killPty(SID, { reason: 'restart' })
      killPty(SID, { reason: 'close' })
      h.spawns[0].exit?.({ exitCode: 0 })
      h.writes.length = 0
      spawnPty(win, SID, { profileId: primaryId, cwd: configured })
      await until(() => h.spawns.length === 2, 'the later spawn')
      await until(() => h.writes.length > 0, 'the launch command')
      expect(h.writes.join('')).not.toContain('--resume')
      expect(h.spawns[1].cwd).toBe(configured)
    })
  })
}
