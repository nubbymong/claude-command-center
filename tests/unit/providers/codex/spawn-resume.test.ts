// P3.5 (rows 34, 35): the Codex launch resumes a conversation by its id, as
// Claude's does (`claude --resume <uuid>`, spawn-claude-command's
// resolveResumeLaunch): only a conversation id, only when its rollout is in the
// launch's own realm, in the directory the conversation ran in, and never
// through the resume picker. The resume picker's launch gets a place to record
// the conversation it opens and the app's config folder (its names). Real
// files in temp folders; the CLI lookups mocked, nothing is started.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync, rmdirSync, unlinkSync, existsSync, readdirSync, statSync } from 'fs'
import { join, isAbsolute, dirname, basename } from 'path'
import { tmpdir } from 'os'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'linux') }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => '/usr/local/bin/node\n') }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => (globalThis as any).__p35ResourcesDir ?? '',
}))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
}))
vi.mock('../../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => (globalThis as any).__p35ConfigDir ?? '/cfg',
}))
// The builder's own check of the id, independent of the lookup: a test may
// force what the lookup answers.
vi.mock('../../../../src/main/providers/codex/rollout-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/providers/codex/rollout-lookup')>()
  return {
    ...actual,
    resolveCodexResume: (...a: Parameters<typeof actual.resolveCodexResume>) =>
      (globalThis as any).__p35ForcedResume ?? actual.resolveCodexResume(...a),
  }
})
vi.mock('../../../../src/main/providers/codex/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/providers/codex/telemetry')>()
  return { ...actual, watchAndClaimRollout: vi.fn(() => ({ stop: () => {} })) }
})

import { CodexProvider } from '../../../../src/main/providers/codex'
import { __resetNodeExeCache } from '../../../../src/main/providers/codex/spawn'
import { watchAndClaimRollout } from '../../../../src/main/providers/codex/telemetry'
import { codexFolderIdentity } from '../../../../src/main/providers/codex/rollout-lookup'

const ID = '019dd000-0001-7000-8000-0000000000c1'
const codexOptions = { model: 'gpt-5.5', permissionsPreset: 'standard' as const }
const FLAGS = ['-m', 'gpt-5.5', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
const temps: string[] = []
const temp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `ccc-p35-${tag}-`)); temps.push(d); return d }
/** Removes, recursively, only a folder this file made: its own prefix, directly in the temp folder. */
const removeOwn = (d: string) => { if (dirname(d) === tmpdir() && /^ccc-p35-/.test(basename(d))) rmSync(d, { recursive: true, force: true }) }
/** Pick folders the builder made: emptied of the pick file and removed, never recursively. */
const pickDirs: string[] = []

/** A realm with this conversation's rollout, recorded as run in `cwd`. */
function realmWith(id: string, cwd: string, daysAgo = 2): { sessionsDir: string; file: string } {
  const home = temp('realm')
  const at = new Date(Date.now() - daysAgo * 24 * 3600 * 1000)
  const dir = join(home, 'sessions', String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-09-25T10-00-00-${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ timestamp: at.toISOString(), type: 'session_meta', payload: { id, cwd, cli_version: '0.155.1' } }) + '\n')
  return { sessionsDir: join(home, 'sessions'), file }
}
const launchIn = (sessionsDir: string, executable = '/proven/codex') => ({ executable, env: { PATH: '/usr/bin', CODEX_HOME: dirname(sessionsDir) }, sessionsDir })
/** A resources folder with the picker deployed, so a bypass is visible. */
function deployPicker(): string {
  const res = temp('res')
  mkdirSync(join(res, 'scripts'), { recursive: true })
  writeFileSync(join(res, 'scripts', 'codex-resume-picker.js'), '// stub')
  ;(globalThis as any).__p35ResourcesDir = res
  return res
}

beforeEach(() => {
  __resetNodeExeCache()
})
afterEach(() => {
  delete (globalThis as any).__p35ResourcesDir
  delete (globalThis as any).__p35ForcedResume
  delete (globalThis as any).__p35ConfigDir
  for (const d of temps.splice(0)) removeOwn(d)
  for (const d of pickDirs.splice(0)) {
    if (dirname(d) !== tmpdir() || !/^ccc-codex-pick-/.test(basename(d))) continue
    try { unlinkSync(join(d, 'pick.json')) } catch { /* not there */ }
    try { rmdirSync(d) } catch { /* not empty, or gone */ }
  }
})

describe('an exact resume on relaunch or Restart (rows 34, 35)', () => {
  it('resumes a conversation of its own realm by id, before the flags, in the directory it ran in; the picker is not shown', () => {
    deployPicker()
    const project = temp('project')
    const { sessionsDir, file } = realmWith(ID, project)
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: temp('configured'), useResumePicker: true,
      resume: { uuid: ID, cwd: project }, codexOptions,
    })
    expect(out.cmd).toBe('/proven/codex')
    expect(out.args).toEqual(['resume', ID, ...FLAGS])
    expect(out.resumeId).toBe(ID)
    expect(out.cwd).toBe(project)
    expect(out.pickFile).toBeUndefined()
    expect(out.resumePath).toBe(file)
  })

  it('a conversation another account holds is not resumed here: realms never cross', () => {
    const project = temp('project')
    realmWith(ID, project)
    const other = realmWith('019dd000-0001-7000-8000-0000000000ff', project)
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(other.sessionsDir), cwd: project, resume: { uuid: ID, cwd: project }, codexOptions,
    })
    expect(out.args).toEqual(FLAGS)
    expect(out.resumeId).toBeUndefined()
    expect(out.cwd).toBeUndefined()
  })

  it('after a staged sign in again, a conversation carried into the account\'s new folder resumes there (P3.3)', () => {
    const project = temp('project')
    const old = realmWith(ID, project, 9)
    // The new folder holds the same file under a second name, as the carry-over makes it.
    const fresh = temp('realm-new')
    const rel = old.file.slice(old.sessionsDir.length)
    mkdirSync(dirname(join(fresh, 'sessions', rel)), { recursive: true })
    linkSync(old.file, join(fresh, 'sessions', rel))
    removeOwn(dirname(old.sessionsDir))
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(join(fresh, 'sessions')), cwd: project, resume: { uuid: ID, cwd: project }, codexOptions,
    })
    expect(out.args.slice(0, 2)).toEqual(['resume', ID])
  })

  it('starts in the configured directory when the kept one is not the directory the conversation records, or is gone', () => {
    const project = temp('project')
    const configured = temp('configured')
    const { sessionsDir } = realmWith(ID, project)
    const elsewhere = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: configured, resume: { uuid: ID, cwd: temp('other') }, codexOptions,
    })
    expect(elsewhere.args.slice(0, 2)).toEqual(['resume', ID])
    expect(elsewhere.cwd).toBe(configured)
    removeOwn(project)
    const gone = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: configured, resume: { uuid: ID, cwd: project }, codexOptions,
    })
    expect(gone.args.slice(0, 2)).toEqual(['resume', ID])
    expect(gone.cwd).toBe(configured)
  })

  it('says when no rollout of the conversation records the directory the session kept (thesis 6)', () => {
    const project = temp('project')
    const { sessionsDir } = realmWith(ID, project)
    const kept = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: temp('configured'), resume: { uuid: ID, cwd: project }, codexOptions,
    })
    expect(kept.resumeCwdMismatch).toBe(false)
    const other = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: temp('configured'), resume: { uuid: ID, cwd: temp('elsewhere') }, codexOptions,
    })
    expect(other.resumeCwdMismatch).toBe(true)
  })

  it('an id that is not a conversation id never reaches argv', () => {
    const project = temp('project')
    const { sessionsDir } = realmWith(ID, project)
    for (const uuid of ['-c=model_provider=x', `${ID} --dangerously-bypass-approvals-and-sandbox`, `${ID}\n`, '']) {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: project, resume: { uuid, cwd: project }, codexOptions,
      })
      expect(out.args).toEqual(FLAGS)
    }
  })

  it('the builder checks the id itself, whatever the lookup answers', () => {
    const project = temp('project')
    const { sessionsDir } = realmWith(ID, project)
    ;(globalThis as any).__p35ForcedResume = { resumeId: '--dangerously-bypass-approvals-and-sandbox', cwd: project }
    expect(() => new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: project, resume: { uuid: ID, cwd: project }, codexOptions,
    })).toThrow(/conversation id/)
  })

  it('on the cmd.exe route the id reaches the /s line unchanged', () => {
    const project = temp('project')
    const { sessionsDir } = realmWith(ID, project)
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid', realmLaunch: { executable: 'C:\\npm\\codex.cmd', env: { SystemRoot: 'C:\\Windows' }, sessionsDir },
        cwd: project, resume: { uuid: ID, cwd: project }, codexOptions,
      })
      expect(out.commandLine).toBe(`/d /v:off /s /c ""C:\\npm\\codex.cmd" resume ${ID} ${FLAGS.join(' ')}"`)
    } finally {
      Object.defineProperty(process, 'platform', orig)
    }
  })
})

describe('the resume picker\'s launch (rows 32, 38)', () => {
  it('gets a new place, in the temp folder, to record the conversation it opens, and the app\'s config folder for names', () => {
    deployPicker()
    ;(globalThis as any).__p35ConfigDir = join(tmpdir(), 'ccc-p35-config')
    const { sessionsDir } = realmWith(ID, temp('project'))
    const build = () => new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: temp('configured'), useResumePicker: true, codexOptions,
    })
    const a = build()
    const b = build()
    expect(a.args[0]).toMatch(/codex-resume-picker\.js$/)
    expect(a.pickFile).toBeTruthy()
    expect(isAbsolute(a.pickFile!)).toBe(true)
    // Fix round 2: in a folder of its own, made for this launch, private to its owner where the platform keeps modes.
    const own = dirname(a.pickFile!)
    pickDirs.push(own, dirname(b.pickFile!))
    expect(dirname(own)).toBe(tmpdir())
    expect(basename(own)).toMatch(/^ccc-codex-pick-/)
    expect(readdirSync(own)).toEqual([])
    if (process.platform !== 'win32') expect(statSync(own).mode & 0o777).toBe(0o700)
    expect(a.env.CCC_CODEX_PICK_FILE).toBe(a.pickFile)
    // Fix round 3: the folder's identity as made, for the watcher, and its id for the picker.
    expect(a.pickFolder).toEqual(codexFolderIdentity(own))
    expect(a.pickFolder?.id).toMatch(/^[0-9]+:[0-9]+$/)
    expect(a.env.CCC_CODEX_PICK_DIR_ID).toBe(a.pickFolder!.id)
    expect(b.pickFolder?.id).not.toBe(a.pickFolder?.id)
    expect(existsSync(a.pickFile!)).toBe(false)
    expect(b.pickFile).not.toBe(a.pickFile)
    expect(dirname(b.pickFile!)).not.toBe(own)
    expect(a.env.CCC_CONFIG_DIR).toBe(join(tmpdir(), 'ccc-p35-config'))
    expect(a.resumeId).toBeUndefined()
  })

  it('a direct launch gets neither', () => {
    const { sessionsDir } = realmWith(ID, temp('project'))
    const out = new CodexProvider().buildSpawnCommand({ sessionId: 'sid', realmLaunch: launchIn(sessionsDir), cwd: temp('c'), codexOptions })
    expect(out.pickFile).toBeUndefined()
    expect(out.env.CCC_CODEX_PICK_FILE).toBeUndefined()
    expect(out.pickFolder).toBeUndefined()
    expect(out.env.CCC_CODEX_PICK_DIR_ID).toBeUndefined()
  })
})

describe('the status line is told how to find the conversation (row 38)', () => {
  it('the resumed id, the pick file and the claim listener reach the watcher; a plain launch passes none', () => {
    vi.mocked(watchAndClaimRollout).mockClear()
    const onClaim = () => {}
    const cb = () => {}
    new CodexProvider().ingestSessionTelemetry('sid', { cwd: '/w', spawnTimestamp: 7, sessionsDir: '/r/sessions', resumeId: ID, pickFile: '/t/p.json', onClaim }, cb)
    expect(vi.mocked(watchAndClaimRollout).mock.calls[0]).toEqual(['sid', '/w', 7, cb, '/r/sessions', undefined, { resumeId: ID, pickFile: '/t/p.json', onClaim }])
    // Fix round 3: the pick folder's identity reaches the watcher with the pick file.
    const pickFolder = { id: '1:2', real: '/t' }
    new CodexProvider().ingestSessionTelemetry('sid', { cwd: '/w', spawnTimestamp: 7, sessionsDir: '/r/sessions', pickFile: '/t/p.json', pickFolder }, cb)
    expect(vi.mocked(watchAndClaimRollout).mock.calls[1][6]).toEqual({ pickFile: '/t/p.json', pickFolder })
    // P3.6 VM finding V2: the listener for a conversation another session holds.
    const onShared = () => {}
    new CodexProvider().ingestSessionTelemetry('sid', { cwd: '/w', spawnTimestamp: 7, sessionsDir: '/r/sessions', onShared }, cb)
    expect((vi.mocked(watchAndClaimRollout).mock.calls[2][6] as { onShared?: unknown }).onShared).toBe(onShared)
    // P3.12: the listener for the rollout claimed (the session's logs, name file and GitHub context).
    const onRollout = () => {}
    new CodexProvider().ingestSessionTelemetry('sid', { cwd: '/w', spawnTimestamp: 7, sessionsDir: '/r/sessions', onRollout }, cb)
    expect((vi.mocked(watchAndClaimRollout).mock.calls[3][6] as { onRollout?: unknown }).onRollout).toBe(onRollout)
    vi.mocked(watchAndClaimRollout).mockClear()
    new CodexProvider().ingestSessionTelemetry('sid', { cwd: '/w', spawnTimestamp: 7, sessionsDir: '/r/sessions' }, cb)
    expect(vi.mocked(watchAndClaimRollout).mock.calls[0]).toEqual(['sid', '/w', 7, cb, '/r/sessions', undefined])
  })
})
