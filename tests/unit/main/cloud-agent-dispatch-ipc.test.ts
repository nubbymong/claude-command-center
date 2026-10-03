/**
 * [host] WP2 PR 4, P4.5 (row 57): the Cloud Agents IPC answers only the
 * app's own window (its top frame), and `cloudAgent:dispatch` holds what
 * starts an agent to a strict schema: a known provider, and an account of
 * that provider's class -- a Claude Code agent a profile (never a registry
 * account id), a Codex agent an `acct-` registry account (never a profile),
 * neither with the other's fields, an acknowledgement only with the account
 * it names, the model and effort by the launch's own rules. A refused
 * request is answered and reaches nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } }, BrowserWindow: class {} }))
const m = vi.hoisted(() => ({
  dispatchAgent: vi.fn(async (p: unknown) => ({ id: 'ca-1', p })),
  retryAgent: vi.fn(async () => ({ id: 'ca-2' })),
  cancelAgent: vi.fn(() => true),
  removeAgent: vi.fn(() => ({ ok: true, removed: true })),
  listAgents: vi.fn(() => [{ id: 'ca-1' }]),
  getAgentOutput: vi.fn(() => 'out'),
  clearCompletedAgents: vi.fn(() => ({ ok: true, removed: 1 })),
}))
vi.mock('../../../src/main/cloud-agent-manager', () => ({ initCloudAgentManager: vi.fn(), cleanupStuckAgents: vi.fn(), ...m }))

const { registerCloudAgentHandlers, dispatchSchema } = await import('../../../src/main/ipc/cloud-agent-handlers')

const mainFrame = { id: 'main' }
const webContents = { mainFrame }
const win = { isDestroyed: () => false, webContents }
registerCloudAgentHandlers(() => win as never)

const TRUSTED = { sender: webContents, senderFrame: mainFrame }
const SUBFRAME = { sender: webContents, senderFrame: { id: 'child' } }
const OTHER_WINDOW = { sender: { mainFrame: {} }, senderFrame: {} }
const call = (ch: string, ev: unknown, ...args: unknown[]) => handlers.get(ch)!(ev, ...args)

const ACCT = 'acct-' + '0123456789abcdef'.repeat(2)
const BASE = { name: 'Tidy', description: 'Tidy the imports', projectPath: 'C:\\dev\\p' }
const REJECTED = { rejected: 'That agent request was not valid.' }

beforeEach(() => { for (const f of Object.values(m)) f.mockClear() })

describe('cloudAgent:dispatch, the strict schema', () => {
  const ok: Array<[string, Record<string, unknown>]> = [
    ['a Claude Code agent as today', { ...BASE, configId: 'cfg-1', profileId: 'profile-abc', legacyVersion: { enabled: true, version: '2.0.1' }, skipPermissions: true }],
    ['a Claude Code agent naming its provider', { ...BASE, provider: 'claude' }],
    ['a Codex agent on the provider default', { ...BASE, provider: 'codex' }],
    ['a Codex agent on a named account, acknowledged, with the config model and effort', { ...BASE, provider: 'codex', providerAccountId: ACCT, acknowledgeRealmOnly: true, skipPermissions: true, codexOptions: { model: 'gpt-5.5', reasoningEffort: 'high' } }],
    ['a Codex agent with an empty model (no override)', { ...BASE, provider: 'codex', codexOptions: { model: '' } }],
  ]
  for (const [what, params] of ok) {
    it(`takes ${what}`, async () => {
      expect(dispatchSchema.safeParse(params).success).toBe(true)
      expect(await call('cloudAgent:dispatch', TRUSTED, params)).toMatchObject({ id: 'ca-1' })
      expect(m.dispatchAgent).toHaveBeenCalledTimes(1)
    })
  }

  const refused: Array<[string, unknown]> = [
    ['an unknown provider', { ...BASE, provider: 'gemini' }],
    ['a Codex account id on a Claude Code agent', { ...BASE, provider: 'claude', providerAccountId: ACCT }],
    ['a Codex account id given as a Claude profile', { ...BASE, profileId: ACCT }],
    ['a Codex account id given as a Claude profile, provider claude', { ...BASE, provider: 'claude', profileId: ACCT }],
    ['a profile on a Codex agent', { ...BASE, provider: 'codex', profileId: 'profile-abc' }],
    ['a profile id as the Codex account', { ...BASE, provider: 'codex', providerAccountId: 'profile-abc' }],
    ['an identity id as the Codex account (wrong class)', { ...BASE, provider: 'codex', providerAccountId: 'idn-' + 'a'.repeat(32) }],
    ['a realm id as the Codex account (wrong class)', { ...BASE, provider: 'codex', providerAccountId: 'realm-' + 'a'.repeat(32) }],
    ['an upper-case account id', { ...BASE, provider: 'codex', providerAccountId: 'acct-' + 'A'.repeat(32) }],
    ['a pinned CLI version on a Codex agent', { ...BASE, provider: 'codex', legacyVersion: { enabled: true, version: '2.0.1' } }],
    ['Codex options on a Claude Code agent', { ...BASE, codexOptions: { model: 'gpt-5.5' } }],
    ['an acknowledgement on a Claude Code agent', { ...BASE, acknowledgeRealmOnly: true }],
    ['an acknowledgement naming no account', { ...BASE, provider: 'codex', acknowledgeRealmOnly: true }],
    ['an acknowledgement that is not true', { ...BASE, provider: 'codex', providerAccountId: ACCT, acknowledgeRealmOnly: 'yes' }],
    ['a model that would read as a flag', { ...BASE, provider: 'codex', codexOptions: { model: '-c' } }],
    ['a model with a space', { ...BASE, provider: 'codex', codexOptions: { model: 'gpt 5' } }],
    ['an effort off the list', { ...BASE, provider: 'codex', codexOptions: { reasoningEffort: 'extreme' } }],
    ['a sandbox chosen by the renderer', { ...BASE, provider: 'codex', codexOptions: { sandbox: 'danger-full-access' } }],
    ['an unknown field (a working folder, say)', { ...BASE, provider: 'codex', cwd: 'C:\\' }],
    ['no task', { ...BASE, description: '' }],
    ['no project', { ...BASE, projectPath: '' }],
    ['a project that is not a string', { ...BASE, projectPath: ['C:\\'] }],
    ['not an object', 'run everything'],
    ['nothing', undefined],
  ]
  for (const [what, params] of refused) {
    it(`refuses ${what}, reaching nothing`, async () => {
      expect(await call('cloudAgent:dispatch', TRUSTED, params)).toEqual(REJECTED)
      expect(m.dispatchAgent).not.toHaveBeenCalled()
    })
  }

  it('what reaches the manager is the parsed request', async () => {
    await call('cloudAgent:dispatch', TRUSTED, { ...BASE, provider: 'codex', providerAccountId: ACCT, codexOptions: { model: 'gpt-5.5' } })
    expect(m.dispatchAgent).toHaveBeenCalledWith({ ...BASE, provider: 'codex', providerAccountId: ACCT, codexOptions: { model: 'gpt-5.5' } })
  })
})

describe('cloudAgent:retry', () => {
  it('takes an id, and the acknowledgement only as true', async () => {
    expect(await call('cloudAgent:retry', TRUSTED, 'ca-1')).toEqual({ id: 'ca-2' })
    expect(m.retryAgent).toHaveBeenLastCalledWith('ca-1', {})
    expect(await call('cloudAgent:retry', TRUSTED, 'ca-1', { acknowledgeRealmOnly: true })).toEqual({ id: 'ca-2' })
    expect(m.retryAgent).toHaveBeenLastCalledWith('ca-1', { acknowledgeRealmOnly: true })
    m.retryAgent.mockClear()
    for (const [id, opts] of [[7, undefined], ['', undefined], ['ca-1', { acknowledgeRealmOnly: false }], ['ca-1', { providerAccountId: ACCT }], ['ca-1', 'yes']] as Array<[unknown, unknown]>) {
      expect(await call('cloudAgent:retry', TRUSTED, id, opts), JSON.stringify([id, opts])).toEqual(REJECTED)
    }
    expect(m.retryAgent).not.toHaveBeenCalled()
  })
})

describe("only the app's own window, top frame", () => {
  for (const [who, ev] of [['a subframe', SUBFRAME], ['another window', OTHER_WINDOW], ['no sender', {}]] as const) {
    it(`${who}: every channel answers without acting`, async () => {
      const untrusted = { rejected: 'This request did not come from the app window.' }
      expect(await call('cloudAgent:dispatch', ev, { ...BASE })).toEqual(untrusted)
      expect(await call('cloudAgent:retry', ev, 'ca-1')).toEqual(untrusted)
      expect(await call('cloudAgent:cancel', ev, 'ca-1')).toBe(false)
      expect(await call('cloudAgent:remove', ev, 'ca-1')).toMatchObject({ ok: false })
      expect(await call('cloudAgent:list', ev)).toEqual([])
      expect(await call('cloudAgent:getOutput', ev, 'ca-1')).toBe('')
      expect(await call('cloudAgent:clearCompleted', ev)).toMatchObject({ ok: false })
      for (const f of Object.values(m)) expect(f).not.toHaveBeenCalled()
    })
  }

  it('the window itself: every channel acts', async () => {
    expect(await call('cloudAgent:cancel', TRUSTED, 'ca-1')).toBe(true)
    expect(await call('cloudAgent:remove', TRUSTED, 'ca-1')).toEqual({ ok: true, removed: true })
    expect(await call('cloudAgent:list', TRUSTED)).toEqual([{ id: 'ca-1' }])
    expect(await call('cloudAgent:getOutput', TRUSTED, 'ca-1')).toBe('out')
    expect(await call('cloudAgent:clearCompleted', TRUSTED)).toEqual({ ok: true, removed: 1 })
    expect(await call('cloudAgent:cancel', TRUSTED, { id: 'ca-1' })).toBe(false)
  })
})
