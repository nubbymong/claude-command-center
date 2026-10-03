// [host] WP2 PR 4, P4.3 (row 53), the IPC side (src/main/ipc/pty-handlers.ts):
//  - `askConductor:handOff`: a question for a live Ask session on Codex,
//    answered only to the app's own window (its top frame), with a strict
//    payload, and handed to main's submit-primitive door
//    (pty-manager handOffAskQuestion), never written raw;
//  - the help folder rebuilt in main before EVERY Ask spawn of either
//    assistant (a first launch, a revive, a Restart, Past discussions, an
//    account switch's remount, a restored tab all come through pty:spawn),
//    last before the spawn, and failing closed: no rebuild, no launch, and
//    a fixed sentence, never the file system's own message (review RASK-2);
//  - the spawn starts in the folder just rebuilt, whatever folder the tab
//    kept (review RASK-1; pty-manager holds a resumed conversation to it,
//    ask-launch-folder.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  order: [] as string[],
  spawned: [] as Array<Record<string, unknown> | undefined>,
  rebuildThrows: null as Error | null,
  handOffs: [] as Array<{ sessionId: string; question: string }>,
  // ADR-009 round 1: the runs in the help folder end, or do not, as each case says.
  endAnswer: true,
  endGate: null as Promise<void> | null,
  prepCurrent: true,
  prepared: [] as string[],
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
  app: { getVersion: () => '9.9.9-test' },
}))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn((_win: unknown, _id: string, opts?: Record<string, unknown>) => { h.order.push('spawn'); h.spawned.push(opts) }), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), endSshRemote: vi.fn(),
  beginSpawnPreparation: vi.fn((_win: unknown, id: string) => {
    h.prepared.push(id)
    return { get current() { return h.prepCurrent }, spawn: (opts?: Record<string, unknown>) => { h.order.push('spawn'); h.spawned.push(opts) }, abandon: vi.fn(() => { h.order.push('abandon') }) }
  }),
  holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionLiveOrStarting: () => false, getKeptCodexConversationSource: () => undefined, getKeptCodexConversation: () => undefined,
  codexRunEnded: async () => true,
  endAgentRunsInFolder: vi.fn(async (folder: string) => {
    h.order.push(`end ${folder}`)
    if (h.endGate) await h.endGate
    h.order.push('ended')
    return h.endAnswer
  }),
  handOffAskQuestion: vi.fn(async (_win: unknown, sessionId: string, question: string) => { h.handOffs.push({ sessionId, question }); return { delivered: true } }),
}))
vi.mock('../../../src/main/help-workspace', () => ({
  ensureHelpWorkspace: vi.fn((dir: string, opts: { appVersion?: string }) => {
    h.order.push(`rebuild ${dir} ${opts?.appVersion}`)
    if (h.rebuildThrows) throw h.rebuildThrows
    return `${dir}/help`
  }),
  // Review R-5: the help folder's one spelling, which pty:spawn must take from
  // here (a stand-in value, so a folder spelled anywhere else shows).
  helpWorkspaceDir: (dir: string) => `${dir}|THE-HELP-FOLDER`,
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => 'C:/res' }))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    prepareLaunch: async () => ({ ok: true, lease: { release: vi.fn(), accountId: 'acct-1' }, executable: '/proven/codex', env: {}, sessionsDir: '/s', home: '/h' }),
    snapshot: () => ({ providers: [] }),
    remoteLaunchRefusal: () => null,
  }),
}))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))

const { IPC } = await import('../../../src/shared/ipc-channels')
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const ptyManager = await import('../../../src/main/pty-manager')
const { ASK_HELP_FOLDER_FAILED } = await import('../../../src/shared/ask-conductor-provider')

const mainFrame = { id: 'top' }
const webContents = { mainFrame }
const win = { isDestroyed: () => false, webContents }
registerPtyHandlers(() => win as never)
const handOff = h.handlers.get(IPC.ASK_CONDUCTOR_HAND_OFF)!
const spawn = h.handlers.get('pty:spawn')!
const fromApp = { sender: webContents, senderFrame: mainFrame }
const SID = 'askh1111askh1111askh1111'

beforeEach(() => {
  h.order = []
  h.spawned = []
  h.rebuildThrows = null
  h.handOffs = []
  h.endAnswer = true
  h.endGate = null
  h.prepCurrent = true
  h.prepared = []
  vi.mocked(ptyManager.handOffAskQuestion).mockClear()
})

/** What pty:spawn hands pty-manager to end before the rebuild: the help folder
 *  as help-workspace spells it (helpWorkspaceDir, the spelling
 *  ensureHelpWorkspace rebuilds; help-workspace-skill.test.ts pins the two). */
const END = 'end C:/res|THE-HELP-FOLDER'
const REBUILD = 'rebuild C:/res 9.9.9-test'

describe('askConductor:handOff', () => {
  it('[host] is registered', () => {
    expect(typeof handOff).toBe('function')
  })

  it('[host] the app\'s window: the question goes to main\'s submit-primitive door, whole', async () => {
    expect(await handOff(fromApp, { sessionId: SID, question: 'and then?' })).toEqual({ delivered: true })
    expect(h.handOffs).toEqual([{ sessionId: SID, question: 'and then?' }])
  })

  it('[host] another sender, or a frame inside the window: nothing handed over', async () => {
    expect(await handOff({ sender: {}, senderFrame: mainFrame }, { sessionId: SID, question: 'x' })).toEqual({ delivered: false, reason: 'session-gone' })
    expect(await handOff({ sender: webContents, senderFrame: { id: 'child' } }, { sessionId: SID, question: 'x' })).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.handOffs).toEqual([])
  })

  it.each([
    ['no payload', undefined],
    ['an unknown key', { sessionId: SID, question: 'x', raw: true }],
    ['a session id that is not one', { sessionId: '../../etc', question: 'x' }],
    ['an empty question', { sessionId: SID, question: '' }],
    ['a question past 8,000 characters', { sessionId: SID, question: 'q'.repeat(8_001) }],
    ['a question of the wrong type', { sessionId: SID, question: 42 }],
  ])('[host] refuses %s', async (_name, payload) => {
    expect(await handOff(fromApp, payload)).toEqual({ delivered: false, reason: 'refused-text' })
    expect(h.handOffs).toEqual([])
  })
})

describe('the help folder is rebuilt before every Ask spawn', () => {
  it('[host] a Claude Ask spawn: the runs in the folder ended, rebuilt in main, then spawned', async () => {
    await spawn({}, SID, { cwd: 'C:/res/help', isAsk: true })
    expect(h.order).toEqual([END, 'ended', REBUILD, 'spawn'])
  })

  it('[host] a Codex Ask spawn: rebuilt last, after the account is prepared, then spawned', async () => {
    await spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, provider: 'codex', codexOptions: { permissionsPreset: 'standard' } })
    expect(h.order).toEqual([END, 'ended', REBUILD, 'spawn'])
  })

  it('[host] a rebuild that fails starts nothing (fails closed)', async () => {
    h.rebuildThrows = new Error('EPERM')
    await expect(spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, provider: 'codex', codexOptions: { permissionsPreset: 'standard' } })).rejects.toThrow(ASK_HELP_FOLDER_FAILED)
    expect(h.order).toEqual([END, 'ended', REBUILD, 'abandon'])
  })

  it('[host] not for a session that is not Ask\'s, nor for the Ask tab\'s shell', async () => {
    await spawn({}, SID, { cwd: 'C:/dev/project' })
    await spawn({}, 'askh2222askh2222askh2222', { cwd: 'C:/res/help', isAsk: true, shellOnly: true })
    expect(h.order).toEqual(['spawn', 'spawn'])
    // Their folders are their own.
    expect(h.spawned.map((o) => o?.cwd)).toEqual(['C:/dev/project', 'C:/res/help'])
  })
})

describe('nothing still running writes into the help folder once it is rebuilt (ADR-009 round 1, L1-2)', () => {
  const ASSISTANTS: Array<[string, Record<string, unknown>]> = [['Claude Code', {}], ['Codex', { provider: 'codex', codexOptions: { permissionsPreset: 'standard' } }]]

  it.each(ASSISTANTS)('[host] %s: the rebuild waits until every run in the folder has ended', async (_name, extra) => {
    let release!: () => void
    h.endGate = new Promise<void>((r) => { release = r })
    const started = spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, ...extra }) as Promise<unknown>
    await new Promise((r) => setTimeout(r, 20))
    expect(h.order).toEqual([END])
    release()
    await started
    expect(h.order).toEqual([END, 'ended', REBUILD, 'spawn'])
  })

  it.each(ASSISTANTS)('[host] %s: a run that does not end in time: nothing rebuilt, nothing started, the fixed sentence', async (_name, extra) => {
    h.endAnswer = false
    const thrown = await (spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, ...extra }) as Promise<unknown>).then(() => null, (e: unknown) => e as Error)
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.message).toBe(ASK_HELP_FOLDER_FAILED)
    expect(h.order).toEqual([END, 'ended', 'abandon'])
    expect(h.spawned).toEqual([])
  })

  it.each(ASSISTANTS)('[host] %s: closed while the runs ended: nothing rebuilt or started, and said so', async (_name, extra) => {
    let release!: () => void
    h.endGate = new Promise<void>((r) => { release = r })
    const started = spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, ...extra }) as Promise<unknown>
    await new Promise((r) => setTimeout(r, 20))
    h.prepCurrent = false
    release()
    expect(await started).toEqual({ started: false })
    expect(h.order).toEqual([END, 'ended', 'abandon'])
    expect(h.spawned).toEqual([])
  })

  it('[host] an Ask spawn of either assistant is prepared (the end of its previous run is the spawn\'s to supersede); another Claude spawn is not', async () => {
    await spawn({}, SID, { cwd: 'C:/res/help', isAsk: true })
    await spawn({}, 'askh3333askh3333askh3333', { cwd: 'C:/dev/project' })
    expect(h.prepared).toEqual([SID])
  })
})

describe('a failed rebuild is said in a fixed sentence (P4.3 review RASK-2)', () => {
  it.each([['Claude Code', {}], ['Codex', { provider: 'codex', codexOptions: { permissionsPreset: 'standard' } }]])('[host] %s: the tab gets the plain sentence, never the file system\'s message', async (_name, extra) => {
    // The message names the path and an entry a session chose; none of it may
    // reach the tab.
    h.rebuildThrows = Object.assign(new Error('EPERM: operation not permitted, unlink \'C:\\res\\help\\planted-by-a-session.md\''), { code: 'EPERM', syscall: 'unlink' })
    const thrown = await (spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, ...extra }) as Promise<unknown>).then(() => null, (e: unknown) => e as Error)
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.message).toBe(ASK_HELP_FOLDER_FAILED)
    expect(thrown!.message).not.toMatch(/EPERM|unlink|planted|C:/)
    expect(h.spawned).toEqual([])
  })
})

describe('the Ask spawn starts in the folder just rebuilt (P4.3 review RASK-1)', () => {
  // A Restart, Past discussions, an account switch's remount and a restored
  // tab all send the folder the tab was opened in; after the resources folder
  // moved, that is the old one (left unrebuilt) or one that is gone.
  it.each([
    ['the folder of a resources folder that moved', 'D:/old-resources/help'],
    ['a folder that is gone', 'C:/gone/help'],
    ['no folder', undefined],
    ['the folder just rebuilt', 'C:/res/help'],
  ])('[host] %s, on either assistant: the spawn runs in the rebuilt one', async (_name, kept) => {
    await spawn({}, SID, { cwd: kept, isAsk: true })
    await spawn({}, SID, { cwd: kept, isAsk: true, provider: 'codex', codexOptions: { permissionsPreset: 'read-only' } })
    await spawn({}, SID, { cwd: kept, isAsk: true, useResumePicker: true, resume: { uuid: '11111111-2222-3333-4444-555555555555', cwd: kept ?? 'D:/x' } })
    expect(h.spawned.map((o) => o?.cwd)).toEqual(['C:/res/help', 'C:/res/help', 'C:/res/help'])
  })
})

describe('an opening question reaches a spawn only when it is made as Ask Conductor (review R-3)', () => {
  const ASSISTANTS: Array<[string, Record<string, unknown>]> = [['Claude Code', {}], ['Codex', { provider: 'codex', codexOptions: { permissionsPreset: 'standard' } }]]

  it.each(ASSISTANTS)('[host] %s: a launch that is not Ask\'s gets no question, and the log says so in a fixed sentence', async (_name, extra) => {
    const { logWarn } = await import('../../../src/main/debug-logger')
    vi.mocked(logWarn).mockClear()
    await spawn({}, SID, { cwd: 'C:/dev/project', askPrompt: 'type this PLANTEDWORD', ...extra })
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]).not.toHaveProperty('askPrompt')
    const logged = vi.mocked(logWarn).mock.calls.map((c) => String(c[0]))
    expect(logged).toContain(`[pty] Session ${SID}: an opening question on a launch that is not Ask Conductor's is dropped`)
    expect(logged.join('\n')).not.toContain('PLANTEDWORD')
  })

  it.each(ASSISTANTS)('[host] %s: an Ask launch keeps its question', async (_name, extra) => {
    await spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, askPrompt: 'how do I add an account?', ...extra })
    expect(h.spawned[0]?.askPrompt).toBe('how do I add an account?')
  })
})
