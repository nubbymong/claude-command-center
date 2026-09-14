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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const handlers: Record<string, (...args: any[]) => void> = {}
const promptFile = (id: string) => path.join(os.tmpdir(), `ccc-agent-${id}.txt`)
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve() }

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
    await tick()
    const waiting = listAgents()[0]
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
    await tick()
    const waiting = listAgents()[0]
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
    await tick()
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
    await tick()
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
