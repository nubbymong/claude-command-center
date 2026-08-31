// #572: "End remote" on a password-auth host was a SILENT NO-OP — the kill
// exec ran with BatchMode=yes (key/agent only), failed fast, and the remote
// tmux+claude survived every End click, accumulating ~350MB orphans per
// "ended" session until the host ran out of memory (the mongminer incident,
// 2026-08-30). endSshRemote now answers exactly one real password prompt over
// a dedicated PTY for password targets, and stays the BatchMode exec for key
// targets. These tests pin both shapes and the prompt discipline: the match
// runs on the ESCAPE-STRIPPED last line, end-anchored (the RC9 ConPTY-glue
// lesson), so a MOTD that merely mentions passwords can never trigger the
// credential write.
//
// Mock stack copied from pty-session-liveness.test.ts (which drives the same
// module); node-pty and child_process are the controllable fakes under test.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface FakePty {
  args: string[]
  writes: string[]
  killed: boolean
  data: ((d: string) => void) | null
  exit: ((e: { exitCode: number }) => void) | null
}

const h = vi.hoisted(() => ({
  ptySpawns: [] as Array<{
    args: string[]
    writes: string[]
    killed: boolean
    data: ((d: string) => void) | null
    exit: ((e: { exitCode: number }) => void) | null
  }>,
  execFiles: [] as Array<{ bin: string; args: string[] }>,
  execFileError: null as Error | null,
  // Every log line the module emits, flattened — the "never logged" thesis is
  // asserted against this (adversarial pass: it was claimed and unasserted).
  logs: [] as string[],
}))

vi.mock('node-pty', () => ({
  spawn: (_bin: string, args: string[]) => {
    const rec = { args, writes: [] as string[], killed: false, data: null as ((d: string) => void) | null, exit: null as ((e: { exitCode: number }) => void) | null }
    h.ptySpawns.push(rec)
    return {
      pid: 999,
      process: 'ssh',
      onData: (cb: (d: string) => void) => { rec.data = cb; return { dispose: () => {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { rec.exit = cb; return { dispose: () => {} } },
      write: (d: string) => { rec.writes.push(d) },
      resize: () => {},
      kill: () => { rec.killed = true },
    }
  },
}))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: () => '',
  execFile: (bin: string, args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
    h.execFiles.push({ bin, args })
    queueMicrotask(() => cb?.(h.execFileError, '', ''))
    return { unref: () => {} }
  },
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-end-remote-'))
  return {
    getResourcesDirectory: () => dir,
    getDataDirectory: () => dir,
    registerSetupHandlers: () => {},
    writeCliSetupPty: () => {},
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))

vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  const capture = (...args: unknown[]) => { h.logs.push(args.map(String).join(' ')) }
  return { ...real, logDebug: capture, logTrace: capture, logInfo: capture, logWarn: capture, logError: capture }
})
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => null,
  getTranscriptBinder: () => null,
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  registerCodexReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({
  resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }),
  resolveHostColorScheme: () => 'dark',
}))
vi.mock('../../../src/main/vision-manager', () => ({
  isGlobalVisionRunning: () => false,
  getGlobalVisionConfig: () => null,
  teardownVisionSession: () => {},
}))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null,
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null,
  removeLocalSessionMcpConfig: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {},
  clearClaudeAccount: () => {},
  getAccountIdentity: () => null,
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  stopWatchingAccountIdentity: () => {},
  getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
}))

const { endSshRemote, _setSshTargetForTest } = await import('../../../src/main/pty-manager')

const lastPty = (): FakePty => h.ptySpawns[h.ptySpawns.length - 1]

beforeEach(() => {
  h.ptySpawns.length = 0
  h.execFiles.length = 0
  h.execFileError = null
  h.logs.length = 0
})

describe('endSshRemote (#572)', () => {
  it('resolves no-target for a session with no SSH target', async () => {
    await expect(endSshRemote('never-spawned')).resolves.toBe('no-target')
    expect(h.ptySpawns).toHaveLength(0)
    expect(h.execFiles).toHaveLength(0)
  })

  it('key target: keeps the BatchMode exec and resolves completed', async () => {
    _setSshTargetForTest('sid-key', { username: 'u', host: 'h1', port: 22 })
    await expect(endSshRemote('sid-key')).resolves.toBe('completed')
    expect(h.ptySpawns).toHaveLength(0)
    expect(h.execFiles).toHaveLength(1)
    const args = h.execFiles[0].args
    expect(args).toContain('BatchMode=yes')
    expect(args.join(' ')).toContain('kill-session -t ccc-sid-key')
  })

  it('password target: runs under a PTY without BatchMode, answers ONE glued prompt, resolves completed', async () => {
    _setSshTargetForTest('sid-pw', { username: 'pi', host: 'h2', port: 22, password: 's3cret' })
    const p = endSshRemote('sid-pw')
    expect(h.execFiles).toHaveLength(0)
    const fake = lastPty()
    expect(fake.args).not.toContain('BatchMode=yes')
    expect(fake.args).toContain('NumberOfPasswordPrompts=1')
    // The password must never ride in argv.
    expect(fake.args.join(' ')).not.toContain('s3cret')
    // A MOTD that mentions passwords must NOT trigger the write (end-anchor rule).
    fake.data!("Your password expires in 30 days\r\n")
    expect(fake.writes).toHaveLength(0)
    // The real prompt, with ConPTY-glued escapes around it (the RC9 shape).
    fake.data!("\x1b[?25lpi@h2's password: ")
    expect(fake.writes).toEqual(['s3cret\r'])
    // More output must not retype the password.
    fake.data!('\r\n')
    expect(fake.writes).toHaveLength(1)
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('password target: a prompt split across chunks still matches exactly once', async () => {
    _setSshTargetForTest('sid-split', { username: 'pi', host: 'h3', port: 22, password: 'pw2' })
    const p = endSshRemote('sid-split')
    const fake = lastPty()
    fake.data!("pi@h3's pass")
    expect(fake.writes).toHaveLength(0)
    fake.data!('word: ')
    expect(fake.writes).toEqual(['pw2\r'])
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('password target: nonzero exit resolves failed', async () => {
    _setSshTargetForTest('sid-fail', { username: 'pi', host: 'h4', port: 22, password: 'x' })
    const p = endSshRemote('sid-fail')
    lastPty().exit!({ exitCode: 255 })
    await expect(p).resolves.toBe('failed')
  })

  it('password target: no prompt ever -> times out failed and kills the child', async () => {
    vi.useFakeTimers()
    try {
      _setSshTargetForTest('sid-hang', { username: 'pi', host: 'h5', port: 22, password: 'x' })
      const p = endSshRemote('sid-hang')
      const fake = lastPty()
      await vi.advanceTimersByTimeAsync(20_001)
      await expect(p).resolves.toBe('failed')
      expect(fake.killed).toBe(true)
      expect(fake.writes).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Adversarial-pass hardenings (2026-08-30) ──────────────────────────────

  it('a prompt arriving AFTER the timeout settled never writes into the dead PTY', async () => {
    vi.useFakeTimers()
    try {
      _setSshTargetForTest('sid-late', { username: 'pi', host: 'h6', port: 22, password: 'late-pw' })
      const p = endSshRemote('sid-late')
      const fake = lastPty()
      await vi.advanceTimersByTimeAsync(20_001)
      await expect(p).resolves.toBe('failed')
      // The killed child flushes one last ConPTY chunk ending in a prompt.
      fake.data!("pi@h6's password: ")
      expect(fake.writes).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('CR/LF in a saved password cannot become extra PTY lines', async () => {
    _setSshTargetForTest('sid-crlf', { username: 'pi', host: 'h7', port: 22, password: 'pw\r\nrm -rf x' })
    const p = endSshRemote('sid-crlf')
    const fake = lastPty()
    fake.data!("pi@h7's password: ")
    expect(fake.writes).toEqual(['pwrm -rf x\r'])
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('the RC9 trailing-glue shape (escapes AFTER the prompt, one unterminated) still matches once', async () => {
    _setSshTargetForTest('sid-trail', { username: 'pi', host: 'h8', port: 22, password: 'pw8' })
    const p = endSshRemote('sid-trail')
    const fake = lastPty()
    fake.data!("pi@h8's password: \x1b[?25h\x1b[")
    expect(fake.writes).toEqual(['pw8\r'])
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('key target: an exec error resolves failed (not completed, not a hang)', async () => {
    h.execFileError = new Error('ssh: connect refused')
    _setSshTargetForTest('sid-keyfail', { username: 'u', host: 'h9', port: 22 })
    await expect(endSshRemote('sid-keyfail')).resolves.toBe('failed')
  })

  it('the password appears in NO log line, on success or on failure', async () => {
    _setSshTargetForTest('sid-log1', { username: 'pi', host: 'hA', port: 22, password: 'hunter2secret' })
    const ok = endSshRemote('sid-log1')
    const fake = lastPty()
    fake.data!("pi@hA's password: ")
    fake.exit!({ exitCode: 0 })
    await ok
    _setSshTargetForTest('sid-log2', { username: 'pi', host: 'hB', port: 22, password: 'hunter2secret' })
    const bad = endSshRemote('sid-log2')
    lastPty().exit!({ exitCode: 255 })
    await bad
    expect(h.logs.length).toBeGreaterThan(0)
    for (const line of h.logs) expect(line).not.toContain('hunter2secret')
  })
})

// ── #572, ONE HOP DEEPER: the in-container orphan ───────────────────────────
//
// A session whose runtime is a container runs claude INSIDE
// `<engine> exec -it <name> bash`. End killed the host tmux session, which
// dropped the exec CLIENT — and claude kept running in the container forever.
// Live-proven 2026-08-31 (T20, ssh-statusline-docker.live.ts): three claude
// processes still alive in `ccc-test` after End.
describe('endSshRemote — container runtime (#572 one hop deeper)', () => {
  const CONTAINER = { type: 'container', engine: 'podman', container: 'ccc-test' } as const

  it('key host + rootless container: BatchMode exec, container kill BEFORE the tmux kill', async () => {
    _setSshTargetForTest('sid-ctr-key', { username: 'u', host: 'hK', port: 22, runtime: CONTAINER })
    await expect(endSshRemote('sid-ctr-key')).resolves.toBe('completed')
    // No prompt to answer -> the original fire-fast BatchMode path.
    expect(h.ptySpawns).toHaveLength(0)
    expect(h.execFiles).toHaveLength(1)
    const remote = h.execFiles[0].args[h.execFiles[0].args.length - 1]
    expect(remote).toContain("podman exec ccc-test bash -c '")
    expect(remote).toContain('pkill -f settings-sid-ctr-key')
    expect(remote).toContain('kill-session -t ccc-sid-ctr-key')
    // ORDERING IS LOAD-BEARING: the tmux teardown drops the exec client the
    // container kill travels through, so the in-container claude must die
    // first or the kill never lands (and T20's measurement races).
    expect(remote.indexOf('podman exec')).toBeLessThan(remote.indexOf('kill-session'))
  })

  it('a host runtime still sends the tmux kill ALONE (no engine exec appears)', async () => {
    _setSshTargetForTest('sid-host-rt', { username: 'u', host: 'hH', port: 22, runtime: { type: 'host' } })
    await expect(endSshRemote('sid-host-rt')).resolves.toBe('completed')
    const remote = h.execFiles[0].args[h.execFiles[0].args.length - 1]
    expect(remote).toContain('kill-session -t ccc-sid-host-rt')
    expect(remote).not.toContain('exec ')
    expect(remote).not.toContain('pkill')
  })

  it('key host + ROOTFUL container with a saved sudo password: switches to the PTY variant and answers ONE (sudo) prompt', async () => {
    _setSshTargetForTest('sid-ctr-sudo-key', {
      username: 'u', host: 'hS', port: 22,
      runtime: { ...CONTAINER, sudo: true }, sudoPassword: 'sudo-secret',
    })
    const p = endSshRemote('sid-ctr-sudo-key')
    // A key host would normally take the BatchMode path — the sudo prompt is
    // what forces a PTY here.
    expect(h.execFiles).toHaveLength(0)
    const fake = lastPty()
    expect(fake.args).not.toContain('BatchMode=yes')
    expect(fake.args.join(' ')).toContain('sudo -S -p password: podman exec ccc-test')
    // Neither secret ever rides in argv.
    expect(fake.args.join(' ')).not.toContain('sudo-secret')
    // The host has no ssh password, so the FIRST prompt is sudo's.
    fake.data!('password:')
    expect(fake.writes).toEqual(['sudo-secret\r'])
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('key host + rootful container with NO saved sudo password: stays on BatchMode with `sudo -n` (never hangs on a prompt)', async () => {
    _setSshTargetForTest('sid-ctr-sudo-nopw', { username: 'u', host: 'hN', port: 22, runtime: { ...CONTAINER, sudo: true } })
    await expect(endSshRemote('sid-ctr-sudo-nopw')).resolves.toBe('completed')
    expect(h.ptySpawns).toHaveLength(0)
    const remote = h.execFiles[0].args[h.execFiles[0].args.length - 1]
    expect(remote).toContain('sudo -n podman exec ccc-test')
    expect(remote).not.toContain('-S')
    // The tmux kill still runs — a blocked sudo prompt would have starved it.
    expect(remote).toContain('kill-session -t ccc-sid-ctr-sudo-nopw')
  })

  // THE T21 SHAPE: password host + rootful container = two prompts, in order.
  it('password host + rootful container: answers ssh THEN sudo, each with its own secret', async () => {
    _setSshTargetForTest('sid-ctr-two', {
      username: 'nm', host: 'hT', port: 22, password: 'ssh-pw',
      runtime: { ...CONTAINER, sudo: true }, sudoPassword: 'sudo-pw',
    })
    const p = endSshRemote('sid-ctr-two')
    const fake = lastPty()
    // 1) ssh's own prompt, in the RC9 ConPTY-glued shape.
    fake.data!("\x1b[?25lnm@hT's password: ")
    expect(fake.writes).toEqual(['ssh-pw\r'])
    // ssh answers its prompt with a bare newline. Before the tail was consumed
    // on answering, THIS chunk still ended on the already-answered prompt line
    // and burned the sudo password into ssh's prompt.
    fake.data!('\r\n')
    expect(fake.writes).toEqual(['ssh-pw\r'])
    // 2) sudo's forced prompt, arriving as its own chunk (no trailing newline —
    //    measured byte-for-byte on the real host).
    fake.data!('password:')
    expect(fake.writes).toEqual(['ssh-pw\r', 'sudo-pw\r'])
    // 3) A THIRD prompt-shaped line must extract nothing: the secret list is
    //    exhausted, so the answer count is bounded by the prompts we expect.
    fake.data!('\r\nsomething password: ')
    expect(fake.writes).toHaveLength(2)
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('password host + ROOTLESS container: still exactly ONE prompt, and no sudo in the remote command', async () => {
    _setSshTargetForTest('sid-ctr-pw-rootless', { username: 'nm', host: 'hR', port: 22, password: 'ssh-pw', runtime: CONTAINER })
    const p = endSshRemote('sid-ctr-pw-rootless')
    const fake = lastPty()
    expect(fake.args.join(' ')).not.toContain('sudo')
    fake.data!("nm@hR's password: ")
    expect(fake.writes).toEqual(['ssh-pw\r'])
    // No sudo prompt can follow, so a later prompt-shaped line writes nothing.
    fake.data!('\r\npassword:')
    expect(fake.writes).toHaveLength(1)
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('an invalid stored container name yields NO engine exec, and the tmux kill still runs', async () => {
    _setSshTargetForTest('sid-ctr-bad', { username: 'u', host: 'hB', port: 22, runtime: { type: 'container', engine: 'podman', container: 'ccc test; rm -rf /' } })
    await expect(endSshRemote('sid-ctr-bad')).resolves.toBe('completed')
    const remote = h.execFiles[0].args[h.execFiles[0].args.length - 1]
    expect(remote).not.toContain('podman')
    expect(remote).not.toContain('rm -rf /')
    expect(remote).toContain('kill-session -t ccc-sid-ctr-bad')
  })

  it('neither the sudo password nor the ssh password reaches a log line', async () => {
    _setSshTargetForTest('sid-ctr-log', {
      username: 'nm', host: 'hL', port: 22, password: 'sshhunter2',
      runtime: { ...CONTAINER, sudo: true }, sudoPassword: 'sudohunter2',
    })
    const p = endSshRemote('sid-ctr-log')
    const fake = lastPty()
    fake.data!("nm@hL's password: ")
    fake.data!('\r\n')
    fake.data!('password:')
    fake.exit!({ exitCode: 0 })
    await p
    expect(h.logs.length).toBeGreaterThan(0)
    for (const line of h.logs) {
      expect(line).not.toContain('sshhunter2')
      expect(line).not.toContain('sudohunter2')
    }
  })
})
