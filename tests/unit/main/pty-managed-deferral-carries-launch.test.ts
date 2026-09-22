// The deferred managed spawn (2026-09-22) and what it must CARRY across its
// own re-entry. Two defects the re-attack found, both on the common path:
//
//   - the self-captured resume target is read off the transcript binder at the
//     top of every entry and stored after that entry's killPty; the re-entry
//     is an entry, so its killPty wiped the target the first pass stored and
//     its own capture found nothing (the old run had ended by then) -- every
//     deferred Restart / account switch silently lost its exact resume
//     (MAJOR);
//   - the re-entry re-derives its working directory from disk, so a directory
//     that vanished (or appeared) during the deferral ran under a verdict the
//     gate had formed for a different directory, with the choke point's own
//     "named a directory but no verdict" guard satisfied because a verdict
//     WAS present (MAJOR).
//
// Both are driven through the REAL spawnPty with a REAL managed profile and
// the REAL gate on real temp directories; node-pty is a recorder, and the
// resume gate's disk checks are stubbed to the shape they return on success
// (tests/unit/main/canvas-root-provenance.test.ts uses the same stack).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  /** The transcript's cwd, for the self-captured route; null = no bind. */
  resumeTargetCwd: null as string | null,
  /** What resolveResumeLaunch answers for a target: its own cwd (the default,
   *  as the real helper does when the directory and transcript exist), or a
   *  substitute directory, to simulate the launch and the gate disagreeing. */
  resumeLaunchCwd: null as string | null,
  /** How many more times the binder answers with the bind (see the mock). */
  bindsLeft: 0,
  spawns: [] as Array<{ args: string[]; cwd: string }>,
  /** Everything written INTO a spawned PTY: the launch command lands here 300 ms after the spawn. */
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
  spawn: (_cmd: string, args: string[], opts: { cwd: string }) => {
    h.spawns.push({ args, cwd: opts.cwd })
    return { pid: 4242, cols: 80, rows: 24, process: 'sh',
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write(data: string) { h.writes.push(data) }, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
  },
}))
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  resolveResumeLaunch: (target?: { uuid: string; cwd: string }) =>
    target ? { resumeUuid: target.uuid, claudeCwd: h.resumeLaunchCwd ?? target.cwd } : null,
}))
vi.mock('../../../src/main/logging/transcript-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/logging/transcript-discovery')>()),
  resolveResumeTargetFromTranscript: () => (h.resumeTargetCwd ? { uuid: UUID, cwd: h.resumeTargetCwd } : null),
}))
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => null,
  // The bind is answered ONCE, as the real binder answers it: the first pass's
  // killPty ends the old run, whose async endRun clears the bind before the
  // re-entry's own capture runs. A binder that kept answering would let the
  // re-entry re-capture the target itself and hide the carry's absence.
  getTranscriptBinder: () => (h.resumeTargetCwd ? {
    getLatestTranscriptPath: () => (h.bindsLeft-- > 0 ? `/transcripts/${UUID}.jsonl` : null),
    getExactResumeTarget: () => (h.bindsLeft-- > 0 ? `/transcripts/${UUID}.jsonl` : null),
  } : null),
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, unregisterCodexReviewSession: () => {},
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
const { spawnPty, killPty, isSessionWritable } = await import('../../../src/main/pty-manager')
const { _resetProjectScanStateForTest, _resetManagedLaunchReportsForTest, listManagedLaunchReports } = await import('../../../src/main/managed-launch-diagnostics')
const { registerFakeClaudePackage } = await import('../../helpers/claude-package')

const messages: string[] = []
const payloads: Array<[string, unknown]> = []
const win = {
  webContents: { send: (channel: string, payload?: unknown) => { messages.push(channel); payloads.push([channel, payload]) } },
  isDestroyed: () => false,
} as never
let root = ''
let profileId = ''
const ids = ['carry-resume', 'carry-none', 'dir-vanished', 'resume-dir-differs']
const until = async (cond: () => boolean, why: string) => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting: ${why}`)
}
const dirs: string[] = []
const makeDir = (prefix: string, settings?: Record<string, unknown>): string => {
  // realpath'd, so the string the gate scans is the string resolveCwd yields.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  if (settings) {
    fs.mkdirSync(path.join(dir, '.claude'))
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings))
  }
  return dir
}
const terminalLine = (id: string): string => String(payloads.find(([c]) => c === `pty:data:${id}`)?.[1] ?? '')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-root-'))
  fs.mkdirSync(path.join(root, 'global', '.claude'), { recursive: true })
  profiles._setRootsForTest({ resourcesDir: root, sharedRoot: path.join(root, 'global', '.claude') })
  profileId = profiles.createProfile('Synthetic profile').id
  identity._resetForTest(); consumers._resetProfileConsumersForTest()
  h.resumeTargetCwd = null; h.resumeLaunchCwd = null; h.bindsLeft = 0; h.spawns.length = 0; h.writes.length = 0
  messages.length = 0; payloads.length = 0
  _resetProjectScanStateForTest()
  _resetManagedLaunchReportsForTest()
  registerFakeClaudePackage({ resolveBinary: () => ({ cmd: 'claude', args: [] }) } as never)
})
afterEach(() => {
  for (const id of ids) killPty(id)
  identity._resetForTest(); consumers._resetProfileConsumersForTest()
  profiles._setRootsForTest(null)
  for (const d of [root, ...dirs.splice(0)]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  _resetProjectScanStateForTest()
})

describe('a deferred managed spawn carries its self-captured resume target across the re-entry', () => {
  it('relaunches the exact conversation in ITS directory after the gate deferral', async () => {
    const configured = makeDir('carry-configured-')
    const conversation = makeDir('carry-conversation-')
    h.resumeTargetCwd = conversation   // the binder's exact bind: the live conversation ran HERE
    h.bindsLeft = 1
    expect(() => spawnPty(win, 'carry-resume', { profileId, cwd: configured })).not.toThrow()
    await until(() => h.spawns.length === 1, 'the managed spawn to re-enter after the gate')
    expect(messages).not.toContain('pty:exit:carry-resume')
    expect(isSessionWritable('carry-resume')).toBe(true)
    // The exact resume survived the deferral: the CLI runs in the
    // conversation's directory with its uuid, not fresh in the configured one.
    expect(h.spawns[0].cwd).toBe(conversation)
    await until(() => h.writes.some((w) => w.includes(UUID)), 'the launch command to be written into the PTY')
    expect(h.writes.find((w) => w.includes(UUID))).toContain('--resume')
  })

  it('control: with no bind there is nothing to carry, and the spawn runs where it was configured', async () => {
    const configured = makeDir('carry-none-')
    spawnPty(win, 'carry-none', { profileId, cwd: configured })
    await until(() => h.spawns.length === 1, 'the managed spawn to re-enter')
    expect(h.spawns[0].cwd).toBe(configured)
    await until(() => h.writes.length > 0, 'the launch command to be written into the PTY')
    expect(h.writes.join('')).not.toContain('--resume')
  })
})

describe('the verdict a deferred managed spawn carries is bound to the directories the gate scanned', () => {
  it('REFUSES when the configured directory vanished during the deferral and resolveCwd fell back to home', async () => {
    const configured = makeDir('vanish-')
    expect(() => spawnPty(win, 'dir-vanished', { shellOnly: true, profileId, cwd: configured })).not.toThrow()
    // The gate is scanning `configured` right now. Remove it: the re-entry's
    // resolveCwd collapses a missing directory to the home directory, and a
    // verdict formed for `configured` must not launch a session THERE.
    fs.rmSync(configured, { recursive: true, force: true })
    await until(() => messages.includes('pty:exit:dir-vanished'), 'the re-entry to refuse the substituted directory')
    expect(h.spawns.length, 'a PTY was spawned into a directory the gate never checked').toBe(0)
    expect(terminalLine('dir-vanished')).toContain('not a directory the project-settings gate checked')
    // ...and the Accounts panel can say so: the refusal is RECORDED as a
    // blocked finding, not only printed (spec review, MINOR).
    const report = listManagedLaunchReports(profileId)[0]
    expect(report, 'no preflight was recorded for the refusal').toBeDefined()
    expect(report.preflight.ok).toBe(false)
    const finding = report.preflight.findings.find((f) => f.id === 'launch-directory-unverified')!
    expect(finding?.severity).toBe('blocked')
    expect(finding.detail).not.toMatch(/[\x00-\x1f]/)
    expect(consumers.profileConsumerCount(profileId)).toBe(0)
  })

  it('REFUSES when the resume decision lands the CLI in a directory the gate did not scan', async () => {
    const configured = makeDir('differs-configured-')
    const target = makeDir('differs-target-')
    const elsewhere = makeDir('differs-elsewhere-')
    // The persisted target names `target` (gated); the launch helper answers
    // `elsewhere` -- a divergence between the gate's spelling of the resume
    // directory and the launch's must refuse, never run unchecked.
    h.resumeLaunchCwd = elsewhere
    expect(() => spawnPty(win, 'resume-dir-differs', { profileId, cwd: configured, resume: { uuid: UUID, cwd: target } })).not.toThrow()
    await until(() => messages.includes('pty:exit:resume-dir-differs'), 'the re-entry to refuse the unscanned resume directory')
    expect(h.spawns.length).toBe(0)
    expect(terminalLine('resume-dir-differs')).toContain('resume directory')
    expect(terminalLine('resume-dir-differs')).toContain('not a directory the project-settings gate checked')
  })
})
