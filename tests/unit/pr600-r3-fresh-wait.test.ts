// ADR-009 round 3 (Codex PR600 finding 3): a FRESH deferred spawn (no
// predecessor to tear down) that fails after the refresh wait settled must
// notify the renderer, not leave a blank terminal treated as spawned. Desired-
// behaviour regression: RED before the fix (the exit was swallowed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ attempts: 0, refuse: false }))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP },
}))
vi.mock('node-pty', () => ({ spawn: () => {
  state.attempts++
  if (state.refuse) throw new Error('synthetic node-pty refusal')
  return { pid: 4242, cols: 80, rows: 24, process: 'sh',
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
} }))

const profiles = await import('../../src/main/account-profiles')
const consumers = await import('../../src/main/profile-consumers')
const identity = await import('../../src/main/claude-account-identity')
const { spawnPty, killPty, isSessionWritable } = await import('../../src/main/pty-manager')
const { registerFakeClaudePackage } = await import('../helpers/claude-package')
const messages: string[] = []
// Payloads too, not just channel names: what the renderer is TOLD is now part
// of the contract (see the exit assertion below), and a recorder that keeps
// only the channel cannot tell a readable reason from an empty frame.
const payloads: Array<[string, unknown]> = []
const win = {
  webContents: {
    send: (channel: string, payload?: unknown) => { messages.push(channel); payloads.push([channel, payload]) },
  },
  isDestroyed: () => false,
} as never
let root = ''
let profileId = ''
const ids = ['freshfail', 'freshcancel', 'syncfail']
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr600-r3-fresh-'))
  fs.mkdirSync(path.join(root, 'global', '.claude'), { recursive: true })
  profiles._setRootsForTest({ resourcesDir: root, sharedRoot: path.join(root, 'global', '.claude') })
  profileId = profiles.createProfile('Synthetic profile').id
  identity._resetForTest(); consumers._resetProfileConsumersForTest()
  state.attempts = 0; state.refuse = false; messages.length = 0
  registerFakeClaudePackage({ id: 'claude', displayName: 'Claude', resolveBinary: () => null,
    buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }), detectUiRunning: () => false,
    ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
    resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {},
    getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '' } as never)
})
afterEach(() => {
  for (const id of ids) killPty(id)
  identity._resetForTest(); consumers._resetProfileConsumersForTest()
  profiles._setRootsForTest(null); fs.rmSync(root, { recursive: true, force: true })
})

describe('PR600 R3 fresh deferred spawn failure (Codex finding 3)', () => {
  it('a fresh PTY refusal after the refresh wait notifies the renderer and releases the hold', async () => {
    let settle!: () => void
    consumers.noteProfileRefreshInFlight(profileId, new Promise<void>(resolve => { settle = resolve }))
    expect(() => spawnPty(win, 'freshfail', { shellOnly: true, profileId, cwd: root })).not.toThrow()
    expect(state.attempts).toBe(0)
    state.refuse = true
    settle()
    await flush()
    expect(state.attempts).toBe(1)
    expect(isSessionWritable('freshfail')).toBe(false)
    expect(consumers.profileConsumerCount(profileId)).toBe(0)
    // 7565739c: no exit was ever emitted -> a blank terminal treated as spawned.
    expect(messages).toContain('pty:exit:freshfail')
    // The assertion here used to be that NO data frame was sent. That was the
    // right shape when the only alternative was noise, and the wrong one once
    // the deferred path started explaining itself: the same failure arriving on
    // the async path rendered as a generic grey "[Process exited with code -1]"
    // while the synchronous path handed the caller the real message -- one
    // fault at two severities, purely because of spawn timing (adversarial
    // review, MAJOR 7). The reason is now WRITTEN to the terminal, and this
    // test holds it to that: a readable reason, BEFORE the exit.
    const data = payloads.find(([channel]) => channel === 'pty:data:freshfail')
    expect(data, 'the refusal reason never reached the terminal').toBeDefined()
    expect(String(data![1])).toContain('synthetic node-pty refusal')
    expect(messages.indexOf('pty:data:freshfail')).toBeLessThan(messages.indexOf('pty:exit:freshfail'))
  })
  it('control: cancel of a fresh parked spawn notifies the renderer', async () => {
    let settle!: () => void
    consumers.noteProfileRefreshInFlight(profileId, new Promise<void>(resolve => { settle = resolve }))
    spawnPty(win, 'freshcancel', { shellOnly: true, profileId, cwd: root })
    killPty('freshcancel'); settle(); await flush()
    expect(state.attempts).toBe(0)
    expect(messages).toContain('pty:exit:freshcancel')
    expect(consumers.profileConsumerCount(profileId)).toBe(0)
  })
  it('control: an ordinary synchronous refusal reaches the IPC caller', () => {
    state.refuse = true
    expect(() => spawnPty(win, 'syncfail', { shellOnly: true, profileId, cwd: root })).toThrow('synthetic node-pty refusal')
  })
})
