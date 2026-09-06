// ADR-009 round 3 (Codex PR600 findings 1 + 2): R1 container-entry LIFETIME.
// A valid nonce proves entry at a moment, not permanent attachment. Definitive
// exit/host-back evidence in the deferred-write window must prevent the write,
// and a genuine current-attempt IN must permanently close the host-sudo gate
// even when the same chunk fails the entry. Real SSH state machine, inert PTY,
// synthetic secrets. These are DESIRED-SAFETY assertions: RED before the fix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('os', async (original) => ({ ...(await original<typeof import('os')>()), platform: () => 'linux' }))
const listeners: Array<(data: string) => void> = []
const write = vi.fn()
vi.mock('node-pty', () => ({ spawn: () => ({
  onData: (fn: (data: string) => void) => listeners.push(fn),
  onExit: vi.fn(), write, kill: vi.fn(), pid: 60420,
}) }))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
}))
const { spawnPty, getSshFlow, killPty, _getSshEntryNonceForTest, _getSshNonceForTest } = await import('../../src/main/pty-manager')
const { entrySentinel, buildEntryGuardCommand } = await import('../../src/shared/container-command')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const win = { webContents: { send: vi.fn() }, isDestroyed: () => false } as never
const ids: string[] = []
const HOST = 'user@host:~$ '
const INNER = 'root@container:/# '
const GUARD = buildEntryGuardCommand() + '\r'
const feed = (text: string) => listeners.forEach((fn) => fn(text))
const writes = () => write.mock.calls.map(([text]) => String(text))
const mark = (id: string, word: 'IN' | 'OUT' | 'HERE') => entrySentinel(_getSshEntryNonceForTest(id)!, word) + '\r\n'

function enter(id: string, secret?: string) {
  ids.push(id)
  spawnPty(win, id, { ssh: {
    username: 'synthetic', host: 'invalid.example', port: 22, remotePath: '~', sudoPassword: secret,
    runtime: { type: 'container', engine: 'docker', container: 'synthetic', sudo: !!secret },
  } } as never)
  feed(HOST)
  expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
  getSshFlow(id)!.runPostCommand()
  vi.advanceTimersByTime(201)
  expect(writes().some((text) => text.includes('docker exec'))).toBe(true)
  write.mockClear()
}
function firstGuard(id: string) {
  enter(id)
  feed(mark(id, 'IN') + INNER)
  getSshFlow(id)!.launchClaude()
  expect(writes()).toEqual([GUARD])
  write.mockClear()
}
function secondGuard(id: string) {
  firstGuard(id)
  feed(mark(id, 'HERE'))
  vi.advanceTimersByTime(301)
  expect(writes().some((text) => text.includes('base64 -d | node'))).toBe(true)
  write.mockClear()
  feed(`setup ok ${_getSshNonceForTest(id)} tmux=none\r\n${INNER}`)
  vi.advanceTimersByTime(1600)
  expect(writes()).toEqual([GUARD])
  write.mockClear()
}

beforeEach(() => { vi.useFakeTimers(); listeners.length = 0; write.mockReset() })
afterEach(() => { for (const id of ids.splice(0)) killPty(id); vi.clearAllTimers(); vi.useRealTimers() })

describe('PR600 R1 lifetime (Codex findings 1+2)', () => {
  it('control: a clean entry and both HERE responses launch once', () => {
    const id = 'r1-control'
    secondGuard(id)
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(201)
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toContain('claude --settings')
  })
  it('finding 1a: a real OUT after the second HERE but before the scheduled write prevents the launch', () => {
    const id = 'r1-out-after-here'
    secondGuard(id)
    const out = mark(id, 'OUT')
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(20)
    feed(out + HOST)
    vi.advanceTimersByTime(181)
    expect(writes(), 'the known-returned host must receive no Claude command').toEqual([])
  })
  it('finding 1b: a host-back detach between the first HERE and the deferred setup write prevents the setup payload', () => {
    const id = 'r1-detach-after-here'
    firstGuard(id)
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(20)
    feed('\r\n' + HOST)
    vi.advanceTimersByTime(281)
    expect(writes(), 'the returned host must receive no setup payload').toEqual([])
  })
  it('finding 2a: an IN in the same chunk as a container engine diagnostic still permanently closes the host-sudo gate', () => {
    const id = 'r1-in-plus-error'
    enter(id, 'SYNTHETIC_HOST_SUDO_SECRET')
    feed(mark(id, 'IN') + 'Cannot connect to the Docker daemon\r\n')
    feed('[sudo] password for root: ')
    vi.advanceTimersByTime(101)
    expect(writes(), 'proof of container entry must permanently close the host-secret gate').toEqual([])
  })
  it('finding 2a (isolated): the IN latch refuses the host secret across a Run again, when runtimeEntryFailed has been reset', () => {
    // The same-chunk case above is also caught by the 2b write-time re-check
    // (runtimeEntryFailed is set by failEntry). This case isolates the PERMANENT
    // IN latch: a Run again resets runtimeEntryFailed and sudoPasswordSent, so
    // only containerEverEntered can still refuse the host secret.
    const id = 'r1-in-error-runagain'
    enter(id, 'SYNTHETIC_HOST_SUDO_SECRET')
    feed(mark(id, 'IN') + 'Cannot connect to the Docker daemon\r\n')
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    getSshFlow(id)!.runPostCommand() // Run again: re-types the exec, resets runtimeEntryFailed + sudoPasswordSent
    vi.advanceTimersByTime(201)
    write.mockClear()
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(writes(), 'a session that reached the container never auto-types the host secret again').toEqual([])
  })
  it('finding 2b: an IN arriving before the delayed sudo write cancels that write', () => {
    const id = 'r1-sudo-timer'
    enter(id, 'SYNTHETIC_HOST_SUDO_SECRET')
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(20)
    feed(mark(id, 'IN') + INNER)
    vi.advanceTimersByTime(81)
    expect(writes(), 'a previously scheduled host secret must not enter the proven container').toEqual([])
  })
})

// ADR-009 round 3, R1 re-attack MINOR: the deferred setup (300 ms) and claude
// (200 ms) writes were anonymous timers. failEntry did not clear them, so a Run
// again inside the failed attempt's window let the STALE timer fire into the
// next attempt: its callback cleared deferredEntryWritePending under the next
// attempt's own pending write (disarming the host-back check for the rest of
// that window), wrote the payload a second time, or -- for the claude timer,
// once Run again had reset runtimeEntryFailed -- typed the Claude command onto
// the host shell before the new exec was even typed. failEntry also never
// un-latched claudeSent, so after an OUT in the deferred-claude window the next
// attempt could not launch Claude at all. RED before the fix.
function runAgainToSecondProof(id: string) {
  getSshFlow(id)!.runPostCommand()
  vi.advanceTimersByTime(201)
  expect(writes().some((text) => text.includes('docker exec'))).toBe(true)
  write.mockClear()
  feed(mark(id, 'IN') + INNER)
  getSshFlow(id)!.launchClaude()
  expect(writes()).toEqual([GUARD])
  write.mockClear()
}

describe('PR600 R1 round-3 MINOR: a failed attempt leaves no deferred write behind', () => {
  it('setup timer: a Run again inside the failed attempt\'s window keeps the host-back check armed for the new attempt', () => {
    const id = 'r1-stale-setup-disarm'
    firstGuard(id)
    feed(mark(id, 'HERE')) // attempt 1: setup write scheduled (+300)
    vi.advanceTimersByTime(20)
    feed('\r\n' + HOST) // host-back detach -> failEntry at +20
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    runAgainToSecondProof(id) // exec re-typed at +221, attempt 2 proven
    feed(mark(id, 'HERE')) // attempt 2: setup write scheduled (+521)
    vi.advanceTimersByTime(100) // +321: attempt 1's stale timer would have fired at +300
    feed('\r\n' + HOST) // host-back detach inside attempt 2's window
    vi.advanceTimersByTime(300) // +621: past attempt 2's own write time
    expect(writes(), 'the returned host must receive no setup payload').toEqual([])
    expect(getSshFlow(id)?.getState().state, 'the detach must fail the entry').toBe('failed')
  })
  it('setup timer: the re-entry writes its setup payload exactly once', () => {
    const id = 'r1-stale-setup-duplicate'
    firstGuard(id)
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(20)
    feed('\r\n' + HOST)
    runAgainToSecondProof(id)
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(301)
    expect(writes().filter((text) => text.includes('base64 -d | node')), 'one attempt, one setup payload').toHaveLength(1)
  })
  it('claude timer: a Run again inside the failed attempt\'s window never types the Claude command onto the host', () => {
    const id = 'r1-stale-claude-timer'
    secondGuard(id)
    const out = mark(id, 'OUT')
    feed(mark(id, 'HERE')) // attempt 1: claude write scheduled (+200)
    vi.advanceTimersByTime(20)
    feed(out + HOST) // real OUT -> failEntry at +20; the PTY is on the host shell
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    getSshFlow(id)!.runPostCommand() // Run again at +20 resets runtimeEntryFailed; the exec is typed at +220
    vi.advanceTimersByTime(181) // +201: the stale claude timer has fired, the exec has not yet been typed
    expect(writes().filter((text) => text.includes('claude --settings')), 'no Claude command may reach the host shell').toEqual([])
  })
  it('claude timer: after an OUT in the deferred-claude window, the next attempt can still launch Claude', () => {
    const id = 'r1-runagain-relaunch'
    secondGuard(id)
    const out = mark(id, 'OUT')
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(20)
    feed(out + HOST)
    vi.advanceTimersByTime(200) // let the failed attempt's window pass before Run again
    write.mockClear()
    runAgainToSecondProof(id)
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(301)
    expect(writes().some((text) => text.includes('base64 -d | node'))).toBe(true)
    write.mockClear()
    feed(`setup ok ${_getSshNonceForTest(id)} tmux=none\r\n${INNER}`)
    vi.advanceTimersByTime(1600)
    expect(writes()).toEqual([GUARD])
    write.mockClear()
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(201)
    expect(writes().filter((text) => text.includes('claude --settings')), 'the second attempt must be able to launch').toHaveLength(1)
  })
  it('destroy clears a pending deferred entry write (no ladder timer survives teardown)', () => {
    const id = 'r1-destroy-clears-deferred'
    firstGuard(id)
    feed(mark(id, 'HERE')) // setup write pending
    getSshFlow(id)!.destroy() // the flow's own teardown; killPty's process-level teardown is outside this ladder
    // Deliberately process-global: destroy must leave NO fake timer behind (an
    // inert-but-armed timer would pass a write-based check, since the callback
    // is destroyed-gated). An unrelated timer armed during spawnPty would fail
    // this too -- extend destroy or scope the count if that ever happens.
    expect(vi.getTimerCount(), 'a torn-down flow must own no timer').toBe(0)
  })
  // Independent review of the fix: skip() -- "Manage manually, no auto writes"
  // -- was the one flow method that still left a scheduled write armed. An
  // unverified "Launch anyway" schedules the setup synchronously and the Skip
  // button is live meanwhile, so a Skip can land inside the 200/300 ms window.
  it('skip inside the deferred-setup window withdraws the payload and leaves no setup timeout behind', () => {
    const id = 'r1-skip-withdraws-setup'
    firstGuard(id)
    feed(mark(id, 'HERE')) // setup write scheduled (+300), setup timeout armed (10 s)
    vi.advanceTimersByTime(20)
    getSshFlow(id)!.skip()
    vi.advanceTimersByTime(300)
    expect(writes(), 'a shell the user took over receives no auto write').toEqual([])
    vi.advanceTimersByTime(10_001)
    expect(getSshFlow(id)?.getState().state, 'no setup timeout may fail a payload that was never sent').toBe('skipped')
  })
  it('skip inside the deferred-claude window withdraws the command, and Launch is live again rather than inert', () => {
    const id = 'r1-skip-withdraws-claude'
    secondGuard(id)
    feed(mark(id, 'HERE')) // claude write scheduled (+200)
    vi.advanceTimersByTime(20)
    getSshFlow(id)!.skip()
    vi.advanceTimersByTime(200)
    expect(writes(), 'a shell the user took over receives no auto write').toEqual([])
    getSshFlow(id)!.launchClaude() // a later Launch re-proves the shell instead of returning on claudeSent
    expect(writes(), 'Launch after the withdrawn command must go out again (the guard), not sit on claudeSent').toEqual([GUARD])
    write.mockClear()
    feed(mark(id, 'HERE'))
    vi.advanceTimersByTime(201)
    // Attacker round 5: the guard alone is not enough -- with the setup already
    // done, the relaunch must reach the claude step, not strand behind the guard
    // on writeContainerSetupCmd's latch.
    expect(writes().filter((text) => text.includes('claude --settings')), 'the relaunch must reach the claude command').toHaveLength(1)
  })
})
