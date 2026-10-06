// HOST QUARANTINE: plants junctions and links (directory links). [CI] [VM] only -- never run on the owner's machine.
/**
 * WP2 PR 4, P4.7 (row 68): a Codex Insights report and links. The report
 * reads the account's sessions folder and runs Codex in a folder it makes;
 * neither may be steered elsewhere by a link:
 *  - the sessions walk never follows a link or junction (a folder or a file),
 *    and a sessions folder that is itself one reads as no sessions;
 *  - a runs folder (`<insights>/.insights-codex-runs`) that is a link, or became one
 *    between the check and the make, is refused: no model run, nothing
 *    written through it.
 * The REAL reader and runner; the accounts service and the model run are
 * fakes, so no process starts. Every folder is under this suite's own temp
 * folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const ACCT = `acct-${'a'.repeat(16)}`
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

const h = vi.hoisted(() => ({
  resourcesDir: '',
  sessionsDir: '',
  execCalls: 0,
  beforeMkdtemp: null as null | ((prefix: string) => void),
}))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const mkdtempSync = ((prefix: string, opts?: unknown) => {
    const hook = h.beforeMkdtemp
    if (hook) { h.beforeMkdtemp = null; hook(prefix) }
    return (real.mkdtempSync as (p: string, o?: unknown) => string)(prefix, opts)
  }) as typeof real.mkdtempSync
  return { ...real, mkdtempSync, default: { ...real, mkdtempSync } }
})
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.resourcesDir, registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }), withProfileHome: (env: unknown) => env }))
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no PTY') } }))
// The model run is the registered Codex package's Insights port (P4.7 fix
// pass 1); the module behind the real port is mocked too, so neither starts
// a process. Either one called counts as a model run.
vi.mock('../../../src/main/providers/codex/insights-exec', () => ({
  CODEX_INSIGHTS_TIMEOUT_MS: 600_000,
  runCodexInsightsExec: async () => { h.execCalls++; return { ok: false, code: 'failed', message: 'not expected to run' } },
  createCodexInsightsOperations: () => ({ run: async () => { h.execCalls++; return { ok: false, code: 'failed', message: 'not expected to run' } } }),
}))
vi.mock('../../../src/main/providers/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/providers/core')>()),
  tryGetProviderPackage: (id: string) => (id === 'codex' ? {
    displayName: 'Codex',
    insights: { run: async () => { h.execCalls++; return { ok: false, code: 'failed', message: 'not expected to run' } } },
  } : undefined),
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: () => null,
    snapshot: () => ({ accounts: [], identities: [] }),
    prepareLaunch: async (input: Record<string, unknown>) => ({
      ok: true, lease: { release: () => {} }, binding: { providerAccountId: input.providerAccountId }, realmOnly: false,
      home: path.dirname(h.sessionsDir), executable: '/usr/bin/codex', env: { PATH: '/usr/bin' }, sessionsDir: h.sessionsDir,
    }),
  }),
}))

const { listCodexRolloutFiles } = await import('../../../src/main/insights-codex')
const { runCodexInsights, getCatalogue } = await import('../../../src/main/insights-runner')
const win = () => null
let tmpRoot = ''

const ROLLOUT = () => [
  { timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: 'C:\\p' } },
  { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } },
].map((l) => JSON.stringify(l)).join('\n') + '\n'

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ins-codex-links-'))
  h.resourcesDir = path.join(tmpRoot, 'resources')
  h.sessionsDir = path.join(tmpRoot, 'realm', 'sessions')
  fs.mkdirSync(h.resourcesDir, { recursive: true })
  fs.mkdirSync(path.join(h.sessionsDir, '2026', '10', '01'), { recursive: true })
  fs.writeFileSync(path.join(h.sessionsDir, '2026', '10', '01', 'rollout-own.jsonl'), ROLLOUT())
  h.execCalls = 0
  h.beforeMkdtemp = null
})
afterEach(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('the sessions walk never follows a link [CI] [VM]', () => {
  it('a junction inside the sessions folder is not followed [CI] [VM]', async () => {
    const elsewhere = path.join(tmpRoot, 'elsewhere', '2026', '10', '02')
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.writeFileSync(path.join(elsewhere, 'rollout-other.jsonl'), ROLLOUT())
    fs.symlinkSync(path.join(tmpRoot, 'elsewhere', '2026'), path.join(h.sessionsDir, '2027'), LINK_TYPE)
    const files = await listCodexRolloutFiles(h.sessionsDir, 0)
    expect(files.map((f) => path.basename(f.file))).toEqual(['rollout-own.jsonl'])
  })

  it('a sessions folder that is itself a link reads as no sessions [CI] [VM]', async () => {
    const linked = path.join(tmpRoot, 'linked-sessions')
    fs.symlinkSync(h.sessionsDir, linked, LINK_TYPE)
    expect(await listCodexRolloutFiles(linked, 0)).toEqual([])
  })

  it("a report on an account whose sessions folder is a link says so, never that it has no sessions (review F5) [CI] [VM]", async () => {
    const real = path.join(tmpRoot, 'moved-sessions')
    fs.renameSync(h.sessionsDir, real)
    fs.symlinkSync(real, h.sessionsDir, LINK_TYPE)
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(getCatalogue().runs.find((r) => r.id === id)!.error).toBe("This account has no Codex sessions from the last 30 days that the app can read: its sessions folder, or a folder in it, is a link, which the app does not follow.")
    expect(h.execCalls).toBe(0)
  })

  it('a rollout file that is a symbolic link is not listed (where file links can be made) [CI] [VM]', async (ctx) => {
    const target = path.join(tmpRoot, 'secret.jsonl')
    fs.writeFileSync(target, ROLLOUT())
    try { fs.symlinkSync(target, path.join(h.sessionsDir, '2026', '10', '01', 'rollout-link.jsonl'), 'file') } catch { ctx.skip(); return }
    const files = await listCodexRolloutFiles(h.sessionsDir, 0)
    expect(files.map((f) => path.basename(f.file))).toEqual(['rollout-own.jsonl'])
  })
})

describe('the runs folder is never a link [CI] [VM]', () => {
  it('a runs folder that is a link is refused: no model run, nothing swept, made or written through it [CI] [VM]', async () => {
    const outside = path.join(tmpRoot, 'outside')
    // A stale leftover-shaped folder in the link's target: a sweep that followed
    // the link would remove it.
    const victim = path.join(outside, 'ccc-insights-codex-victim1')
    fs.mkdirSync(victim, { recursive: true })
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'kept')
    const old = new Date(Date.now() - 3 * 3600_000)
    fs.utimesSync(victim, old, old)
    fs.mkdirSync(path.join(h.resourcesDir, 'insights'), { recursive: true })
    fs.symlinkSync(outside, path.join(h.resourcesDir, 'insights', '.insights-codex-runs'), LINK_TYPE)
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(getCatalogue().runs.find((r) => r.id === id)).toMatchObject({ status: 'failed', error: 'This report could not be written: no empty folder could be made for it.' })
    expect(h.execCalls).toBe(0)
    expect(fs.readdirSync(outside)).toEqual(['ccc-insights-codex-victim1'])
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true)
  })

  it('a runs folder that became a link between the check and the make is refused, and the folder made through it removed [CI] [VM]', async () => {
    const outside = path.join(tmpRoot, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    h.beforeMkdtemp = (prefix) => {
      const parent = path.dirname(prefix)
      fs.rmSync(parent, { recursive: true, force: true })
      fs.symlinkSync(outside, parent, LINK_TYPE)
    }
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(getCatalogue().runs.find((r) => r.id === id)).toMatchObject({ status: 'failed', error: 'This report could not be written: no empty folder could be made for it.' })
    expect(h.execCalls).toBe(0)
    expect(fs.readdirSync(outside)).toEqual([])
  })
})
