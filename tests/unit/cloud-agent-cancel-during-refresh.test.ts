// rc.15 review R5 (Codex, 2026-09-06; aicc_planning#49): the reviewer's
// characterization (evidence/accounts-cloud-cancel.review.test.ts) flipped into
// the desired behaviour, credit Codex rc.15 stability review; RED against
// 7ef62a2e before this change.
//
// Dispatch publishes its running record, then parks on an await (the legacy
// CLI install, the account refresh). A Cancel that lands there finds no process,
// marks the record cancelled and returns true -- and the resumed dispatch used
// to spawn anyway: work running while labelled cancelled, with a second Cancel
// refused and Remove hiding the row. Dispatch now re-reads the record after
// EVERY pre-spawn await and, if it was cancelled or removed, releases the hold,
// deletes the prompt file, broadcasts and returns without spawning.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeProviders } from '../../src/main/providers/compose'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mockSpawn = vi.fn()
vi.mock('child_process', () => ({ spawn: (...args: any[]) => mockSpawn(...args), execSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock('../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
  writeConfig: () => true, getConfigDir: () => process.env.TEMP ?? '/tmp', ensureConfigDir() {},
}))
const legacy = vi.hoisted(() => ({ install: null as null | (() => void), installed: false }))
vi.mock('../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: () => null,
  isVersionInstalled: () => legacy.installed,
  installVersion: () => new Promise<{ ok: boolean }>((resolve) => { legacy.install = () => resolve({ ok: false }) }),
}))
const state = vi.hoisted(() => ({ home: '' }))
vi.mock('../../src/main/account-profiles', async (original) => ({
  ...(await original<typeof import('../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null, getProfileConfigDir: () => state.home,
  setupProfileLinks() {}, listProfiles: () => [{ id: 'profile-review', accountEmail: 'review@example.test' }],
}))

import { initCloudAgentManager, dispatchAgent, listAgents, cancelAgent, removeAgent, _resetCloudAgentLatchForTest } from '../../src/main/cloud-agent-manager'
import { noteProfileRefreshInFlight, _resetProfileConsumersForTest, hasTransientProfileConsumer } from '../../src/main/profile-consumers'

// The cloud agent runs the CLI under a managed profile home, so its env goes
// through withProfileHome -- which takes the Claude package's own ambient-strip
// list and host control from the registry and fails closed when nothing is
// registered. Boot composes before anything dispatches; so must this.
beforeAll(() => { composeProviders() })


const handlers: Record<string, (...args: any[]) => void> = {}
const promptFile = (id: string) => path.join(os.tmpdir(), `ccc-agent-${id}.txt`)
/** Wait for a condition the project-settings GATE has to answer first.
 *  `dispatchAgent` awaits `gateManagedLaunch(params.projectPath)` before it
 *  publishes the record -- real file I/O, so the record lands on a MACROTASK
 *  and no microtask drain brings it forward. Bounded past the gate's own
 *  3000 ms deadline so a dispatch that never arrives fails the assertion
 *  rather than hanging the suite. */
const until = async (cond: () => boolean, why: string) => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting for ${why}`)
}
/** The published record of the one dispatch under test, once the gate has let
 *  it through. Every case below parks the dispatch on an await AFTER this
 *  point, so this is where "it is waiting" becomes observable. */
const waitingAgent = async () => {
  await until(() => listAgents().length === 1, 'the dispatch to pass the project gate')
  return listAgents()[0]
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-cloud-cancel-'))
  _resetCloudAgentLatchForTest()
  _resetProfileConsumersForTest()
  mockSpawn.mockClear()
  mockSpawn.mockImplementation(() => ({
    pid: 12345, stdout: { on() {} }, stderr: { on() {} }, kill: vi.fn(),
    on: (event: string, cb: (...args: any[]) => void) => { handlers[event] = cb },
  }))
  legacy.install = null
  legacy.installed = false
  initCloudAgentManager(() => null)
})
afterEach(() => {
  handlers.close?.(0)
  _resetProfileConsumersForTest()
  fs.rmSync(state.home, { recursive: true, force: true })
})

const params = { name: 'Synthetic agent', description: 'inert test prompt', projectPath: '', profileId: 'profile-review' }

describe('cancel while dispatch is waiting (Codex R5, flipped)', () => {
  it('Codex: cancelling while the refresh is pending -> the settled dispatch spawns NOTHING, the record stays cancelled, the hold is released, the prompt file is gone', async () => {
    let settle!: () => void
    noteProfileRefreshInFlight('profile-review', new Promise<void>((resolve) => { settle = resolve }))
    const dispatch = dispatchAgent({ ...params, projectPath: state.home })
    const waiting = await waitingAgent()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(fs.existsSync(promptFile(waiting.id))).toBe(true)
    expect(cancelAgent(waiting.id)).toBe(true)
    expect(waiting.status).toBe('cancelled')
    settle()
    const agent = await dispatch
    expect(agent.status).toBe('cancelled')
    expect(mockSpawn).not.toHaveBeenCalled() // 7ef62a2e: called once
    expect(hasTransientProfileConsumer('profile-review')).toBe(false) // 7ef62a2e: the hold stayed with the live child
    expect(fs.existsSync(promptFile(waiting.id))).toBe(false)
    expect(listAgents()[0].status).toBe('cancelled')
  })

  it('removing the record while the refresh is pending -> nothing spawns, the row stays gone', async () => {
    let settle!: () => void
    noteProfileRefreshInFlight('profile-review', new Promise<void>((resolve) => { settle = resolve }))
    const dispatch = dispatchAgent({ ...params, projectPath: state.home })
    const waiting = await waitingAgent()
    expect(removeAgent(waiting.id)).toEqual({ ok: true, removed: true })
    expect(listAgents()).toHaveLength(0)
    settle()
    const agent = await dispatch
    expect(agent.status).toBe('cancelled')
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(hasTransientProfileConsumer('profile-review')).toBe(false)
    expect(fs.existsSync(promptFile(waiting.id))).toBe(false)
    expect(listAgents()).toHaveLength(0)
  })

  it('cancelling during the legacy CLI install (the older await of the same shape) -> nothing spawns', async () => {
    const dispatch = dispatchAgent({ ...params, projectPath: state.home, legacyVersion: { enabled: true, version: '1.0.0' } })
    await until(() => legacy.install !== null, 'the dispatch to reach the legacy CLI install')
    expect(legacy.install).not.toBeNull()
    const waiting = listAgents()[0]
    expect(cancelAgent(waiting.id)).toBe(true)
    legacy.install!()
    const agent = await dispatch
    expect(agent.status).toBe('cancelled')
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(hasTransientProfileConsumer('profile-review')).toBe(false)
  })

  it('positive control: an uncancelled dispatch spawns exactly once after the refresh settles and keeps its hold while the child lives', async () => {
    let settle!: () => void
    noteProfileRefreshInFlight('profile-review', new Promise<void>((resolve) => { settle = resolve }))
    const dispatch = dispatchAgent({ ...params, projectPath: state.home })
    await waitingAgent()
    expect(mockSpawn).not.toHaveBeenCalled()
    settle()
    const agent = await dispatch
    expect(agent.status).toBe('running')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(hasTransientProfileConsumer('profile-review')).toBe(true)
    handlers.close?.(0)
    expect(hasTransientProfileConsumer('profile-review')).toBe(false)
  })
})
