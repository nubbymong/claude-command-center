// rc.15 review R3 (Codex, 2026-09-06; aicc_planning#49): the reviewer's
// characterization (evidence/accounts-refresh-pty.review.test.ts) flipped into
// the desired behaviour, credit Codex rc.15 stability review; RED against
// 7ef62a2e before this change.
//
// The usage page refreshes an idle non-primary account's token (a POST that
// rotates the single-use refresh token). A profile-pinned login shell or an
// interactive session that spawned while that POST was pending read the
// credential generation being replaced, and registering it afterwards could not
// retract the POST. Both local spawn paths now wait the refresh out: the hold
// is taken first, the PTY exists only once the refresh settled, a kill during
// the wait releases the hold and spawns nothing, and writes during the wait are
// dropped, never queued.
//
// Real fetchAccountUsage held at a mocked POST; real spawnPty with node-pty mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

class FakePty {
  pid = 4242
  cols = 80
  rows = 24
  process = 'sh'
  handleFlowControl = false
  exitCb: ((event: { exitCode: number }) => void) | null = null
  onData() { return { dispose() {} } }
  onExit(cb: (event: { exitCode: number }) => void) { this.exitCb = cb; return { dispose() {} } }
  write = vi.fn()
  resize = vi.fn()
  kill = vi.fn()
  pause() {}
  resume() {}
  clear() {}
}
const ptys: FakePty[] = []
const held: { answer: (() => void) | null; methods: string[] } = { answer: null, methods: [] }
/** Fault injection for the deferred re-entry (quality round 3, M2): make the
 *  next spawn throw BEFORE the PTY is registered (node-pty refuses) or right
 *  AFTER it (the registry write that follows `ptySessions.set` throws). */
const inject: { spawnThrows: boolean; registryThrows: boolean } = { spawnThrows: false, registryThrows: false }
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
}))
vi.mock('node-pty', () => ({ spawn: () => {
  if (inject.spawnThrows) { inject.spawnThrows = false; throw new Error('injected: node-pty spawn failed') }
  const child = new FakePty(); ptys.push(child); return child
} }))
vi.mock('../../../src/main/session-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/session-registry')>()
  return {
    ...actual,
    updateSessionMeta: (...args: Parameters<typeof actual.updateSessionMeta>) => {
      if (inject.registryThrows) { inject.registryThrows = false; throw new Error('injected: registry write failed') }
      return actual.updateSessionMeta(...args)
    },
  }
})
vi.mock('../../../src/main/usage/usage-snapshots', () => ({ loadSnapshots: () => new Map(), saveSnapshots() {} }))
vi.mock('https', () => {
  const request = (opts: any, cb: (res: any) => void) => {
    held.methods.push(opts.method)
    const res: any = { statusCode: 400, headers: {}, on: (event: string, fn: () => void) => { if (event === 'end') fn(); return res } }
    held.answer = () => cb(res)
    const req: any = { on: () => req, write() {}, end() {}, destroy() {} }
    return req
  }
  return { request, default: { request } }
})

const profiles = await import('../../../src/main/account-profiles')
const { spawnPty, killPty, writePty, isSessionWritable } = await import('../../../src/main/pty-manager')
const { registerProvider } = await import('../../../src/main/providers')
const identity = await import('../../../src/main/claude-account-identity')
const consumers = await import('../../../src/main/profile-consumers')
const { fetchAccountUsage, _resetLiveUsageForTest, _resetSnapshotsForTest } = await import('../../../src/main/usage/account-usage')
const { isPtySessionLive } = await import('../../../src/main/session-registry')
const canvasLink = await import('../../../src/main/canvas/canvas-session-link')
const fakeProvider = {
  id: 'claude', displayName: 'Claude', resolveBinary: () => null,
  buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }), detectUiRunning: () => false,
  ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {},
  getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
} as never
const sent: Array<[string, unknown]> = []
const win = { webContents: { send: (ch: string, payload?: unknown) => { sent.push([ch, payload]) } }, isDestroyed: () => false } as never
let sandbox = ''
let profileId = ''
const sids: string[] = []
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve() }

/** Start the usage refresh and park it at its POST. (Returned inside an object:
 *  an async function returning the promise itself would adopt it and deadlock.) */
async function refreshInFlight(): Promise<{ fetching: Promise<unknown> }> {
  const fetching = fetchAccountUsage(profileId)
  for (let i = 0; i < 100 && !held.answer; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(held.methods).toEqual(['POST'])
  expect(consumers.pendingProfileRefresh(profileId)).not.toBeNull()
  return { fetching }
}
async function settle(fetching: Promise<unknown>): Promise<void> {
  held.answer!()
  await fetching
  await tick()
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-refresh-pty-'))
  profiles._setRootsForTest({ resourcesDir: sandbox, sharedRoot: path.join(sandbox, 'global', '.claude') })
  fs.mkdirSync(path.join(sandbox, 'global', '.claude'), { recursive: true })
  const p = profiles.createProfile('Synthetic account')
  profileId = p.id
  profiles.upsertProfile({ ...p, isPrimary: false, active: true, accountEmail: 'review@example.test' })
  const file = path.join(profiles.getProfileConfigDir(profileId), '.claude', '.credentials.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-expired', refreshToken: 'synthetic-refresh', expiresAt: 1 } }))
  registerProvider(fakeProvider)
  identity._resetClaudeAccounts()
  consumers._resetProfileConsumersForTest()
  _resetLiveUsageForTest()
  _resetSnapshotsForTest()
  held.answer = null
  held.methods = []
  ptys.length = 0
  sent.length = 0
  inject.spawnThrows = false
  inject.registryThrows = false
  canvasLink._resetCanvasSessionLinkForTest()
})
afterEach(() => {
  inject.spawnThrows = false
  inject.registryThrows = false
  for (const sid of sids.splice(0)) { try { killPty(sid) } catch { /* already gone */ } }
  for (const child of ptys) child.exitCb?.({ exitCode: 0 })
  identity._resetClaudeAccounts()
  consumers._resetProfileConsumersForTest()
  profiles._setRootsForTest(null)
  fs.rmSync(sandbox, { recursive: true, force: true })
})

describe('a local spawn waits out an in-flight refresh of its profile (Codex R3, flipped)', () => {
  it('Codex: a profile-pinned login shell does NOT start while the refresh POST is pending; it starts once the refresh settles, holding the profile throughout', async () => {
    const { fetching } = await refreshInFlight()
    sids.push('rc15refreshlogin')
    spawnPty(win, 'rc15refreshlogin', { shellOnly: true, profileId, cwd: sandbox })
    expect(ptys).toHaveLength(0) // 7ef62a2e: 1 -- the shell read the rotating generation
    // The hold is taken before the wait: no further rotation can start meanwhile.
    expect(consumers.hasTransientProfileConsumer(profileId)).toBe(true)
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(true)
    await settle(fetching)
    expect(ptys).toHaveLength(1)
    // The pre-wait hold was handed over: the shell's own hold is the one left.
    expect(consumers.profileConsumerCount(profileId)).toBe(1)
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(true)
    ptys[0].exitCb?.({ exitCode: 0 })
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(false)
  })

  it('the interactive path waits the same way and is watched once it starts', async () => {
    const { fetching } = await refreshInFlight()
    sids.push('rc15refreshclaude')
    spawnPty(win, 'rc15refreshclaude', { shellOnly: false, profileId, cwd: sandbox })
    expect(ptys).toHaveLength(0)
    expect(consumers.hasTransientProfileConsumer(profileId)).toBe(true)
    await settle(fetching)
    expect(ptys).toHaveLength(1)
    expect(identity.getWatchedProfileId('rc15refreshclaude')).toBe(profileId)
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(true)
  })

  it('a kill during the wait spawns nothing and releases the hold', async () => {
    const { fetching } = await refreshInFlight()
    spawnPty(win, 'rc15refreshkill', { shellOnly: true, profileId, cwd: sandbox })
    expect(consumers.hasTransientProfileConsumer(profileId)).toBe(true)
    killPty('rc15refreshkill')
    expect(consumers.hasTransientProfileConsumer(profileId)).toBe(false)
    await settle(fetching)
    expect(ptys).toHaveLength(0)
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(false)
  })

  it('a write during the wait is dropped, never queued into the shell that starts later', async () => {
    const { fetching } = await refreshInFlight()
    sids.push('rc15refreshwrite')
    spawnPty(win, 'rc15refreshwrite', { shellOnly: true, profileId, cwd: sandbox })
    writePty('rc15refreshwrite', 'rm -rf ./build\r')
    await settle(fetching)
    expect(ptys).toHaveLength(1)
    // The shell's own launch line (the cd) goes out on a timer and releases the
    // launch hold, which is when buffered writes are replayed -- at 7ef62a2e the
    // line typed during the refresh wait was replayed right here.
    const cdWritten = () => ptys[0].write.mock.calls.some(([d]) => /Set-Location|^cd /.test(String(d)))
    for (let i = 0; i < 60 && !cdWritten(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(cdWritten()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const written = ptys[0].write.mock.calls.map(([d]) => String(d)).join('')
    expect(written).not.toContain('rm -rf ./build')
  })

  it('a respawn of the same session id during the wait replaces the first wait: exactly one PTY starts', async () => {
    const { fetching } = await refreshInFlight()
    sids.push('rc15refreshtwice')
    spawnPty(win, 'rc15refreshtwice', { shellOnly: true, profileId, cwd: sandbox })
    spawnPty(win, 'rc15refreshtwice', { shellOnly: true, profileId, cwd: sandbox })
    expect(consumers.profileConsumerCount(profileId)).toBe(1) // the first wait's hold went with it
    await settle(fetching)
    expect(ptys).toHaveLength(1)
    expect(consumers.profileConsumerCount(profileId)).toBe(1)
  })

  it('review: Switch account under a mid-refresh profile -- the replaced PTY\'s exit during the wait is STALE (no exit reported, the deferred spawn still lands)', async () => {
    // A shell on profile P is live; profile Q (idle) is mid-refresh; the user
    // switches the session to Q: killPty + spawn -> the spawn defers on Q's
    // refresh, and P's PTY exits asynchronously in the meantime.
    const q = profiles.createProfile('Q')
    profiles.upsertProfile({ ...q, isPrimary: false, active: true, accountEmail: 'q@example.test' })
    const qFile = path.join(profiles.getProfileConfigDir(q.id), '.claude', '.credentials.json')
    fs.mkdirSync(path.dirname(qFile), { recursive: true })
    fs.writeFileSync(qFile, JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1 } }))
    sids.push('rc15switch')
    spawnPty(win, 'rc15switch', { shellOnly: true, profileId, cwd: sandbox })
    const old = ptys[0]
    const fetching = fetchAccountUsage(q.id)
    for (let i = 0; i < 100 && !held.answer; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(consumers.pendingProfileRefresh(q.id)).not.toBeNull()
    spawnPty(win, 'rc15switch', { shellOnly: true, profileId: q.id, cwd: sandbox })
    expect(ptys).toHaveLength(1) // deferred
    old.exitCb?.({ exitCode: 0 }) // the replaced PTY's exit arrives during the wait
    expect(sent.some(([ch]) => ch === 'pty:exit:rc15switch')).toBe(false) // stale: not the session's end
    expect(consumers.hasTransientProfileConsumer(q.id)).toBe(true) // the wait is still armed
    await settle(fetching)
    expect(ptys).toHaveLength(2)
    ptys[1].exitCb?.({ exitCode: 0 })
    expect(sent.some(([ch]) => ch === 'pty:exit:rc15switch')).toBe(true) // the real end is reported
  })

  it('review round 2: the card is closed while the respawn waits, after the replaced PTY\'s exit was suppressed -> the session is torn down once (not live, profile released, exit reported)', async () => {
    const q = profiles.createProfile('Q2')
    profiles.upsertProfile({ ...q, isPrimary: false, active: true, accountEmail: 'q2@example.test' })
    const qFile = path.join(profiles.getProfileConfigDir(q.id), '.claude', '.credentials.json')
    fs.mkdirSync(path.dirname(qFile), { recursive: true })
    fs.writeFileSync(qFile, JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1 } }))
    spawnPty(win, 'rc15abandon', { shellOnly: false, profileId, cwd: sandbox }) // interactive: watched on P
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(true)
    expect(isPtySessionLive('rc15abandon')).toBe(true)
    const old = ptys[0]
    const fetching = fetchAccountUsage(q.id)
    for (let i = 0; i < 100 && !held.answer; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    spawnPty(win, 'rc15abandon', { shellOnly: false, profileId: q.id, cwd: sandbox }) // Switch account onto Q: deferred
    old.exitCb?.({ exitCode: 0 }) // suppressed: the deferred spawn is the successor...
    expect(sent.filter(([ch]) => ch === 'pty:exit:rc15abandon')).toHaveLength(0)
    killPty('rc15abandon') // ...but the user closes the card before it lands
    expect(sent.filter(([ch]) => ch === 'pty:exit:rc15abandon')).toHaveLength(1) // the session's end IS reported
    expect(isPtySessionLive('rc15abandon')).toBe(false) // 7ef62a2e+R3: stayed live for the process life
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(false) // P released (identity watch stopped)
    expect(consumers.hasTransientProfileConsumer(q.id)).toBe(false) // the wait's hold released
    await settle(fetching)
    expect(ptys).toHaveLength(1) // nothing spawned
    expect(sent.filter(([ch]) => ch === 'pty:exit:rc15abandon')).toHaveLength(1) // and nothing torn down twice
  })

  it('positive control: with no refresh in flight the spawn is synchronous, exactly as before', () => {
    sids.push('rc15refreshnone')
    spawnPty(win, 'rc15refreshnone', { shellOnly: true, profileId, cwd: sandbox })
    expect(ptys).toHaveLength(1)
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(true)
  })

  it('positive control: a refresh of ANOTHER profile does not delay this spawn', async () => {
    const other = profiles.createProfile('Other')
    profiles.upsertProfile({ ...other, isPrimary: false, active: true, accountEmail: 'other@example.test' })
    const otherFile = path.join(profiles.getProfileConfigDir(other.id), '.claude', '.credentials.json')
    fs.mkdirSync(path.dirname(otherFile), { recursive: true })
    fs.writeFileSync(otherFile, JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1 } }))
    const fetching = fetchAccountUsage(other.id)
    for (let i = 0; i < 100 && !held.answer; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(consumers.pendingProfileRefresh(other.id)).not.toBeNull()
    sids.push('rc15refreshother')
    spawnPty(win, 'rc15refreshother', { shellOnly: true, profileId, cwd: sandbox })
    expect(ptys).toHaveLength(1)
    await settle(fetching)
  })
})

/** A second, idle profile whose refresh the tests below park at its POST. */
function makeIdleProfile(name: string): string {
  const q = profiles.createProfile(name)
  profiles.upsertProfile({ ...q, isPrimary: false, active: true, accountEmail: `${name.toLowerCase()}@example.test` })
  const qFile = path.join(profiles.getProfileConfigDir(q.id), '.claude', '.credentials.json')
  fs.mkdirSync(path.dirname(qFile), { recursive: true })
  fs.writeFileSync(qFile, JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1 } }))
  return q.id
}
/** An interactive session live on P, then switched onto the mid-refresh Q: the
 *  switch defers, and P's PTY exit arrives during the wait (suppressed as
 *  stale, its teardown handed to the wait). Returns Q's parked refresh. */
async function switchedOntoMidRefresh(sid: string, q: string): Promise<{ fetching: Promise<unknown> }> {
  spawnPty(win, sid, { shellOnly: false, profileId, cwd: sandbox })
  expect(isPtySessionLive(sid)).toBe(true)
  const old = ptys[0]
  const fetching = fetchAccountUsage(q)
  for (let i = 0; i < 100 && !held.answer; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(consumers.pendingProfileRefresh(q)).not.toBeNull()
  spawnPty(win, sid, { shellOnly: false, profileId: q, cwd: sandbox })
  expect(ptys).toHaveLength(1) // deferred
  old.exitCb?.({ exitCode: 0 })
  expect(sent.filter(([ch]) => ch === `pty:exit:${sid}`)).toHaveLength(0) // suppressed: handed to the wait
  return { fetching } // in an object: returning the parked promise itself would adopt it and deadlock
}
const exits = (sid: string) => sent.filter(([ch]) => ch === `pty:exit:${sid}`)

describe('quality round 3: a superseding spawn carries the handed-over teardown; a failed re-entry ends only a PTY-less session', () => {
  it('M1: a second spawn of the id while the first waits (Switch again) neither reports an exit nor wipes the canvas stamps pty:spawn just wrote; a kill of the NEW wait still ends the session exactly once', async () => {
    const q = makeIdleProfile('M1a')
    const { fetching } = await switchedOntoMidRefresh('rc16supersede', q)
    // pty:spawn stamps the canvas identity BEFORE spawnPty runs; the stamps of
    // the superseding spawn must survive its own prologue.
    canvasLink.noteSessionSpawnForCanvas('rc16supersede', { cwd: sandbox })
    spawnPty(win, 'rc16supersede', { shellOnly: false, profileId: q, cwd: sandbox }) // supersedes the first wait; Q still mid-refresh -> waits too
    expect(ptys).toHaveLength(1)
    expect(exits('rc16supersede')).toHaveLength(0) // f737d411: the prologue's killPty ran the handed-over teardown -> an exit reached the renderer...
    expect(canvasLink.canvasCwdForSession('rc16supersede')).toBe(sandbox) // ...and forgetSessionForCanvas wiped the stamps
    expect(consumers.profileConsumerCount(q)).toBe(1) // the first wait's hold went with it; the new wait holds
    // The teardown travelled with the wait: closing the card now ends the session once.
    killPty('rc16supersede')
    expect(exits('rc16supersede')).toHaveLength(1)
    expect(isPtySessionLive('rc16supersede')).toBe(false)
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(false) // P released
    expect(consumers.hasTransientProfileConsumer(q)).toBe(false)
    await settle(fetching)
    expect(ptys).toHaveLength(1) // nothing spawned from either wait
    expect(exits('rc16supersede')).toHaveLength(1) // and nothing torn down twice
  })

  it('M1: a second spawn of the id that lands at once (Switch back onto an idle profile) drops the carried teardown: the live PTY is the session, and only ITS exit is reported', async () => {
    const q = makeIdleProfile('M1b')
    const { fetching } = await switchedOntoMidRefresh('rc16landing', q)
    canvasLink.noteSessionSpawnForCanvas('rc16landing', { cwd: sandbox })
    spawnPty(win, 'rc16landing', { shellOnly: false, profileId, cwd: sandbox }) // back onto P: no refresh pending -> synchronous
    expect(ptys).toHaveLength(2)
    expect(exits('rc16landing')).toHaveLength(0)
    expect(canvasLink.canvasCwdForSession('rc16landing')).toBe(sandbox)
    expect(isPtySessionLive('rc16landing')).toBe(true)
    expect(identity.getWatchedProfileId('rc16landing')).toBe(profileId)
    expect(consumers.hasTransientProfileConsumer(q)).toBe(false) // the superseded wait's hold released
    await settle(fetching)
    expect(ptys).toHaveLength(2) // the cancelled wait spawned nothing
    expect(exits('rc16landing')).toHaveLength(0)
    ptys[1].exitCb?.({ exitCode: 0 })
    expect(exits('rc16landing')).toHaveLength(1) // the successor's own exit is the session's end
    expect(isPtySessionLive('rc16landing')).toBe(false)
  })

  it('M1: a superseding spawn that throws before it has a PTY (node-pty refuses) still ends the session once -- the carried teardown is not lost with the failed spawn', async () => {
    const q = makeIdleProfile('M1c')
    const { fetching } = await switchedOntoMidRefresh('rc16superfail', q)
    inject.spawnThrows = true
    expect(() => spawnPty(win, 'rc16superfail', { shellOnly: false, profileId, cwd: sandbox })).toThrow(/injected/) // back onto P: synchronous, and it fails
    expect(ptys).toHaveLength(1)
    expect(exits('rc16superfail')).toHaveLength(1) // 697d3448: dropped with the spawn -> the session never ended
    expect(isPtySessionLive('rc16superfail')).toBe(false)
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(false) // P's identity watch stopped
    expect(consumers.hasTransientProfileConsumer(q)).toBe(false) // the superseded wait's hold released
    await settle(fetching)
    expect(ptys).toHaveLength(1)
    expect(exits('rc16superfail')).toHaveLength(1)
  })

  it('M2 control: a re-entry that throws BEFORE registering a PTY ends the session once (no successor: exit reported, not live, both profiles released)', async () => {
    const q = makeIdleProfile('M2a')
    const { fetching } = await switchedOntoMidRefresh('rc16nopty', q)
    inject.spawnThrows = true
    await settle(fetching)
    expect(ptys).toHaveLength(1) // node-pty refused the re-entry
    expect(exits('rc16nopty')).toHaveLength(1)
    expect(isPtySessionLive('rc16nopty')).toBe(false)
    expect(isSessionWritable('rc16nopty')).toBe(false)
    expect(identity.isProfileInUseByLiveSession(profileId)).toBe(false)
    expect(consumers.hasTransientProfileConsumer(q)).toBe(false)
  })

  it('M2: a re-entry that throws AFTER registering its PTY leaves that PTY as the session (no exit reported, still writable, ended by killPty later) instead of tearing it down under itself', async () => {
    const q = makeIdleProfile('M2b')
    const { fetching } = await switchedOntoMidRefresh('rc16registered', q)
    sids.push('rc16registered')
    inject.registryThrows = true
    await settle(fetching)
    expect(ptys).toHaveLength(2) // the re-entry spawned and registered before it threw
    expect(exits('rc16registered')).toHaveLength(0) // f737d411: the catch ran the teardown -> exit reported, entry deleted under a live PTY
    expect(isSessionWritable('rc16registered')).toBe(true)
    expect(ptys[1].kill).not.toHaveBeenCalled()
    killPty('rc16registered')
    expect(ptys[1].kill).toHaveBeenCalled()
    expect(isSessionWritable('rc16registered')).toBe(false)
  })
})
