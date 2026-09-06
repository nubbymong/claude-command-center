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
