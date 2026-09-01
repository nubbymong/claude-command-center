/**
 * endSshRemote's DETACHED fallback, at the EXEC (SSH Persistent, Phase 3.5).
 *
 * The handler test (tests/unit/main/end-remote-detached-fallback.test.ts) proves
 * where the target comes from. This one drives the REAL endSshRemote and reads
 * the argv it hands ssh, to prove the two things that matter once a target
 * exists:
 *
 *   1. a fallback target actually produces the kill exec — the whole point,
 *      since before this a detached remote resolved 'no-target' and the tmux
 *      session survived;
 *   2. the tmux session to kill is DERIVED LOCALLY from the session id
 *      (`ccc-<safeSid(id)>`, buildRemoteTmuxKillCommand) and sanitised on the
 *      way, so no caller-supplied string can name someone else's tmux session
 *      or break out of the `-t` operand.
 *
 * And the precedence rule: a LIVE captured target still wins over the fallback.
 *
 * child_process/node-pty are mocked, so nothing is spawned and no host is dialled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ onData() {}, onExit() {}, write() {}, kill() {}, pid: 1 })) }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({ stopWatchdog: vi.fn(), noteRedrawTrigger: vi.fn() }),
}))

const execFile = vi.fn()
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (...a: unknown[]) => execFile(...a),
}))

const { endSshRemote, _setSshTargetForTest } = await import('../../src/main/pty-manager')

/** Resolve the exec immediately with a clean exit, like a host that answered. */
const execOk = () => execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => {
  cb(null)
  return { unref() {} }
})

const KEY_TARGET = { username: 'mong', host: 'pi.local', port: 2222 }
/** argv of the single exec that ran. */
const argv = () => execFile.mock.calls[0][1] as string[]
/** The remote command ssh was given — the LAST positional, after the destination. */
const remoteCommand = () => argv()[argv().length - 1]

beforeEach(() => {
  execFile.mockReset()
  execOk()
})

describe('endSshRemote — a fallback target reaches the host', () => {
  it('with NO captured target and NO fallback, it is a no-op (the bug this phase closes)', async () => {
    // Exactly what every detached entry used to hit: killPty dropped the
    // spawn-time target, so End dispatched nothing and the remote lived on.
    await expect(endSshRemote('detached1')).resolves.toBe('no-target')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('with a fallback target it DOES dispatch the kill, to the saved host and user', async () => {
    await expect(endSshRemote('detached2', KEY_TARGET)).resolves.toBe('completed')
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(argv()).toContain('mong@pi.local')
    expect(argv()).toContain('2222')
  })

  it('the tmux session it kills is ccc-<sessionId>, computed from the input', async () => {
    const sid = 'a1b2c3d4e5f6a1b2c3d4e5f6'
    await endSshRemote(sid, KEY_TARGET)
    expect(remoteCommand()).toContain(`kill-session -t =ccc-${sid}`)
    // ...and the sidecars for that same id, nothing wider.
    expect(remoteCommand()).toContain(`settings-${sid}.json`)
  })

  it('the tmux target is SANITISED, so no id can name another session or escape the -t operand', async () => {
    // Defence in depth: the IPC schema already rejects this charset, so this is
    // the second gate — a caller reaching endSshRemote directly still cannot
    // steer the kill. Mutation to prove it can fail: return the raw sessionId
    // instead of safeSid in buildRemoteTmuxKillCommand (ssh-shim.ts).
    await endSshRemote('a; tmux kill-server; #', KEY_TARGET)
    const cmd = remoteCommand()

    // Every `-t` operand is one inert token: the punctuation that would have
    // ended the command and started a new one is gone, so the hostile id
    // survives only as TEXT inside a session name that does not exist.
    const operands = [...cmd.matchAll(/kill-session -t (\S+)/g)].map((m) => m[1])
    expect(operands.length).toBeGreaterThan(0)
    for (const t of operands) {
      expect(t).toBe('=ccc-a__tmux_kill-server___')
      expect(t).toMatch(/^=ccc-[A-Za-z0-9_-]+$/)
    }
    // The injected command never becomes a command of its own.
    expect(cmd).not.toContain('; tmux kill-server')
    expect(cmd).not.toContain('ccc-a;')
  })

  // CHARSET IS NOT WIDTH (adversarial review, 2026-09-01). The case above proves
  // the operand carries no metacharacter; it says nothing about how many
  // sessions that operand names. `sessionIdSchema` (pty-handlers.ts) has a floor
  // of ONE character, so `ssh:endRemote` accepts `{ sessionId: 'a' }` — and tmux
  // resolves a bare `-t ccc-a` by exact match, then PREFIX, then fnmatch, so it
  // would end whichever other `ccc-…` session on the host starts with `a`.
  //
  // Mutation to prove this can fail: drop the leading `=` from `target` in
  // buildRemoteTmuxKillCommand (ssh-shim.ts).
  it('a one-character id (schema-valid) still names EXACTLY one session, never a prefix', async () => {
    await endSshRemote('a', KEY_TARGET)
    const cmd = remoteCommand()
    const operands = [...cmd.matchAll(/kill-session -t (\S+)/g)].map((m) => m[1])
    expect(operands.length).toBeGreaterThan(0)
    for (const t of operands) expect(t).toBe('=ccc-a')
    expect(cmd).not.toMatch(/kill-session -t ccc-a(\s|$)/)
  })

  it('a key/agent target runs the fail-fast BatchMode exec (no password prompt to answer)', async () => {
    await endSshRemote('detached3', KEY_TARGET)
    expect(argv().join(' ')).toContain('BatchMode=yes')
  })

  it('a password target does NOT use BatchMode — it answers the prompt under a PTY instead', async () => {
    const pty = await import('node-pty')
    // Never resolves here (no onExit driven); we only care which path was taken.
    void endSshRemote('detached4', { ...KEY_TARGET, password: 'pw' })
    expect(execFile).not.toHaveBeenCalled()
    expect(pty.spawn).toHaveBeenCalled()
    const args = (pty.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
    expect(args.join(' ')).not.toContain('BatchMode=yes')
    expect(args.join(' ')).toContain('NumberOfPasswordPrompts=1')
  })
})

describe('endSshRemote — a LIVE captured target outranks the fallback', () => {
  it('uses the spawn-time target, not the one the caller rebuilt from disk', async () => {
    // The live target carries the credentials the session actually authed with
    // and its real runtime — strictly better evidence than the config file,
    // which may have been edited since the session started.
    _setSshTargetForTest('live1', { username: 'live-user', host: 'live.host', port: 22 })
    await endSshRemote('live1', { username: 'stale', host: 'stale.host', port: 9999 })
    expect(argv()).toContain('live-user@live.host')
    expect(argv()).not.toContain('stale@stale.host')
  })
})
