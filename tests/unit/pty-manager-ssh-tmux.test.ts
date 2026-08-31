// tests/unit/pty-manager-ssh-tmux.test.ts
//
// #242 call-site guard, modeled on pty-manager-ssh-argv.test.ts. That file
// asserts the SSH connection argv reaches buildSshConnectionArgs; this
// asserts writeClaudeCmd actually WRAPS the claude launch in tmux once
// detection reports a binary, and leaves it bare when it doesn't. Without
// this, reverting writeClaudeCmd to always write the bare claudeCmd (or
// reverting the sentinel parse) leaves the rest of the suite green.
//
// #242 finding F1 (adversarial review round 5, BLOCKER): every sentinel this
// file feeds now REQUIRES the real per-session nonce spawnPty generates
// (`_getSshNonceForTest`) -- see `nonceSentinel` below. Tests that
// deliberately probe the spoofing attack (a sentinel with NO nonce, or the
// WRONG one) feed the literal text directly instead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'linux',
}))

// Collects EVERY onData listener pty-manager registers, not just the last
// one -- node-pty's real onData supports multiple independent listeners
// (pty-manager itself registers a second one for debug-capture, further
// down in spawnPty), so a mock that stores only the latest silently feeds
// synthetic PTY output to the WRONG handler. Feeding a chunk below dispatches
// to all of them, matching real node-pty semantics.
const onDataListeners: Array<(data: string) => void> = []
function feedPtyData(chunk: string): void {
  for (const cb of onDataListeners) cb(chunk)
}
// #242 round-3 MAJOR fix: the staging write is now base64-wrapped (see
// buildTmuxStageCommand in ssh-tmux-stage.ts), so it no longer contains the
// literal 'ccc-tmux-stage' substring the round-2 tests matched on -- that
// substring only ever exists in the DECODED script and in the remote's
// eventual sentinel *reply* (fed back via feedPtyData, simulating real PTY
// output), never in the outgoing write itself. Detect the outgoing staging
// write by its fixed wrapper shape instead: it pipes through `base64 -d |
// sh`, while the host/container setup write (also base64-wrapped) pipes
// through `base64 -d | node` -- the interpreter name distinguishes them.
function isStagingWrite(arg: unknown): boolean {
  return typeof arg === 'string' && arg.includes('base64 -d | sh')
}

// #242 tier-4 test helpers. The push transfer is driven through
// runChunkedWrite at WRITE_CHUNK_SIZE(256B), so any single ptyProcess.write()
// call during a push is an arbitrary 256-char SLICE of the whole multi-line
// command -- a marker string (e.g. 'PUSH_ACCUMULATOR_PATH') can land split
// across two consecutive calls. Concatenating every write this session has
// made so far and searching THAT is the only reliable way to detect push
// activity; a per-call `.some()` check (fine for tier 3's single big write)
// would silently miss split markers here.
function allWrittenSoFar(): string {
  return writeMock.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '')).join('')
}
function pushActivityDetected(): boolean {
  return allWrittenSoFar().includes('PUSH_ACCUMULATOR_PATH')
}
/** Yield control so a resolved-but-not-yet-run `.then()` callback (the
 *  tier-4 archive resolver's promise) gets a chance to execute before the
 *  test keeps going. Promise microtasks are not controlled by vi's fake
 *  timers, so this needs a real await, not a timer advance. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * #242 finding F2 regression helper. Simulates the one piece of remote TTY
 * canonical-mode line-discipline behaviour this test needs: a Ctrl-C
 * (`\x03`) discards the current, not-yet-terminated input line -- everything
 * typed since the last `\r`/`\n` -- the same way a real terminal driver
 * flushes pending input on SIGINT. Used ONLY to verify the fix: sending
 * `\x03` before the recovery text must discard the dangling single-quote an
 * aborted `echo '<base64...` chunk write left open, so the recovery command
 * (and the eventual claude launch) land as real shell text instead of
 * literal string content inside that still-open quote.
 */
function applyLineDiscipline(text: string): string {
  let buf = ''
  for (const ch of text) {
    if (ch === '\x03') {
      const lastBreak = Math.max(buf.lastIndexOf('\r'), buf.lastIndexOf('\n'))
      buf = buf.slice(0, lastBreak + 1)
    } else {
      buf += ch
    }
  }
  return buf
}

const writeMock = vi.fn()
// Every pty node-pty.spawn hands back, in spawn order, so a test can fire a
// SPECIFIC pty's exit (needed for the restart-race regression: the OLD pty must
// be able to exit AFTER a new one took over the same sessionId). The real mock
// used to discard the onExit callback (`onExit: () => {}`), which is exactly why
// handlePtyExit + the restart-race guard were untestable (adversarial review,
// 2026-08-18). Each instance's __fireExit runs every onExit listener registered
// on it (spawnPty's, and gracefulExitPty's own).
interface FakePty {
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number }) => void) => void
  write: typeof writeMock
  kill: () => void
  pid: number
  __fireExit: (exitCode?: number) => void
}
const ptyInstances: FakePty[] = []
const spawnMock = vi.fn(() => {
  const exits: Array<(e: { exitCode: number }) => void> = []
  const inst: FakePty = {
    onData: (cb: (data: string) => void) => { onDataListeners.push(cb) },
    onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb) },
    write: writeMock,
    kill: () => {},
    pid: 123,
    __fireExit: (exitCode = 0) => { for (const cb of exits.slice()) cb({ exitCode }) },
  }
  ptyInstances.push(inst)
  return inst
})
vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))

const { spawnPty, getSshFlow, killPty, gracefulExitPty, parseTmuxSentinel, parseSetupAccountSentinel, parseTmuxStageSentinel, _setTmuxArchiveResolverForTest, _getSshNonceForTest, _getSetupLineBufferLenForTest, _hasSshTargetForTest, _getSshTargetForTest } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
// Pure module, no node-pty/electron deps -- safe to import directly (unlike
// pty-manager, this one is not mocked/stubbed above).
const { buildTmuxStageCommand, TMUX_STAGE_SHA256 } = await import('../../src/main/ssh-tmux-stage')
// #242 round-3 correction (I3): the two fixed literal tokens
// buildTmuxLaunchCommand picks between -- tests assert against THESE
// constants rather than hardcoding the literal strings, so a future change
// to either token doesn't silently desync the test expectations from the
// real value.
const { ON_PATH_TMUX_BIN_EXPR, STAGED_TMUX_BIN_EXPR } = await import('../../src/main/ssh-tmux')
// The End container-kill builder, so the derived-runtime capture can be proven
// to actually produce a kill command (ADR-009 legacy-docker gating).
const { buildContainerKillCommand } = await import('../../src/main/providers/claude/ssh-shim')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }

/**
 * #242 finding F1 (b): substitute the literal placeholder "{NONCE}" in a
 * sentinel TEMPLATE with the REAL per-session nonce spawnPty generated for
 * `sessionId` (read via the test-only `_getSshNonceForTest` accessor) -- so
 * these tests drive the REAL flow with a genuinely nonce-carrying sentinel,
 * exactly the shape the real setup/stage/push scripts produce, rather than
 * a value this suite invents. Throws loudly if called before spawnPty has
 * registered a nonce for this session, instead of silently feeding
 * "{NONCE}" through unreplaced (which would just as silently fail to match
 * any parser and mask a real bug in the test itself).
 */
function nonceSentinel(sessionId: string, template: string): string {
  const nonce = _getSshNonceForTest(sessionId)
  if (nonce === undefined) throw new Error(`nonceSentinel: no nonce registered for session ${sessionId} -- spawnPty must run first`)
  return template.replace('{NONCE}', nonce)
}

/**
 * Drive the manual SSH flow past host setup and into writeClaudeCmd:
 * launchClaude() (writes setup after a 200ms delay) -> feed the sentinel
 * chunk -> advance past the 1.5s idle-fallback that chains to
 * writeClaudeCmd -> advance past its own 200ms write delay.
 *
 * `sentinelTemplate` may contain the literal placeholder "{NONCE}" -- if it
 * does, it is substituted with this session's REAL nonce before being fed;
 * tests that deliberately probe the spoofing attack (no nonce present at
 * all, or a stale/wrong one) pass a template with no placeholder, or one
 * containing a nonce that does NOT match, so it is fed completely verbatim.
 */
function driveToClaudeWrite(sessionId: string, sentinelTemplate: string): void {
  onDataListeners.length = 0
  spawnPty(fakeWin, sessionId, { ssh: SSH } as never)
  writeMock.mockClear()
  getSshFlow(sessionId)!.launchClaude()
  vi.advanceTimersByTime(300) // past writeHostSetupCmd's 200ms setup write
  feedPtyData(sentinelTemplate.includes('{NONCE}') ? nonceSentinel(sessionId, sentinelTemplate) : sentinelTemplate)
  vi.advanceTimersByTime(1500) // idle fallback: setupDone -> proceedAfterSetup
  vi.advanceTimersByTime(300) // writeClaudeCmd's OR writeTmuxStageCmd's own 200ms write delay
  // #242 tier 3: a tmux=none/hostile/truncated sentinel now routes through
  // the curl/wget staging step before claude, instead of writing claudeCmd
  // directly. Resolve it with a fail sentinel so this helper still lands
  // on the eventual claude write either way -- the dedicated tier-3
  // describe block below covers the staging step itself in detail.
  if (writeMock.mock.calls.some((c) => isStagingWrite(c[0]))) {
    feedPtyData(nonceSentinel(sessionId, 'ccc-tmux-stage {NONCE} fail=test\r\n'))
    vi.advanceTimersByTime(300)
  }
}

describe('spawnPty SSH branch — writeClaudeCmd tmux wrapping (#242)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // SSH tmux enhancement (item 1): the "Detachable" toggle (SSHOptions.detachable).
  // Off => the tmux ladder is fully bypassed: no wrap even when the host HAS
  // tmux, and no tier-3/4 staging write on a tmux-less host (the "no silent
  // install" guarantee). Both are separate gates, hence two tests.
  it('detachable:false writes a BARE claude even when the sentinel reports tmux=path', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-detach-off-hit', { ssh: { ...SSH, detachable: false } } as never)
    writeMock.mockClear()
    getSshFlow('s-detach-off-hit')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-detach-off-hit', 'setup ok {NONCE} tmux=path\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    expect(written).not.toContain('has-session')
    expect(written).not.toMatch(/new-session\s+-s\s+ccc-/)
    expect(written).toContain('claude ')
  })

  it('detachable:false does NOT attempt tier-3/4 staging on a tmux=none host (no silent install)', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-detach-off-miss', { ssh: { ...SSH, detachable: false } } as never)
    writeMock.mockClear()
    getSshFlow('s-detach-off-miss')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-detach-off-miss', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.some((c) => isStagingWrite(c[0]))).toBe(false)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0] as string).not.toContain('has-session')
  })

  // Container runtime (item e): the ladder is FORCED OFF regardless of the
  // Detachable toggle — the hop-2 wrap (tmux inside the container) is
  // live-proven to break statusline delivery (T23, ssh-statusline-docker
  // .live.ts, 2026-08-31). Bare claude in-container until the hop-1 design.
  it('container runtime forces the ladder OFF: bare claude even on tmux=path, no staging, despite Detachable default-on', () => {
    onDataListeners.length = 0
    const sid = 's-container-no-tmux'
    spawnPty(fakeWin, sid, { ssh: { ...SSH, runtime: { type: 'container', container: 'ccc-test' } } } as never)
    writeMock.mockClear()
    feedPtyData('Welcome\r\n')
    vi.advanceTimersByTime(1500) // idle: connecting -> awaiting-postcommand
    getSshFlow(sid)!.runPostCommand()
    vi.advanceTimersByTime(300)
    feedPtyData('user@container:~$ ') // inner shell -> awaiting-claude
    getSshFlow(sid)!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel(sid, 'setup ok {NONCE} tmux=path\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.some((c) => isStagingWrite(c[0]))).toBe(false)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0] as string).not.toContain('has-session')
    expect(claudeWrite![0] as string).not.toMatch(/new-session\s+-s\s+ccc-/)
  })

  // ADR-009: a config written BEFORE the structured Runtime field existed says
  // `postCommand: 'sudo docker exec -it <name> bash'` and carries no `runtime`
  // at all — but claude still ends up inside the container. Keying the gate on
  // `ssh.runtime` alone classed those sessions as plain hosts, so they got BOTH
  // container defects the structured path had already fixed: tmux wrapped them
  // at hop 2 (statusline dead) and End composed no in-container kill (#572).
  // Mutation to prove this can fail: gate on `ssh.runtime?.type` again.
  it('LEGACY docker post-command (no structured runtime) is gated as a container: bare claude, no staging', () => {
    onDataListeners.length = 0
    const sid = 's-legacy-docker'
    spawnPty(fakeWin, sid, { ssh: { ...SSH, postCommand: 'sudo docker exec -it ccc-test bash' } } as never)
    writeMock.mockClear()
    feedPtyData('Welcome\r\n')
    vi.advanceTimersByTime(1500) // idle: connecting -> awaiting-postcommand
    getSshFlow(sid)!.runPostCommand()
    vi.advanceTimersByTime(300)
    feedPtyData('user@container:~$ ') // inner shell -> awaiting-claude
    getSshFlow(sid)!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel(sid, 'setup ok {NONCE} tmux=path\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.some((c) => isStagingWrite(c[0]))).toBe(false)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0] as string).not.toContain('has-session')
    expect(claudeWrite![0] as string).not.toMatch(/new-session\s+-s\s+ccc-/)
  })

  it('a NON-docker post-command is still a plain host session (the parse must not over-match)', () => {
    onDataListeners.length = 0
    const sid = 's-plain-postcmd'
    spawnPty(fakeWin, sid, { ssh: { ...SSH, postCommand: 'source ~/.venv/bin/activate' } } as never)
    writeMock.mockClear()
    feedPtyData('Welcome\r\n')
    vi.advanceTimersByTime(1500)
    getSshFlow(sid)!.runPostCommand()
    vi.advanceTimersByTime(300)
    feedPtyData('user@host:~$ ')
    getSshFlow(sid)!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel(sid, 'setup ok {NONCE} tmux=path\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0] as string).toContain(`new-session -s ccc-${sid}`)
  })

  it('detachable default (undefined) still wraps in tmux on tmux=path', () => {
    driveToClaudeWrite('s-detach-default', 'setup ok {NONCE} tmux=path\r\n')
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect((claudeWrite![0] as string)).toContain('has-session -t ccc-s-detach-default')
  })

  it('wraps claudeCmd in the tmux has-session wrapper when the setup sentinel reports tmux=path (tier 1, found on PATH)', () => {
    driveToClaudeWrite('s-tmux-hit', 'setup ok {NONCE} tmux=path\r\n')
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    expect(written).toContain(`${ON_PATH_TMUX_BIN_EXPR} new-session -s ccc-s-tmux-hit`)
    expect(written).toContain('claude ')
    // Item 34: inside the tmux wrap the whole inner command is single-quoted
    // and embedded quotes are escaped, so the COLORFGBG token survives as
    // COLORFGBG='\''15;0'\'' -- which the remote sh unwraps back to '15;0'.
    expect(written).toContain(`COLORFGBG='\\''15;0'\\'' `)
  })

  // #546: classic terminal copy/paste is default-on (readConfig returns null in
  // this harness, so `classicTerminalCopyPaste !== false` holds), so the remote
  // launch must carry CLAUDE_CODE_DISABLE_MOUSE=1 + DISABLE_ALTERNATE_SCREEN=1 —
  // the same env the LOCAL spawn sets (buildClaudeLocalSpawn) so xterm owns the
  // mouse and drag-selection/right-click copy work over SSH just like locally.
  // Mutation to prove this can fail: drop either token from claudeEnvVars in
  // pty-manager.ts — the remote Claude keeps mouse tracking on, xterm forwards
  // the drag, and selection is dead (the exact #546 symptom). The tokens ride
  // inside the single-quoted tmux inner command, so they are present regardless
  // of the wrap.
  it('#546: default classic mode puts CLAUDE_CODE_DISABLE_MOUSE + DISABLE_ALTERNATE_SCREEN on the remote launch', () => {
    driveToClaudeWrite('s-546-mouse-default', 'setup ok {NONCE} tmux=path\r\n')
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    expect(written).toContain('CLAUDE_CODE_DISABLE_MOUSE=1')
    expect(written).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1')
  })

  // #242 round-3 correction (I3): tier 2 (a pre-existing ~/.claude/bin/tmux)
  // shares the SAME fixed launch token as tier 3/4 -- STAGED_TMUX_BIN_EXPR --
  // since all three install/detect at the identical remote location.
  it('wraps claudeCmd in the tmux has-session wrapper when the setup sentinel reports tmux=home (tier 2, pre-existing ~/.claude/bin/tmux)', () => {
    driveToClaudeWrite('s-tmux-home', 'setup ok {NONCE} tmux=home\r\n')
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    expect(written).toContain(`${STAGED_TMUX_BIN_EXPR} new-session -s ccc-s-tmux-home`)
    expect(written).toContain('claude ')
  })

  it('writes the bare claudeCmd (no tmux) when the sentinel reports tmux=none', () => {
    driveToClaudeWrite('s-tmux-miss', 'setup ok {NONCE} tmux=none\r\n')
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    // Not a substring check for the literal "tmux" -- the sessionId itself
    // (s-tmux-miss) legitimately appears inside --settings/--mcp-config
    // paths regardless of wrapping. Assert the WRAPPER shape is absent and
    // the claude invocation is not embedded inside a single-quoted argument
    // (which is how the tmux wrap would present it). "No single quote at
    // all" was the old proxy for that; it is no longer true of a bare line,
    // because the COLORFGBG prefix is legitimately quoted (its value carries
    // a `;`) -- so the check is the wrap's own marks: a line that STARTS with
    // a quote, or carries the '\'' escape the wrap produces.
    expect(written).not.toMatch(/new-session\s+-s\s+ccc-/)
    expect(written.trimStart().startsWith(`'`)).toBe(false)
    expect(written).not.toContain(`'\\''`)
    expect(written).toContain('claude ')
    // Item 34: the remote line carries the host scheme. nativeTheme is mocked
    // light-preferring but the theme setting is unset, so the app default
    // (dark) wins -> "15;0", quoted for POSIX sh.
    expect(written).toContain(`COLORFGBG='15;0' `)
  })

  // #242 round-3 correction (I3): the tmux= field is now a fixed 3-way enum
  // (path|home|none) -- there is no longer a captured free-text value for a
  // hostile/option-like/metacharacter-bearing input to reach the launch
  // command with at all (that whole class of finding is closed by
  // construction, not by a stronger validator). A value outside the enum
  // simply fails the sentinel regex -- indistinguishable from "not present
  // in this chunk yet" -- so setup does not complete from that data, and
  // nothing is written. What still matters here: this must not throw out of
  // a setTimeout callback (armIdleFallback / writeClaudeCmd's own 200ms
  // write), which would crash main via the global uncaughtException handler
  // (#188 shape), and the flow must still degrade safely (to the setup
  // timeout's 'failed' state) rather than hanging forever.
  it('does not throw and does not latch setup completion when the sentinel carries an out-of-enum tmux value', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-tmux-hostile', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-tmux-hostile')!.launchClaude()
    vi.advanceTimersByTime(300)
    for (const hostile of ['-oProxyCommand=x', '/usr/bin/tmux;id', '/usr/bin/tmux']) {
      expect(() => feedPtyData(nonceSentinel('s-tmux-hostile', `setup ok {NONCE} tmux=${hostile}\r\n`))).not.toThrow()
    }
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
    // The genuine setup timeout still fires safely, degrading to 'failed'
    // rather than hanging or crashing -- none of the garbage above ever
    // counted as a real completion.
    vi.advanceTimersByTime(10000) // SETUP_TIMEOUT_MS
    expect(getSshFlow('s-tmux-hostile')!.getState().state).toBe('failed')
  })
})

// #242 finding I1 (BLOCKER-equivalent live-feature bug): a real SSH link
// routinely segments a single logical line across multiple PTY chunks.
// parseTmuxSentinel's chunk-boundary discipline correctly refuses to match
// a truncated read off the FIRST chunk alone -- but before the fix, nothing
// ever re-parsed the SECOND chunk, because the (pre-fix) completion latch
// was a bare substring check that had already fired off chunk 1 alone
// (chunk 1 already contains the literal text "setup ok"). The fix buffers
// the accumulated line per session (`bufferSetupLine`) and re-parses the
// COMBINED text on every chunk until it resolves.
//
// Mutation to prove each test below can fail: revert the host-setup-ok
// handler in pty-manager.ts to parse `data` (the current chunk alone)
// instead of the buffered `combined` text -- every assertion below then
// fails, because chunk 2 alone (e.g. "th\r\n") never matches
// `setup ok <nonce> tmux=...` on its own, and detectedTmuxSource stays
// null (bare launch) instead of getting tmux-wrapped.
describe('spawnPty SSH branch — sentinel split across PTY chunks (#242 finding I1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function driveHostSetupOnly(sessionId: string): void {
    onDataListeners.length = 0
    spawnPty(fakeWin, sessionId, { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow(sessionId)!.launchClaude()
    vi.advanceTimersByTime(300) // past writeHostSetupCmd's 200ms setup write
  }

  function finishAndGetClaudeWrite(): string {
    vi.advanceTimersByTime(1500) // idle fallback: setupDone -> proceedAfterSetup
    vi.advanceTimersByTime(300) // writeClaudeCmd's own 200ms write delay
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    return claudeWrite![0] as string
  }

  // The exact non-adversarial repro this finding was filed against: the
  // chunk boundary lands INSIDE the tmux= class token itself.
  it('still wraps in tmux when the tmux= class token is split across two chunks', () => {
    const sessionId = 's-i1-split-value'
    driveHostSetupOnly(sessionId)
    const nonce = _getSshNonceForTest(sessionId)!
    feedPtyData(`setup ok ${nonce} tmux=pa`)
    feedPtyData(`th\r\n`)
    const written = finishAndGetClaudeWrite()
    expect(written).toContain(`${ON_PATH_TMUX_BIN_EXPR} new-session -s ccc-${sessionId}`)
  })

  it('still wraps in tmux when the chunk boundary lands mid-nonce', () => {
    const sessionId = 's-i1-split-nonce'
    driveHostSetupOnly(sessionId)
    const nonce = _getSshNonceForTest(sessionId)!
    const mid = Math.floor(nonce.length / 2)
    feedPtyData(`setup ok ${nonce.slice(0, mid)}`)
    feedPtyData(`${nonce.slice(mid)} tmux=home\r\n`)
    const written = finishAndGetClaudeWrite()
    expect(written).toContain(`${STAGED_TMUX_BIN_EXPR} new-session -s ccc-${sessionId}`)
  })

  it('still wraps in tmux across a three-way split of the sentinel line', () => {
    const sessionId = 's-i1-split-three'
    driveHostSetupOnly(sessionId)
    const nonce = _getSshNonceForTest(sessionId)!
    feedPtyData(`setup ok `)
    feedPtyData(`${nonce} tmux=pa`)
    feedPtyData(`th\r\n`)
    const written = finishAndGetClaudeWrite()
    expect(written).toContain(`${ON_PATH_TMUX_BIN_EXPR} new-session -s ccc-${sessionId}`)
  })

  // A chunk that never arrives with the terminating newline must still
  // degrade safely (setup timeout -> 'failed'), not hang forever or throw --
  // the buffer is bounded (MAX_SETUP_LINE_BUFFER), not an unbounded
  // accumulation.
  it('degrades safely to the setup timeout when the second half of the line never arrives', () => {
    const sessionId = 's-i1-never-completes'
    driveHostSetupOnly(sessionId)
    feedPtyData(nonceSentinel(sessionId, 'setup ok {NONCE} tmux=pa'))
    vi.advanceTimersByTime(10000) // SETUP_TIMEOUT_MS
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
    expect(getSshFlow(sessionId)!.getState().state).toBe('failed')
  })

  // ROUND-2 MAJOR regression this finding was filed against: an earlier
  // `bufferSetupLine` capped the string it RETURNED for parsing (not just
  // the string it RETAINED for next time) at MAX_SETUP_LINE_BUFFER -- so a
  // COMPLETE, correctly-nonced sentinel followed by more than the cap's
  // worth of trailing bytes in the SAME chunk got silently dropped from the
  // parsed text, and the session never latched setupDone at all (ended
  // 'failed' with no claude write, not even the bare launch). This test
  // proves the genuine sentinel still resolves even with a large trailing
  // tail in the same chunk. Mutation to prove it can fail: reintroduce the
  // cap on the RETURNED value in bufferSetupLine (e.g. slice `combined`
  // itself before returning it) -- this then ends 'failed' with no write.
  it('still wraps in tmux when the genuine sentinel is followed by more than the buffer cap worth of trailing bytes in the SAME chunk', () => {
    const sessionId = 's-i1-trailing-overflow'
    driveHostSetupOnly(sessionId)
    const nonce = _getSshNonceForTest(sessionId)!
    // 4096 mirrors MAX_SETUP_LINE_BUFFER in pty-manager.ts (not exported).
    feedPtyData(`setup ok ${nonce} tmux=path\r\n` + 'y'.repeat(4096 + 1))
    const written = finishAndGetClaudeWrite()
    expect(written).toContain(`${ON_PATH_TMUX_BIN_EXPR} new-session -s ccc-${sessionId}`)
  })

  // Isolating control for the test above: comfortably UNDER the cap, this
  // always worked, even pre-fix -- proves the overflow test isn't passing
  // for some unrelated reason.
  it('control: still wraps in tmux with trailing bytes comfortably under the buffer cap', () => {
    const sessionId = 's-i1-trailing-under-cap'
    driveHostSetupOnly(sessionId)
    const nonce = _getSshNonceForTest(sessionId)!
    feedPtyData(`setup ok ${nonce} tmux=path\r\n` + 'y'.repeat(1000))
    const written = finishAndGetClaudeWrite()
    expect(written).toContain(`${ON_PATH_TMUX_BIN_EXPR} new-session -s ccc-${sessionId}`)
  })

  // ROUND-2 MAJOR: two of the three properties this buffer is required to
  // have (bounded size, cleared on teardown) were present in the code but
  // asserted by NO test -- both survived the full suite when mutated. These
  // two tests close that gap using the test-only length accessor.
  //
  // (a) Boundedness. Mutation to prove this can fail: neuter the cap in
  // bufferSetupLine (e.g. `if (false && combined.length > ...)`) -- the
  // buffer then grows to the full ~200KB fed below and this assertion fails.
  it('bounds the setup-line buffer even when fed ~200KB of newline-free remote output', () => {
    const sessionId = 's-i1-buffer-bounded'
    driveHostSetupOnly(sessionId)
    feedPtyData('y'.repeat(200_000)) // no \r/\n -- never resolves, just accumulates
    const len = _getSetupLineBufferLenForTest(sessionId)
    expect(len).toBeDefined()
    expect(len!).toBeLessThanOrEqual(4096) // mirrors MAX_SETUP_LINE_BUFFER
  })

  // (b) Teardown. Mutation to prove this can fail: remove the
  // `clearSetupLineBuffer(sessionId)` call from cleanupSessionResources --
  // the accessor then still returns a defined length after killPty below.
  it('clears the setup-line buffer on teardown (killPty -> cleanupSessionResources)', () => {
    const sessionId = 's-i1-buffer-teardown'
    driveHostSetupOnly(sessionId)
    const nonce = _getSshNonceForTest(sessionId)!
    feedPtyData(`setup ok ${nonce} tmux=pa`) // partial line -- buffer is populated, unresolved
    expect(_getSetupLineBufferLenForTest(sessionId)).toBeDefined()
    killPty(sessionId)
    expect(_getSetupLineBufferLenForTest(sessionId)).toBeUndefined()
  })
})

// #242 finding F1, BLOCKER (adversarial review round 5). Demonstrated attack:
// "feeding a line shaped like a wall broadcast made CCC write
// /tmp/.x/tmux new-session -s ccc-victim1 '...claude...' into the
// victim's shell" and "a bare relative name ('setup ok tmux=tmux') also
// works". These drive the REAL flow (spawnPty -> launchClaude -> feed
// bytes), not the pure builders, because the vulnerability is in what the
// flow ACCEPTS from the wire.
describe('spawnPty SSH branch — F1 spoofed-sentinel regressions (#242 BLOCKER)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // #242 finding I2 correction: pre-fix, the OUTER setupDone latch was a
  // bare `data.includes('setup ok')` substring check, independent of the
  // nonce -- so a spoofed sentinel with NO nonce at all still flipped
  // setupDone (just left detectedTmuxPath untouched), forcing an unwanted
  // tier-3 staging attempt on a host that might already have had tmux. Now
  // the completion latch itself is gated on the SAME nonce-bearing match
  // the tmux-class read uses, so a no-nonce spoof does not complete setup
  // AT ALL from this data -- there is nothing for it to force. Mutation to
  // prove this can fail: revert the setupDone latch to a bare substring
  // check (its pre-fix shape) -- setupDone would flip on this chunk alone
  // and the assertion below (still pending, no write yet) would fail.
  it('a spoofed "setup ok tmux=path" carrying NO nonce does not latch setup completion at all', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-f1-no-nonce', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-f1-no-nonce')!.launchClaude()
    vi.advanceTimersByTime(300)
    // No {NONCE} placeholder -- fed completely verbatim, exactly the shape
    // a co-tenant's wall/write broadcast (or any other PTY writer) would
    // produce with no knowledge of this session's real nonce.
    feedPtyData('setup ok tmux=path\r\n')
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
    // The real sentinel arriving afterward still completes setup normally --
    // the spoof did not poison or consume the buffer.
    feedPtyData(nonceSentinel('s-f1-no-nonce', 'setup ok {NONCE} tmux=path\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect((claudeWrite![0] as string)).toContain(ON_PATH_TMUX_BIN_EXPR)
  })

  // The second documented variant: a WRONG nonce, applies to EVERY SSH
  // session, no tmux-less host required, since it targets the tier-1/2
  // window directly. Same I2 correction as above -- a wrong-nonce sentinel
  // no longer completes setup either, even claiming the maximal `tmux=path`
  // class.
  it('a spoofed sentinel with the WRONG nonce does not latch setup completion either, even claiming tmux=path', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-f1-wrong-nonce', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-f1-wrong-nonce')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData('setup ok wrongnonceabc123 tmux=path\r\n')
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
    feedPtyData(nonceSentinel('s-f1-wrong-nonce', 'setup ok {NONCE} tmux=home\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    // Genuine result was tmux=home (staged location) -- the spoofed
    // tmux=path (which would have selected ON_PATH_TMUX_BIN_EXPR instead)
    // never took effect.
    expect((claudeWrite![0] as string)).toContain(STAGED_TMUX_BIN_EXPR)
    expect((claudeWrite![0] as string)).not.toContain(ON_PATH_TMUX_BIN_EXPR)
  })

  // #242 finding F1(a), round-2 correction, BLOCKER. The round-2 reviewer's
  // exact demonstrated regression: an "ends with /.claude/bin/tmux" check
  // (the pre-round-2 approach) is satisfiable from an attacker-writable
  // directory -- `mkdir -p /tmp/.claude/bin` succeeds for any co-tenant, so
  // BOTH `/tmp/.claude/bin/tmux` and the double-slash
  // `/tmp/x//.claude/bin/tmux` satisfy that suffix test while pointing at
  // attacker-controlled bytes, WITH a genuinely valid nonce. `/tmp/.x/tmux`
  // (which fails even the old ends-with check) is included too, so this one
  // test covers the full spectrum the reviewer named. Mutation to prove
  // this can fail: revert buildTmuxLaunchCommand's staged branch to read
  // `input.tmuxBin` (the round-2-rejected shape) instead of always emitting
  // STAGED_TMUX_BIN_EXPR -- every `not.toContain` below then fails, because
  // the reported attacker path reaches the written command.
  it('a spoofed stage-ok reporting a path outside the real $HOME/.claude/bin -- including one satisfying an "ends with" test from an attacker-writable dir -- never reaches the launch command, even WITH a valid nonce', () => {
    for (const hostilePath of ['/tmp/.x/tmux', '/tmp/.claude/bin/tmux', '/tmp/x//.claude/bin/tmux']) {
      const sessionId = `s-f1-outside-claudebin-${hostilePath.replace(/[^a-z0-9]/gi, '')}`
      driveToStageWrite(sessionId)
      writeMock.mockClear()
      feedPtyData(nonceSentinel(sessionId, `ccc-tmux-stage {NONCE} ok path=${hostilePath}\r\n`))
      vi.advanceTimersByTime(300)
      const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
      expect(claudeWrite).toBeDefined()
      const written = claudeWrite![0] as string
      // Staging still genuinely succeeded (a real binary really was
      // installed) -- the launch IS tmux-wrapped, just never with the
      // attacker-reported operand.
      expect(written).toMatch(/new-session\s+-s\s+ccc-/)
      expect(written).not.toContain(hostilePath)
      expect(written).toContain('"$HOME"/.claude/bin/tmux new-session -s ccc-')
    }
  })

  // The genuine, nonce-carrying sentinel must still work end to end --
  // otherwise the fix would have closed the hole by breaking the feature.
  it('the genuine nonce-carrying tier-1/2 sentinel still wraps claude in tmux end to end', () => {
    driveToClaudeWrite('s-f1-genuine-tier12', 'setup ok {NONCE} tmux=path\r\n')
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect((claudeWrite![0] as string)).toContain(`${ON_PATH_TMUX_BIN_EXPR} new-session -s ccc-s-f1-genuine-tier12`)
  })

  it('the genuine nonce-carrying tier-3 staged-ok sentinel still wraps claude in tmux end to end', () => {
    driveToStageWrite('s-f1-genuine-tier3')
    writeMock.mockClear()
    feedPtyData(nonceSentinel('s-f1-genuine-tier3', 'ccc-tmux-stage {NONCE} ok path=/home/dev/.claude/bin/tmux\r\n'))
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    // #242 finding F1(a), round-2 correction: the launch always embeds the
    // fixed $HOME expression for a staged tier, never the reported path --
    // see STAGED_TMUX_BIN_EXPR (ssh-tmux.ts).
    expect((claudeWrite![0] as string)).toContain('"$HOME"/.claude/bin/tmux new-session -s ccc-s-f1-genuine-tier3')
  })
})

// Direct unit coverage of parseTmuxSentinel's three-way discrimination
// (adversarial review, #242 MINOR): the old `parseTmuxSentinel(data) ??
// detectedTmuxPath` call sites could not tell "no sentinel field in this
// chunk" apart from "field explicitly said none", so a later `none` could
// not clear an earlier detected path.
// #242 tier 3 call-site guard. Mirrors the driveToClaudeWrite helper above:
// when tier 1/2 report tmux=none, the flow must run the curl/wget staging
// fragment BEFORE writeClaudeCmd -- not skip straight to the bare launch --
// and must still reach writeClaudeCmd afterward regardless of how staging
// turns out.
// #242 I1 ROUND-3. The first cut of the split-chunk buffer covered only the two
// setup-ok latches, leaving the tier-3/4 stage sentinel and the tier-4 arch
// probe parsing the raw chunk -- so the bug stayed live on exactly the tiers a
// tmux-less remote depends on, which is what a desktop test against a real
// remote exercises. Each of these fails when its call site is reverted to parse
// `data` instead of the accumulated buffer.
describe('#242 I1: tier-3/4 sentinels split across PTY chunks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('still wraps in tmux when a stage ok path= sentinel is split across two chunks', () => {
    const sessionId = 's-i1-stage-ok-split'
    driveToStageWrite(sessionId)
    const whole = nonceSentinel(sessionId, 'ccc-tmux-stage {NONCE} ok path=/home/dev/.claude/bin/tmux\r\n')
    const cut = whole.indexOf('path=') + 'path=/home/dev/.claude/bin/'.length
    feedPtyData(whole.slice(0, cut))
    feedPtyData(whole.slice(cut))
    vi.advanceTimersByTime(300) // writeClaudeCmd's own 200ms write delay
    const claudeWrite = writeMock.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .find((s) => s.includes('claude '))
    expect(claudeWrite).toBeDefined()
    // Staged tier never trusts the reported path -- it launches the host-side
    // literal expression. The point here is that it WRAPS at all.
    expect(claudeWrite).toContain(`${STAGED_TMUX_BIN_EXPR} new-session -s ccc-${sessionId}`)
  })

  it('reaches the bare launch promptly when a stage fail= sentinel is split across two chunks', () => {
    const sessionId = 's-i1-stage-fail-split'
    driveToStageWrite(sessionId)
    const whole = nonceSentinel(sessionId, 'ccc-tmux-stage {NONCE} fail=terminfo\r\n')
    const cut = whole.indexOf('fail=') + 'fail=ter'.length
    feedPtyData(whole.slice(0, cut))
    feedPtyData(whole.slice(cut))
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .find((s) => s.includes('claude '))
    // Without buffering this only arrives via the 20s STAGE_TIMEOUT, so the
    // 300ms advance above is the assertion: it resolved from the sentinel.
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite).not.toContain('has-session')
  })

  it('still reaches tier 4 when the arch probe is split across two chunks', async () => {
    const sessionId = 's-i1-arch-split'
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    try {
      driveToStageWrite(sessionId)
      // Arch probe split mid-token: without buffering detectedArch stays null
      // and the later fail=download can never hand off to attemptTmuxPush, so
      // tier 4 is unreachable on any link that segments the line.
      feedPtyData('ccc-tmux-push-arch Linux-x86')
      feedPtyData('_64\r\n')
      feedPtyData(nonceSentinel(sessionId, 'ccc-tmux-stage {NONCE} fail=download\r\n'))
      await flushMicrotasks()
      expect(pushActivityDetected()).toBe(true)
    } finally {
      _setTmuxArchiveResolverForTest(null)
    }
  })

  it('drops the stage and arch buffers on teardown', () => {
    const sessionId = 's-i1-buffers-teardown'
    driveToStageWrite(sessionId)
    feedPtyData('ccc-tmux-push-arch Linux-x86') // partial: stays buffered
    expect(_getSetupLineBufferLenForTest(sessionId, 'arch')).toBeGreaterThan(0)
    killPty(sessionId)
    expect(_getSetupLineBufferLenForTest(sessionId, 'arch')).toBeUndefined()
    expect(_getSetupLineBufferLenForTest(sessionId, 'stage')).toBeUndefined()
  })
})

function driveToStageWrite(sessionId: string): void {
  onDataListeners.length = 0
  spawnPty(fakeWin, sessionId, { ssh: SSH } as never)
  writeMock.mockClear()
  getSshFlow(sessionId)!.launchClaude()
  vi.advanceTimersByTime(300) // past writeHostSetupCmd's 200ms setup write
  feedPtyData(nonceSentinel(sessionId, 'setup ok {NONCE} tmux=none\r\n'))
  vi.advanceTimersByTime(1500) // idle fallback: setupDone -> proceedAfterSetup -> writeTmuxStageCmd scheduled
  vi.advanceTimersByTime(300) // writeTmuxStageCmd's own 200ms write delay
}

describe('spawnPty SSH branch — tmux tier-3 staging call site (#242)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Acceptance: "fails when the flow stops writing the stage command on a
  // `setup ok tmux=none` remote". Reverting proceedAfterSetup to call
  // writeClaudeCmd() directly (skipping writeTmuxStageCmd) makes this fail:
  // the first write would be the bare claude command instead of the
  // staging fragment.
  it('writes the curl/wget staging fragment before claude when tier 1/2 report tmux=none', () => {
    driveToStageWrite('s-stage-run')
    const stageWrite = writeMock.mock.calls.find((c) => isStagingWrite(c[0]))
    expect(stageWrite).toBeDefined()
    const written = stageWrite![0] as string
    // #242 round-3 MAJOR fix: the outgoing write is base64-wrapped, so
    // 'uname -s'/'sha256sum -c' no longer appear in the written text
    // directly -- assert the wrapper shape instead, and decode the payload
    // to confirm it really does carry the staging script.
    expect(written).toMatch(/^stty -echo 2>\/dev\/null; echo '[A-Za-z0-9+\/=]+' \| base64 -d \| sh; stty echo 2>\/dev\/null\r?$/)
    const b64 = written.match(/echo '([A-Za-z0-9+\/=]+)'/)![1]
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    expect(decoded).toContain('uname -s')
    expect(decoded).toContain('sha256sum -c')
    // Nothing claude-shaped has been written yet -- staging is still
    // in flight, awaiting its own sentinel.
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
  })

  it('does NOT stage when tier 1/2 already found a tmux binary', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-stage-skip', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-stage-skip')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-stage-skip', 'setup ok {NONCE} tmux=path\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.some((c) => isStagingWrite(c[0]))).toBe(false)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect((claudeWrite![0] as string)).toContain('new-session -s ccc-s-stage-skip')
  })

  // Acceptance: "fails when a `ccc-tmux-stage fail=terminfo` chunk no
  // longer produces an unwrapped claudeCmd launch". If the stage-sentinel
  // handler stopped calling writeClaudeCmd on failure (or wrongly set
  // detectedTmuxPath), the claude write would either never happen or come
  // out tmux-wrapped.
  it('falls through to the unwrapped claude launch on ccc-tmux-stage fail=terminfo', () => {
    driveToStageWrite('s-stage-fail')
    writeMock.mockClear()
    feedPtyData(nonceSentinel('s-stage-fail', 'ccc-tmux-stage {NONCE} fail=terminfo\r\n'))
    vi.advanceTimersByTime(300) // writeClaudeCmd's own 200ms write delay
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    expect(written).not.toMatch(/new-session\s+-s\s+ccc-/)
    expect(written).toContain('claude ')
  })

  it('wraps the eventual claude launch in tmux when staging reports ok path=...', () => {
    driveToStageWrite('s-stage-ok')
    writeMock.mockClear()
    feedPtyData(nonceSentinel('s-stage-ok', 'ccc-tmux-stage {NONCE} ok path=/home/dev/.claude/bin/tmux\r\n'))
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    // #242 finding F1(a), round-2 correction: the reported path is never
    // used to build the launch -- see STAGED_TMUX_BIN_EXPR (ssh-tmux.ts).
    expect(written).toContain('"$HOME"/.claude/bin/tmux new-session -s ccc-s-stage-ok')
    expect(written).not.toContain('/home/dev/.claude/bin/tmux new-session')
  })

  // A hostile/unsafe path in the staging "ok" line must degrade to the
  // bare launch exactly like the tier-1/2 hostile-path tests above --
  // parseTmuxStageSentinel re-applies isSafeTmuxBin rather than trusting
  // raw remote output.
  it('falls through to the unwrapped launch when the staged ok path fails the tmuxBin allowlist', () => {
    driveToStageWrite('s-stage-hostile')
    writeMock.mockClear()
    feedPtyData(nonceSentinel('s-stage-hostile', 'ccc-tmux-stage {NONCE} ok path=-oProxyCommand=x\r\n'))
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    expect(written).not.toMatch(/new-session\s+-s\s+ccc-/)
    expect(written).not.toContain('-oProxyCommand')
  })

  it('falls through to the bare launch if the stage sentinel never arrives (timeout)', () => {
    driveToStageWrite('s-stage-timeout')
    writeMock.mockClear()
    vi.advanceTimersByTime(20000) // STAGE_TIMEOUT_MS
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    expect(written).not.toMatch(/new-session\s+-s\s+ccc-/)
  })

  // #242 finding F3 (adversarial review round 4, MAJOR): stagingTimeoutHandle
  // was armed by writeTmuxStageCmd but never cleared by
  // flowController.destroy() -- it outlives session teardown and, 20s later,
  // drives a full claude-launch write into the PTY destroy() just tore down
  // (the exact invariant destroy() exists to enforce; setupTimeoutHandle and
  // idleFallbackHandle were already cleared there, stagingTimeoutHandle was
  // not).
  //
  // The invariant is now defended TWICE -- destroy() clears the timer AND sets a
  // `destroyed` flag that writeClaudeCmd/writeTmuxStageCmd bail on -- so no single
  // mutation fails this test. Verified: removing only the clearTimeout block leaves
  // it GREEN (the flag still catches the write); removing the `destroyed` check in
  // writeClaudeCmd as well is what makes it fail. Both guards are deliberate: the
  // clear stops the timer, the flag stops any write that outruns it.
  //
  // Recorded precisely because an earlier revision of this comment claimed the
  // single-mutation version fails, and it does not. A comment asserting a mutation
  // sensitivity the test does not have is the same defect class as a test that
  // cannot fail -- someone later trusts it instead of re-running it (#241).
  it('clears the staging timer on destroy() so a leaked timer never writes into a killed PTY', () => {
    driveToStageWrite('s-stage-destroy')
    const writesBeforeDestroy = writeMock.mock.calls.length
    getSshFlow('s-stage-destroy')!.destroy()
    vi.advanceTimersByTime(20300) // STAGE_TIMEOUT_MS + writeClaudeCmd's own 200ms write delay
    expect(writeMock.mock.calls.length).toBe(writesBeforeDestroy)
  })

  it('attempts staging only once per session even if the setup-completion path fires again', () => {
    driveToStageWrite('s-stage-once')
    const stageWritesBefore = writeMock.mock.calls.filter((c) => isStagingWrite(c[0])).length
    expect(stageWritesBefore).toBe(1)
    // Resolve staging (fail) and drive claude write; no SECOND staging
    // attempt should ever occur regardless of subsequent PTY chatter.
    feedPtyData(nonceSentinel('s-stage-once', 'ccc-tmux-stage {NONCE} fail=download\r\n'))
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-stage-once', 'setup ok {NONCE} tmux=none\r\n')) // stray echo of an earlier sentinel, should not retrigger anything
    vi.advanceTimersByTime(1500)
    const stageWritesAfter = writeMock.mock.calls.filter((c) => isStagingWrite(c[0])).length
    expect(stageWritesAfter).toBe(1)
  })

  // Adversarial review round 2, MAJOR (routing half, isolated from the
  // staging-in-flight guard tested below): a Launch-Claude click that lands
  // on the `setupDone` branch -- i.e. setup JUST completed (setupDone flips
  // synchronously in onData) but the 1.5s idle-fallback hasn't fired yet --
  // must go through proceedAfterSetup, not straight to writeClaudeCmd. At
  // the moment of THIS click, stagingSent is still false, so the
  // staging-in-flight guard cannot be what saves it -- only the routing fix
  // can. Reverting `proceedAfterSetup()` back to `writeClaudeCmd()` on this
  // branch makes the second click skip staging and write the bare claude
  // command immediately, even though tier 1/2 just reported tmux=none.
  it('a Launch-Claude click landing on the just-completed setupDone branch still routes through staging, not straight to writeClaudeCmd', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-stage-setupdone-click', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-stage-setupdone-click')!.launchClaude()
    vi.advanceTimersByTime(300) // past writeHostSetupCmd's 200ms setup write
    feedPtyData(nonceSentinel('s-stage-setupdone-click', 'setup ok {NONCE} tmux=none\r\n')) // setupDone flips synchronously here
    // Second click BEFORE the 1.5s idle-fallback has a chance to fire.
    getSshFlow('s-stage-setupdone-click')!.launchClaude()
    vi.advanceTimersByTime(300) // writeTmuxStageCmd's own 200ms write delay
    const stageWrite = writeMock.mock.calls.find((c) => isStagingWrite(c[0]))
    expect(stageWrite).toBeDefined()
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
  })

  // Adversarial review round 2, MAJOR: pre-#242 the setupDone branch of
  // launchClaude() called writeClaudeCmd() directly, which was effectively
  // inert because claudeSent flipped true in the SAME tick setup completed.
  // Tier-3 staging opens a window (up to STAGE_TIMEOUT_MS) where claudeSent
  // is still false while a curl/wget fragment is in flight on the remote --
  // a second Launch-Claude click in that window must not write a second
  // staging attempt OR a premature claude command that races the in-flight
  // download. Reverting either the launchClaude guard or the
  // writeClaudeCmd-direct→proceedAfterSetup fix makes this fail.
  it('a second Launch-Claude click while staging is in flight writes nothing until the stage sentinel resolves', () => {
    driveToStageWrite('s-stage-race')
    const writesWhileStaging = writeMock.mock.calls.length
    getSshFlow('s-stage-race')!.launchClaude()
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.length).toBe(writesWhileStaging)
    expect(writeMock.mock.calls.some((c) => isStagingWrite(c[0]))).toBe(true) // still just the one from driveToStageWrite
    const stageWriteCount = writeMock.mock.calls.filter((c) => isStagingWrite(c[0])).length
    expect(stageWriteCount).toBe(1)
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
    // Resolve staging; the claude write proceeds exactly once, normally --
    // the earlier click did not queue up a duplicate.
    feedPtyData(nonceSentinel('s-stage-race', 'ccc-tmux-stage {NONCE} fail=download\r\n'))
    vi.advanceTimersByTime(300)
    const claudeWrites = writeMock.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrites).toHaveLength(1)
  })

  // Adversarial review round 2, MINOR: the staging-failure branch used to
  // call setFlowState('running-setup', `tmux-stage-fail:<reason>`) and then
  // immediately call writeClaudeCmd(), whose own setFlowState('running-claude')
  // fired in the SAME tick and overwrote it -- a renderer painting only
  // current state never saw the reason. The reason must survive onto the
  // state actually observable via getState() (mirrors what a renderer's
  // flow-state listener would see).
  it('carries the tmux-stage-fail reason forward onto the running-claude state instead of it being overwritten', () => {
    driveToStageWrite('s-stage-info')
    feedPtyData(nonceSentinel('s-stage-info', 'ccc-tmux-stage {NONCE} fail=terminfo\r\n'))
    vi.advanceTimersByTime(300)
    expect(getSshFlow('s-stage-info')!.getState()).toEqual({
      state: 'running-claude',
      info: 'tmux-stage-fail:terminfo',
    })
  })

  // M5 (adversarial review round 5, half-closed until round 2). The throw
  // out of buildTmuxStageCommand/assertSafeTmuxStageConstants was already
  // tested directly (ssh-tmux-stage.test.ts), but the CLEAN FALLBACK at
  // THIS call site -- the try/catch that sets stagingDone and calls
  // writeClaudeCmd('tmux-stage-fail:build-error') -- was not. That catch is
  // what stands between a constant-shape regression and a session that
  // never launches claude at all. TMUX_STAGE_SHA256 is declared `const` but
  // is a plain object -- `const` only freezes the BINDING, not its
  // contents -- so mutating one entry and restoring it in `finally` is a
  // legitimate way to exercise the real call site without touching source.
  //
  // Mutation to prove this can fail: remove the try/catch around the
  // `buildTmuxStageCommand(sshNonce)` call in pty-manager.ts (or drop its
  // `writeClaudeCmd('tmux-stage-fail:build-error')`) -- the corrupted
  // constant then throws OUT of the bare setTimeout callback, which the
  // global uncaughtException handler re-throws (killing main in production;
  // surfacing as an unhandled error / failed assertion here), and no claude
  // write ever lands.
  it('falls through to the bare claude launch and carries tmux-stage-fail:build-error when a TMUX_STAGE_SHA256 entry is corrupted', () => {
    const original = TMUX_STAGE_SHA256['linux-x86_64']
    TMUX_STAGE_SHA256['linux-x86_64'] = 'not-a-real-digest'
    try {
      driveToStageWrite('s-m5-build-error')
      vi.advanceTimersByTime(300) // writeClaudeCmd's own 200ms write delay
      const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
      expect(claudeWrite).toBeDefined()
      const written = claudeWrite![0] as string
      expect(written).not.toMatch(/new-session\s+-s\s+ccc-/)
      expect(getSshFlow('s-m5-build-error')!.getState()).toEqual({
        state: 'running-claude',
        info: 'tmux-stage-fail:build-error',
      })
    } finally {
      TMUX_STAGE_SHA256['linux-x86_64'] = original
    }
  })
})

// #242 finding F3 (MAJOR, adversarial review round 5): after a stage/push
// `ok` sentinel resolves, pty-manager must patch the ALREADY-WRITTEN
// settings-<safeSid>.json's CCC_TMUX_BIN before the claude launch write --
// see buildTmuxBinPatchCommand's doc comment (ssh-shim.ts) for the full
// mechanism. Drives stage-ok and asserts the patch computes a NON-EMPTY
// CCC_TMUX_BIN reaches the wire, not merely that SOME patch write happened.
//
// #242 finding F1(a), round-2 correction: the patch script no longer
// receives the reported path from the host at all -- it computes
// `path.join(os.homedir(),'.claude','bin','tmux')` itself, evaluated on the
// REMOTE at runtime -- so these assertions look for that computation
// EXPRESSION in the decoded script, not a literal reported-path string
// (which would no longer appear even for a perfectly legitimate stage-ok).
function decodedPatchScript(call: unknown): string | undefined {
  if (typeof call !== 'string' || !call.startsWith('echo \'')) return undefined
  const m = call.match(/^echo '([A-Za-z0-9+\/=]+)' \| base64 -d \| node/)
  if (!m) return undefined
  return Buffer.from(m[1], 'base64').toString('utf8')
}
function isTmuxBinPatchWrite(call: unknown): boolean {
  const decoded = decodedPatchScript(call)
  return decoded !== undefined
    && decoded.includes("path.join(os.homedir(),'.claude','bin','tmux')")
    && decoded.includes('CCC_TMUX_BIN=')
}
describe('spawnPty SSH branch — CCC_TMUX_BIN settings patch after stage/push ok (#242 finding F3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Mutation to prove this can fail: remove the buildTmuxBinPatchCommand
  // write from the stage-ok branch in pty-manager.ts -- no write in this
  // session matches isTmuxBinPatchWrite (the only settings write remains
  // the host-setup one, which bakes in the EMPTY tier-1/2 result).
  it('sends a settings patch that computes a NON-EMPTY CCC_TMUX_BIN remotely, after tier-3 stage-ok, BEFORE the claude write -- even when the reported path is attacker-controlled', () => {
    driveToStageWrite('s-f3-stage-patch')
    writeMock.mockClear()
    // Deliberately a hostile reported path (F1(a) round-2 correction): the
    // patch must still compute the FIXED remote location, never this value.
    feedPtyData(nonceSentinel('s-f3-stage-patch', 'ccc-tmux-stage {NONCE} ok path=/tmp/.claude/bin/tmux\r\n'))
    vi.advanceTimersByTime(300)
    const patchWriteIdx = writeMock.mock.calls.findIndex((c) => isTmuxBinPatchWrite(c[0]))
    expect(patchWriteIdx).toBeGreaterThan(-1)
    expect(decodedPatchScript(writeMock.mock.calls[patchWriteIdx][0])).not.toContain('/tmp/.claude/bin/tmux')
    const claudeWriteIdx = writeMock.mock.calls.findIndex((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWriteIdx).toBeGreaterThan(-1)
    expect(patchWriteIdx).toBeLessThan(claudeWriteIdx)
  })

  it('sends a settings patch that computes a NON-EMPTY CCC_TMUX_BIN remotely, after tier-4 push-ok, BEFORE the claude write', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    try {
      driveToPushAttempt('s-f3-push-patch')
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(5000)
      feedPtyData(nonceSentinel('s-f3-push-patch', 'ccc-tmux-stage {NONCE} ok path=/home/dev/.claude/bin/tmux\r\n'))
      await vi.advanceTimersByTimeAsync(300)
      const patchWriteIdx = writeMock.mock.calls.findIndex((c) => isTmuxBinPatchWrite(c[0]))
      expect(patchWriteIdx).toBeGreaterThan(-1)
      const claudeWriteIdx = writeMock.mock.calls.findIndex((c) => typeof c[0] === 'string' && c[0].includes('claude '))
      expect(claudeWriteIdx).toBeGreaterThan(-1)
      expect(patchWriteIdx).toBeLessThan(claudeWriteIdx)
    } finally {
      _setTmuxArchiveResolverForTest(null)
    }
  })

  // Companion: when tier 1/2 already found tmux (no stage/push ever runs),
  // there is nothing to patch -- no patch write should appear at all.
  it('sends NO settings patch when tier 1/2 already found tmux (nothing to patch)', () => {
    driveToClaudeWrite('s-f3-no-patch-needed', 'setup ok {NONCE} tmux=/usr/bin/tmux\r\n')
    const patchWrite = writeMock.mock.calls.find((c) => {
      if (typeof c[0] !== 'string' || !c[0].startsWith('echo \'')) return false
      const m = c[0].match(/^echo '([A-Za-z0-9+\/=]+)' \| base64 -d \| node/)
      if (!m) return false
      const decoded = Buffer.from(m[1], 'base64').toString('utf8')
      return decoded.includes('CCC_TMUX_BIN=')
    })
    expect(patchWrite).toBeUndefined()
  })
})

// Direct unit coverage of parseTmuxStageSentinel, mirroring parseTmuxSentinel's
// own describe block below -- same three-way undefined/fail/ok discrimination
// and the same chunk-truncation defence.
const PURE_NONCE = 'purenonce123abc'
describe('parseTmuxStageSentinel (#242)', () => {
  it('returns undefined when the sentinel is absent from this chunk', () => {
    expect(parseTmuxStageSentinel('some unrelated PTY output\r\n', PURE_NONCE)).toBeUndefined()
  })

  it('returns { ok: true, path } for a valid ok sentinel carrying the right nonce', () => {
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} ok path=/home/dev/.claude/bin/tmux\r\n`, PURE_NONCE)).toEqual({
      ok: true,
      path: '/home/dev/.claude/bin/tmux',
    })
  })

  it('returns { ok: false, reason } for a fail sentinel carrying the right nonce', () => {
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} fail=terminfo\r\n`, PURE_NONCE)).toEqual({ ok: false, reason: 'terminfo' })
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} fail=digest\r\n`, PURE_NONCE)).toEqual({ ok: false, reason: 'digest' })
  })

  it('degrades an unsafe ok path to a failure rather than trusting it, even with the right nonce', () => {
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} ok path=-oProxyCommand=x\r\n`, PURE_NONCE)).toEqual({
      ok: false,
      reason: 'unsafe-path',
    })
  })

  // #242 finding F1(a), round-2 correction: a staged path outside
  // ~/.claude/bin -- absolute, no traversal, passes the pure charset
  // allowlist -- is no longer degraded to a failure HERE. This parser used
  // to also apply a path-pin (requiring the path end EXACTLY in
  // "/.claude/bin/tmux") as a security gate, removed because "ends with the
  // right suffix" is satisfiable from an attacker-writable directory and is
  // NOT equivalent to "really is under $HOME" -- see this function's own
  // doc comment. The path is kept for logging ONLY; the actual fix is that
  // buildTmuxLaunchCommand (ssh-tmux.ts) never reads it for a staged tier at
  // all (see the pty-manager-ssh-tmux.test.ts F1 describe block above for
  // the end-to-end proof that the reported path never reaches the launch
  // command regardless of what this parser returns).
  it('accepts a staged ok path outside ~/.claude/bin as PARSE-level ok (informational only -- the launch-command sink is what actually never uses it)', () => {
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} ok path=/tmp/.x/tmux\r\n`, PURE_NONCE)).toEqual({
      ok: true,
      path: '/tmp/.x/tmux',
    })
  })

  // #242 finding F1 (b): a sentinel with NO nonce, or the WRONG one, must
  // be indistinguishable from "not present in this chunk" -- undefined, not
  // a rejected-but-seen value.
  it('returns undefined (not a rejection) for a sentinel missing the nonce entirely', () => {
    expect(parseTmuxStageSentinel('ccc-tmux-stage ok path=/home/dev/.claude/bin/tmux\r\n', PURE_NONCE)).toBeUndefined()
  })

  it('returns undefined (not a rejection) for a sentinel carrying the WRONG nonce', () => {
    expect(parseTmuxStageSentinel(`ccc-tmux-stage wrongnonce ok path=/home/dev/.claude/bin/tmux\r\n`, PURE_NONCE)).toBeUndefined()
  })

  it('returns undefined for a sentinel truncated by a chunk boundary', () => {
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} ok path=/home/dev/.cla`, PURE_NONCE)).toBeUndefined()
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} fail=term`, PURE_NONCE)).toBeUndefined()
  })

  // M2 (adversarial review round 5): the fail=<reason> field is raw remote
  // output too -- an unbounded/garbage value must degrade rather than flow
  // verbatim into flow-state IPC and logs.
  it('degrades an unbounded/garbage fail reason to a bounded, charset-guarded placeholder', () => {
    const huge = 'a'.repeat(500)
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} fail=${huge}\r\n`, PURE_NONCE)).toEqual({
      ok: false,
      reason: 'invalid-reason',
    })
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} fail=has;metachar\r\n`, PURE_NONCE)).toEqual({
      ok: false,
      reason: 'invalid-reason',
    })
  })

  it('passes a real, short, lowercase-word fail reason through unchanged', () => {
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} fail=download\r\n`, PURE_NONCE)).toEqual({
      ok: false,
      reason: 'download',
    })
  })

  // #242 finding I5: the capture itself is now BOUNDED (\S{1,4096}), not
  // unbounded \S+ -- a multi-kilobyte path must not be accepted at all
  // (regex miss -> undefined), rather than being accepted and only capped
  // downstream. A within-cap path of realistic length still passes
  // normally. Mutation to prove this can fail: revert the capture groups
  // in parseTmuxStageSentinel's regex from `\S{1,4096}` back to `\S+` --
  // the first assertion below then fails (an 8000-char path parses as ok).
  it('rejects an ok path capture beyond the 4096-char cap outright (I5)', () => {
    const hugePath = '/' + 'a'.repeat(8000)
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} ok path=${hugePath}\r\n`, PURE_NONCE)).toBeUndefined()
    // A within-cap, realistic path still parses normally -- the cap does
    // not clip or otherwise mangle a real value.
    const okPath = '/' + 'a'.repeat(4000)
    expect(parseTmuxStageSentinel(`ccc-tmux-stage ${PURE_NONCE} ok path=${okPath}\r\n`, PURE_NONCE)).toEqual({
      ok: true,
      path: okPath,
    })
  })
})

// #242 round-3 adversarial review, MAJOR: the whole point of base64-wrapping
// buildTmuxStageCommand's output (ssh-tmux-stage.ts) is that the REAL
// parseTmuxStageSentinel, run against the REAL built command, must never
// match it -- regardless of how a terminal wraps the echoed line into
// fixed-width rows (the finding proved 80/100/120/132/160/200-column
// wrapping of the OLD plaintext builder produced a false match at several
// widths). This exercises both real functions together, not a re-derivation
// of either's logic.
describe('echo immunity: buildTmuxStageCommand vs. the real parseTmuxStageSentinel (#242 round-3 MAJOR)', () => {
  it('never satisfies parseTmuxStageSentinel when column-wrapped at any of the widths the finding proved exploitable', () => {
    const wire = buildTmuxStageCommand(PURE_NONCE)
    for (const width of [80, 100, 120, 132, 160, 200]) {
      let wrapped = ''
      for (let i = 0; i < wire.length; i += width) {
        wrapped += wire.slice(i, i + width) + '\r\n'
      }
      expect(parseTmuxStageSentinel(wrapped, PURE_NONCE)).toBeUndefined()
    }
  })

  // Mutation to prove the above can fail: feed the OLD (unwrapped, plaintext)
  // shape instead of the real buildTmuxStageCommand() -- reconstructed here
  // only as the shape the round-3 finding quoted verbatim, to show the SAME
  // column-wrapping loop DOES produce a match/false-fail against plaintext,
  // which is exactly why the real function must never emit that shape.
  it('[control] the same wrapping DOES defeat a plaintext (un-fixed) sentinel command, proving the loop is a real test', () => {
    const plaintext = `echo "ccc-tmux-stage ${PURE_NONCE} ok path=$HOME/.claude/bin/tmux"`
    let anyDefined = false
    for (const width of [80, 100, 120, 132, 160, 200]) {
      let wrapped = ''
      for (let i = 0; i < plaintext.length; i += width) {
        wrapped += plaintext.slice(i, i + width) + '\r\n'
      }
      if (parseTmuxStageSentinel(wrapped, PURE_NONCE) !== undefined) anyDefined = true
    }
    expect(anyDefined).toBe(true)
  })
})

// #242 round-3 MINOR: proceedAfterSetup's own staging-in-flight guard,
// exercised via the CONTAINER/postCommand flow -- a path with zero prior
// coverage in this file (every earlier tier-3 test drives the HOST flow via
// a bare `setup ok tmux=none` sentinel). writeContainerSetupCmd's only call
// site is launchClaude()'s `if (inInnerShell)` branch, which is already
// gated by launchClaude's own top-of-function staging guard -- so this
// documents that the container path respects the SAME invariant the host
// path does, even though (see the implementer's report) the specific
// cross-flow race the review described (container-completion firing while
// HOST staging is in flight) is not reachable through the public API: the
// two flows share one `currentFlowState` and `writeContainerSetupCmd` has
// no entry point other than the already-guarded launchClaude().
function driveToContainerStageWrite(sessionId: string): void {
  onDataListeners.length = 0
  spawnPty(fakeWin, sessionId, { ssh: { ...SSH, postCommand: 'enter-container' } } as never)
  writeMock.mockClear()
  feedPtyData('Welcome\r\n')
  vi.advanceTimersByTime(1500) // idle: connecting -> awaiting-postcommand
  getSshFlow(sessionId)!.runPostCommand()
  vi.advanceTimersByTime(300) // writePostCommand's 200ms write delay
  feedPtyData('user@container:~$ ') // inner shell prompt -> inInnerShell=true
  getSshFlow(sessionId)!.launchClaude() // inInnerShell -> writeContainerSetupCmd
  vi.advanceTimersByTime(300) // writeContainerSetupCmd's 300ms write delay
  feedPtyData(nonceSentinel(sessionId, 'setup ok {NONCE} tmux=none\r\n')) // containerSetupDone=true, tmux cleared
  vi.advanceTimersByTime(1500) // idle: container branch -> proceedAfterSetup -> writeTmuxStageCmd
  vi.advanceTimersByTime(300) // writeTmuxStageCmd's own 200ms write delay
}

describe('spawnPty SSH branch — tmux tier-3 staging via the container/postCommand flow (#242 round-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stages tmux via the container flow when postCommand is configured and tier 1/2 report tmux=none', () => {
    driveToContainerStageWrite('s-container-stage')
    expect(writeMock.mock.calls.some((c) => isStagingWrite(c[0]))).toBe(true)
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
  })

  it('a second Launch-Claude click while container staging is in flight writes nothing until the stage sentinel resolves', () => {
    driveToContainerStageWrite('s-container-stage-race')
    const writesWhileStaging = writeMock.mock.calls.length
    getSshFlow('s-container-stage-race')!.launchClaude()
    vi.advanceTimersByTime(300)
    expect(writeMock.mock.calls.length).toBe(writesWhileStaging)
    feedPtyData(nonceSentinel('s-container-stage-race', 'ccc-tmux-stage {NONCE} fail=download\r\n'))
    vi.advanceTimersByTime(300)
    const claudeWrites = writeMock.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrites).toHaveLength(1)
  })
})

// Config-modal redesign, item e (structured Runtime). The container hop used to
// be a free-text post-command the user typed ("sudo docker exec -it ccc bash");
// it is now a structured `SshRuntime` the APP composes via
// composeRuntimeCommand, and pty-manager keys the whole SSH ladder on the
// EFFECTIVE post-command -- `[ssh.postCommand, runtimeCmd].filter(Boolean).join(' && ')` --
// rather than on `ssh.postCommand`. That is the one behavioural claim worth
// pinning: a runtime-only config must drive the flow EXACTLY as the typed
// string did (idle-fallback -> awaiting-postcommand -> runPostCommand writes the
// composed command), and a config carrying BOTH must run the free-text prep
// first, then the runtime hop, in one write.
//
// Mutation to prove this can fail: revert either use site in pty-manager.ts --
// the idle-fallback gate at ~line 1503 (`if (postCommand)` back to
// `if (ssh.postCommand)`) or `const postCommand = ssh.postCommand` at ~line 1687.
// With the first reverted the runtime-only session advances to
// 'awaiting-claude' and runPostCommand() no-ops (nothing is ever written, the
// container is never entered, and claude silently runs on the HOST); with the
// second reverted the composed command is dropped from the write.
//
// Modelled on driveToContainerStageWrite above (same fakes/timers style); the
// only addition is a window that RECORDS the ssh:flowState emits, so the
// 'awaiting-postcommand' half of the claim is asserted directly instead of
// being inferred from runPostCommand's own state guard.
function makeFlowRecordingWin(): { win: never; states: Array<{ state: string; info?: string }> } {
  const states: Array<{ state: string; info?: string }> = []
  const win = {
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel.startsWith('ssh:flowState:')) states.push(payload as { state: string; info?: string })
      },
    },
    isDestroyed: () => false,
  } as never
  return { win, states }
}

const CCC_TEST_RUNTIME = { type: 'container' as const, container: 'ccc-test', sudo: true }

describe('spawnPty SSH branch — structured container Runtime drives the post-command flow (item e)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runtime-only (no postCommand) reaches awaiting-postcommand and writes the app-composed "sudo docker exec -it ccc-test bash"', () => {
    const sessionId = 's-runtime-container'
    const { win, states } = makeFlowRecordingWin()
    onDataListeners.length = 0
    spawnPty(win, sessionId, { ssh: { ...SSH, runtime: CCC_TEST_RUNTIME } } as never)
    writeMock.mockClear()
    feedPtyData('Welcome\r\n')
    vi.advanceTimersByTime(1500) // idle: connecting -> awaiting-postcommand
    expect(states.map((s) => s.state)).toContain('awaiting-postcommand')
    getSshFlow(sessionId)!.runPostCommand() // no-ops unless the state really is awaiting-postcommand
    vi.advanceTimersByTime(300) // writePostCommand's 200ms write delay
    const postWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('docker exec'))
    expect(postWrite).toBeDefined()
    // Exact, including the trailing CR: the app builds this whole line, so a
    // stray flag/quote/space regression is a defect, not a formatting nit.
    expect(postWrite![0] as string).toBe('sudo docker exec -it ccc-test bash\r')
  })

  it('postCommand AND runtime compose as "<prep> && <runtime>" in a single post-command write', () => {
    const sessionId = 's-runtime-with-prep'
    const { win, states } = makeFlowRecordingWin()
    onDataListeners.length = 0
    spawnPty(win, sessionId, { ssh: { ...SSH, postCommand: 'echo prep', runtime: CCC_TEST_RUNTIME } } as never)
    writeMock.mockClear()
    feedPtyData('Welcome\r\n')
    vi.advanceTimersByTime(1500)
    expect(states.map((s) => s.state)).toContain('awaiting-postcommand')
    getSshFlow(sessionId)!.runPostCommand()
    vi.advanceTimersByTime(300)
    const postWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('docker exec'))
    expect(postWrite).toBeDefined()
    expect(postWrite![0] as string).toBe('echo prep && sudo docker exec -it ccc-test bash\r')
  })

  // Fail-CLOSED, found reviewing this change: composeRuntimeCommand rejecting a
  // container name failed the flow, but nothing stopped the launch paths. The
  // failed overlay's own button is "Retry Launch" -> launchClaude(), which (with
  // inInnerShell false and setupSent false) walked the HOST ladder and started
  // claude on the bare host — the isolation the config asked for silently gone.
  // Unreachable through the dialog (it validates the same charset before saving)
  // but reachable from any hand-edited or older config file.
  //
  // Mutation to prove this can fail: drop the `if (runtimeInvalid)` guard from
  // launchClaude in pty-manager.ts — the host setup write reappears and the
  // second assertion fails.
  it('an INVALID container runtime fails the flow and refuses every launch path (no silent host fallback)', () => {
    const sessionId = 's-runtime-invalid'
    const { win, states } = makeFlowRecordingWin()
    onDataListeners.length = 0
    // `evil;name` fails CONTAINER_NAME_RE — composeRuntimeCommand throws.
    spawnPty(win, sessionId, { ssh: { ...SSH, runtime: { type: 'container', container: 'evil;name' } } } as never)
    writeMock.mockClear()
    expect(states.map((s) => s.info)).toContain('container runtime invalid')
    feedPtyData('Welcome\r\n')
    vi.advanceTimersByTime(1500)
    // The auto-ladder never advances out of 'failed', so no stage is chained.
    expect(states.map((s) => s.state)).not.toContain('awaiting-postcommand')
    expect(states.map((s) => s.state)).not.toContain('awaiting-claude')
    // ...and the overlay's own "Retry Launch" writes NOTHING: no host setup, no
    // claude, and above all no container command built from the rejected name.
    getSshFlow(sessionId)!.launchClaude()
    getSshFlow(sessionId)!.runPostCommand()
    vi.advanceTimersByTime(1500)
    expect(writeMock.mock.calls).toHaveLength(0)
    expect(states[states.length - 1]).toEqual({ state: 'failed', info: 'container runtime invalid' })
  })
})

// #242 round-3 REWORK finding (MAJOR): the container/postCommand flow
// re-sends the IDENTICAL setup script with the IDENTICAL nonce and
// sentinel shape as the host flow (see 'idle after container setup ok ->
// writing claudeCmd' in pty-manager.ts), so it carries the SAME
// split-chunk bug I1 fixed on the host branch -- and the earlier test
// suite proved only the host call site (pty-manager.ts:1914), leaving the
// container call site (pty-manager.ts:1935) free to regress silently. This
// mirrors 'sentinel split across PTY chunks (#242 finding I1)' above,
// driving the container branch via the same scaffolding
// driveToContainerStageWrite uses (spawn with postCommand -> inner-shell
// prompt -> launchClaude -> writeContainerSetupCmd), but feeds the
// setup-ok sentinel split across two chunks instead of whole.
//
// Mutation to prove this can fail: revert the container-setup-ok handler
// in pty-manager.ts (~line 1935) to parse `data` (the current chunk
// alone) instead of the buffered `combined` text -- chunk 2 alone
// ("th\r\n") never matches `setup ok <nonce> tmux=...` by itself, so
// containerSetupDone never latches with a resolved tmux class, and the
// eventual claude write stays bare (no ON_PATH_TMUX_BIN_EXPR wrap) --
// the assertion below then fails.
describe('spawnPty SSH branch — container-flow sentinel split across PTY chunks (#242 finding I1, round-3 rework)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('still wraps in tmux when the container setup-ok sentinel is split across two chunks', () => {
    const sessionId = 's-i1-container-split'
    onDataListeners.length = 0
    spawnPty(fakeWin, sessionId, { ssh: { ...SSH, postCommand: 'enter-container' } } as never)
    writeMock.mockClear()
    feedPtyData('Welcome\r\n')
    vi.advanceTimersByTime(1500) // idle: connecting -> awaiting-postcommand
    getSshFlow(sessionId)!.runPostCommand()
    vi.advanceTimersByTime(300) // writePostCommand's 200ms write delay
    feedPtyData('user@container:~$ ') // inner shell prompt -> inInnerShell=true
    getSshFlow(sessionId)!.launchClaude() // inInnerShell -> writeContainerSetupCmd
    vi.advanceTimersByTime(300) // writeContainerSetupCmd's 300ms write delay
    const nonce = _getSshNonceForTest(sessionId)!
    // The split lands mid-value, same shape as the host I1 repro -- chunk 1
    // ends inside the tmux= class token, chunk 2 carries the rest + newline.
    feedPtyData(`setup ok ${nonce} tmux=pa`)
    feedPtyData(`th\r\n`)
    // idle: container branch -> proceedAfterSetup -> writeClaudeCmd
    // (tmux=path is tier 1, found on PATH -- no tier-3 staging detour).
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300) // writeClaudeCmd's own 200ms write delay
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0] as string).toContain(`${ON_PATH_TMUX_BIN_EXPR} new-session -s ccc-${sessionId}`)
  })
})

// #242 round-3 MAJOR fix: this whole describe block is new. Every tier-4
// code path in pty-manager.ts (attemptTmuxPush, the arch-probe parse block,
// the push-sentinel handler, the fail=download+detectedArch trigger gate,
// the onProgress -> setFlowState forwarding, the abort/recovery path) had
// ZERO test coverage before this fix -- only the generic hook in
// pty-chunked-write.test.ts was exercised, never the wiring itself.
const FAKE_TMUX_ARCHIVE = Buffer.from('A'.repeat(2200))

/**
 * Drive the manual SSH flow past host setup, tier-3 staging (tmux=none),
 * the arch-probe reply, and a `fail=download` stage sentinel -- landing on
 * attemptTmuxPush() having been CALLED (pushSent flips true synchronously)
 * but its archive-resolver promise NOT YET settled. Deliberately does not
 * flush microtasks -- callers install a stubbed resolver and/or a custom
 * writeMock implementation BEFORE the first push chunk write fires by
 * calling `await flushMicrotasks()` themselves.
 */
function driveToPushAttempt(sessionId: string): void {
  onDataListeners.length = 0
  spawnPty(fakeWin, sessionId, { ssh: SSH } as never)
  writeMock.mockClear()
  getSshFlow(sessionId)!.launchClaude()
  vi.advanceTimersByTime(300) // past writeHostSetupCmd's 200ms setup write
  feedPtyData(nonceSentinel(sessionId, 'setup ok {NONCE} tmux=none\r\n'))
  vi.advanceTimersByTime(1500) // idle fallback -> proceedAfterSetup -> writeTmuxStageCmd scheduled
  vi.advanceTimersByTime(300) // writeTmuxStageCmd's own 200ms write delay: arch probe + stage write
  feedPtyData('ccc-tmux-push-arch Linux-x86_64\r\n') // resolves detectedArch before the stage sentinel
  feedPtyData(nonceSentinel(sessionId, 'ccc-tmux-stage {NONCE} fail=download\r\n')) // triggers attemptTmuxPush (pushSent=true)
}

describe('spawnPty SSH branch — tmux tier-4 push (#242 round-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    _setTmuxArchiveResolverForTest(null)
    writeMock.mockReset()
  })

  // Acceptance (d), first half: the item specifies the push trigger is
  // `stageResult.reason === 'download' && detectedArch` -- BOTH conditions.
  // Mutation to prove this can fail: drop the `&& detectedArch` half of that
  // gate in pty-manager.ts -- attemptTmuxPush would then run with a null
  // arch, and pushActivityDetected() below would flip true.
  it('does not attempt a push when the arch probe never resolved, even on fail=download', async () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-push-noarch', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-push-noarch')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-push-noarch', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    // No arch-probe reply fed -- detectedArch stays null.
    feedPtyData(nonceSentinel('s-push-noarch', 'ccc-tmux-stage {NONCE} fail=download\r\n'))
    vi.advanceTimersByTime(300)
    expect(pushActivityDetected()).toBe(false)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0]).not.toMatch(/new-session\s+-s\s+ccc-/)
  })

  // Acceptance (d), second half: a stage failure for any reason OTHER than
  // 'download' must never trigger a push, even with arch already known.
  // Mutation to prove this can fail: drop the `stageResult.reason ===
  // 'download'` half of the gate -- attemptTmuxPush would then also run on
  // fail=terminfo, and pushActivityDetected() below would flip true.
  it('does not attempt a push when the stage failure reason is not "download", even with arch known', async () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-push-wrongreason', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-push-wrongreason')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-push-wrongreason', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    feedPtyData('ccc-tmux-push-arch Linux-x86_64\r\n')
    feedPtyData(nonceSentinel('s-push-wrongreason', 'ccc-tmux-stage {NONCE} fail=terminfo\r\n'))
    vi.advanceTimersByTime(300)
    expect(pushActivityDetected()).toBe(false)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0]).not.toMatch(/new-session\s+-s\s+ccc-/)
  })

  // Acceptance (a): push chunk writes are issued, and no 'claude ' write
  // occurs while they're still in flight.
  it('pushes archive bytes down the PTY once arch is known and staging fails with fail=download, writing no claude command until the push resolves', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    driveToPushAttempt('s-push-happy')
    await flushMicrotasks() // resolver's .then() runs; first chunk write fires synchronously inside it
    expect(pushActivityDetected()).toBe(true)
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
    await vi.advanceTimersByTimeAsync(5000) // drain every remaining chunk write
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
  })

  // Acceptance (b): getSshFlow(id).getState() reports running-setup with a
  // 'staging tmux NN%' info string during the transfer -- the onProgress ->
  // setFlowState forwarding the item specifies.
  it('reports running-setup with a "staging tmux NN%" info string while the transfer is in flight', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    driveToPushAttempt('s-push-progress')
    await flushMicrotasks() // first chunk write + its onProgress call land here
    const state = getSshFlow('s-push-progress')!.getState()
    expect(state.state).toBe('running-setup')
    expect(state.info).toMatch(/^staging tmux \d+%$/)
  })

  // Acceptance (c), first half: `ccc-tmux-stage ok path=...` after a
  // completed push produces a tmux-wrapped claude launch.
  it('wraps the eventual claude launch in tmux when the push sentinel reports ok path=...', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    driveToPushAttempt('s-push-ok')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(5000) // drain the full transfer
    feedPtyData(nonceSentinel('s-push-ok', 'ccc-tmux-stage {NONCE} ok path=/home/dev/.claude/bin/tmux\r\n'))
    await vi.advanceTimersByTimeAsync(300) // writeClaudeCmd's own 200ms write delay
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    // #242 finding F1(a), round-2 correction: same fixed-$HOME rule as tier
    // 3 -- see STAGED_TMUX_BIN_EXPR (ssh-tmux.ts).
    expect((claudeWrite![0] as string)).toContain('"$HOME"/.claude/bin/tmux new-session -s ccc-s-push-ok')
  })

  // Acceptance (c), second half: `fail=...` after a completed push produces
  // the bare (unwrapped) claude launch.
  it('falls through to the unwrapped launch when the push sentinel reports fail=terminfo', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    driveToPushAttempt('s-push-fail')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(5000)
    feedPtyData(nonceSentinel('s-push-fail', 'ccc-tmux-stage {NONCE} fail=terminfo\r\n'))
    await vi.advanceTimersByTimeAsync(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect((claudeWrite![0] as string)).not.toMatch(/new-session\s+-s\s+ccc-/)
  })

  // #242 round-3 MAJOR fix. Modeled on the tier-3 "second Launch-Claude
  // click while staging is in flight" test above -- same hazard, the tier-4
  // version: a click landing mid-transfer must write nothing containing
  // 'claude ' until the push's own sentinel/timeout resolves it. Mutation to
  // prove this can fail: remove the `if (pushSent && !pushDone) return`
  // guard from proceedAfterSetup/flowController.launchClaude -- the
  // mid-transfer click then falls through to writeClaudeCmd(), and the
  // assertion right after the click fails.
  it('a Launch-Claude click while a tier-4 push is in flight writes nothing containing "claude " until the push sentinel resolves', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    driveToPushAttempt('s-push-race')
    await flushMicrotasks()
    expect(pushActivityDetected()).toBe(true)
    getSshFlow('s-push-race')!.launchClaude()
    // 300ms clears writeClaudeCmd's own 200ms write delay -- long enough
    // that an unguarded click WOULD have landed its write by now, but far
    // short of the full ~200ms-per-18-chunks transfer still in flight.
    await vi.advanceTimersByTimeAsync(300)
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    feedPtyData(nonceSentinel('s-push-race', 'ccc-tmux-stage {NONCE} ok path=/home/dev/.claude/bin/tmux\r\n'))
    await vi.advanceTimersByTimeAsync(300)
    const claudeWrites = writeMock.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrites).toHaveLength(1)
  })

  // #242 round-3 MINOR fix: an aborted transfer (a write throws mid-push)
  // must restore echo and drop the partial accumulator file before falling
  // through to the bare launch -- not leave the remote at `stty -echo`
  // babysitting a dangling temp file. Mutation to prove this can fail:
  // revert attemptTmuxPush's onDone to the pre-fix shape (always call
  // armPushSentinelTimeout(), no completed/bytesLanded check) -- the
  // recovery-line lookup below then finds nothing (`recovery` stays
  // undefined) and the `.toBeDefined()` assertion fails.
  //
  // #242 finding F2 (adversarial review round 4, MAJOR): the ORIGINAL
  // version of this test only asserted the recovery string was WRITTEN,
  // never that it can EXECUTE -- and passed against the pre-fix code, which
  // wrote the recovery text straight after an aborted chunk line with no
  // interrupt in between. The chunk lines are `echo '<base64...>' >> "$PATH"`
  // -- a single quote opened but not yet closed when the write throws
  // mid-transfer -- so the remote line discipline is left mid-string, and
  // both the recovery command and the eventual `claude ...` write become
  // literal content inside that still-open quote rather than executable
  // shell text.
  //
  // Verifying this requires modeling what the remote TTY's line discipline
  // actually does with a Ctrl-C (see applyLineDiscipline above), applied
  // ONLY to the bytes that actually reached the remote -- the mock throws
  // on write #3 (index 2, once the mock is cleared just below so indices
  // align 1:1 with the local `n` counter), so those bytes never landed and
  // must be excluded before concatenating. Counting single quotes in the
  // SURVIVING text after that discard is what tells us whether the remote
  // is left inside an open string:
  //   - pre-fix (no `\x03`): the partial `echo '...` line's lone opening
  //     quote survives untouched -- ODD count.
  //   - post-fix: `\x03` is sent BEFORE the recovery text, discarding the
  //     partial line (and its unmatched quote) back to the last completed
  //     line -- EVEN count.
  // Mutation to prove this can fail: remove the `ptyProcess.write('\x03')`
  // call from attemptTmuxPush's onDone abort branch -- `quoteCount % 2`
  // below then evaluates to 1, and the `.toBe(0)` assertion fails.
  it('restores echo and removes the partial accumulator file when a push write throws mid-transfer, in a way the remote can actually EXECUTE', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    driveToPushAttempt('s-push-abort')
    writeMock.mockClear() // isolate indices to the push phase below
    let n = 0
    writeMock.mockImplementation(() => {
      n++
      if (n === 3) throw new Error('ERR_STREAM_DESTROYED')
    })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(100)

    const recovery = writeMock.mock.calls.map((c) => c[0]).find((w) => typeof w === 'string' && w.includes('stty echo') && w.includes('rm -f'))
    expect(recovery).toBeDefined()
    expect(recovery).toContain('PUSH_ACCUMULATOR_PATH')

    // Only the writes that actually reached the remote -- call #3 (index 2,
    // 0-indexed) threw, so its bytes never landed.
    const succeeded = writeMock.mock.calls
      .filter((_, idx) => idx !== 2)
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .join('')
    const surviving = applyLineDiscipline(succeeded)
    const quoteCount = (surviving.match(/'/g) || []).length
    expect(quoteCount % 2).toBe(0)

    await vi.advanceTimersByTimeAsync(300) // writeClaudeCmd's own 200ms write delay
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect((claudeWrite![0] as string)).not.toMatch(/new-session\s+-s\s+ccc-/)
  })

  // #242 finding F1 (adversarial review round 4, BLOCKER): the tier-4
  // host-side DOWNLOAD phase (host-side fetch/cache-lookup of the archive,
  // before a single chunk is written) had no timeout at all --
  // armPushSentinelTimeout is reached only from runChunkedWrite's onDone,
  // which never fires if the resolver itself never settles. A resolver that
  // hangs forever (a stalled HTTPS response, in production) left the
  // session permanently wedged with claude never launched -- the opposite of
  // attemptTmuxPush's own doc comment ("never a NEW way for the flow to get
  // stuck with claude never launched"). Mutation to prove this can fail:
  // remove the `downloadTimeoutHandle` arm from attemptTmuxPush (or its
  // clear in destroy()/`.then()`/`.catch()`, irrelevant here since destroy()
  // is never called in this test) -- advancing fake timers, even well past
  // the 45s DOWNLOAD_TIMEOUT_MS used below, then produces zero writes
  // containing 'claude ' and getState().state never reaches 'running-claude'.
  it('falls through to the bare claude launch after the download-phase timeout when the archive resolver never settles', async () => {
    _setTmuxArchiveResolverForTest(() => new Promise(() => { /* never settles -- simulates a stalled HTTPS response */ }))
    driveToPushAttempt('s-push-download-hang')
    await flushMicrotasks()
    // Click #1 while the "download" is hung -- the existing in-flight guard
    // (pushSent && !pushDone) must swallow it, same as a click mid-transfer.
    getSshFlow('s-push-download-hang')!.launchClaude()
    await vi.advanceTimersByTimeAsync(40000) // < DOWNLOAD_TIMEOUT_MS (45000)
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('claude '))).toBe(false)
    expect(getSshFlow('s-push-download-hang')!.getState().state).not.toBe('running-claude')
    // Click #2, still hung, still swallowed.
    getSshFlow('s-push-download-hang')!.launchClaude()
    await vi.advanceTimersByTimeAsync(10000) // crosses DOWNLOAD_TIMEOUT_MS (+ writeClaudeCmd's own 200ms write delay)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect((claudeWrite![0] as string)).not.toMatch(/new-session\s+-s\s+ccc-/)
    expect(getSshFlow('s-push-download-hang')!.getState().state).toBe('running-claude')
  })

  // M3 (adversarial review round 5): attemptTmuxPush's isAlive/stillLive
  // checks were keyed ONLY on the ptySessions identity, not on the flow's
  // own `destroyed` flag -- reachable via a DIRECT `getSshFlow(id).destroy()`
  // call (not through killPty, which deletes the ptySessions entry in the
  // SAME synchronous frame it destroys the flow -- that's caller
  // discipline, not an invariant the push loop itself enforced). This test
  // calls flowController.destroy() directly, leaving the ptySessions entry
  // untouched, and asserts no further push chunk lands afterward.
  it('a direct flowController.destroy() (bypassing killPty) stops the in-flight push from writing further chunks', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    driveToPushAttempt('s-push-direct-destroy')
    await flushMicrotasks() // first chunk write fires
    expect(pushActivityDetected()).toBe(true)
    const writesBeforeDestroy = writeMock.mock.calls.length
    // Bypasses killPty deliberately -- ptySessions.get('s-push-direct-destroy')
    // still resolves to the SAME ptyProcess this push is writing to.
    getSshFlow('s-push-direct-destroy')!.destroy()
    await vi.advanceTimersByTimeAsync(5000) // would drain the rest of the transfer if unguarded
    expect(writeMock.mock.calls.length).toBe(writesBeforeDestroy)
  })
})

describe('parseTmuxSentinel (#242)', () => {
  it('returns undefined when the tmux field is absent from this chunk', () => {
    expect(parseTmuxSentinel('some unrelated PTY output\r\n', PURE_NONCE)).toBeUndefined()
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE}\r\n`, PURE_NONCE)).toBeUndefined()
  })

  it('returns null for an explicit tmux=none', () => {
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE} tmux=none\r\n`, PURE_NONCE)).toBeNull()
  })

  it('returns "path" for tier 1 (found on PATH)', () => {
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE} tmux=path\r\n`, PURE_NONCE)).toBe('path')
  })

  it('returns "home" for tier 2 (pre-existing ~/.claude/bin/tmux)', () => {
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE} tmux=home\r\n`, PURE_NONCE)).toBe('home')
  })

  // #242 round-3 correction (I3): the field is a fixed 3-way enum now -- a
  // value outside path/home/none simply fails to match (same as "not
  // present"), because the regex alternation IS the allowlist. There is no
  // longer a captured free-text value for isSafeTmuxBin/isPinnedTmuxPath to
  // validate (both deleted along with the wire-reported path they used to
  // gate -- see ssh-tmux.test.ts).
  it('returns undefined (not a rejection) for any value outside the path/home/none enum, even with a valid nonce', () => {
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE} tmux=-oProxyCommand=x\r\n`, PURE_NONCE)).toBeUndefined()
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE} tmux=/usr/bin/tmux\r\n`, PURE_NONCE)).toBeUndefined()
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE} tmux=tmux\r\n`, PURE_NONCE)).toBeUndefined()
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE} tmux=../../tmp/evil\r\n`, PURE_NONCE)).toBeUndefined()
  })

  // #242 finding I2 correction: no nonce, or the wrong one, is "not present
  // in this chunk" (undefined) for BOTH the class read AND (per pty-manager's
  // onData handler) the outer completion latch -- not a rejected-but-seen
  // value, and not something that can complete setup on its own.
  it('returns undefined (not a rejection) for a sentinel missing the nonce entirely', () => {
    expect(parseTmuxSentinel('setup ok tmux=path\r\n', PURE_NONCE)).toBeUndefined()
  })

  it('returns undefined (not a rejection) for a sentinel carrying the WRONG nonce', () => {
    expect(parseTmuxSentinel('setup ok wrongnonce tmux=path\r\n', PURE_NONCE)).toBeUndefined()
  })

  // #242 finding I1: a chunk boundary landing inside the class token, or
  // mid-nonce, must NOT match a truncated read -- the end-to-end buffering
  // fix (pty-manager's onData handler) is what makes the LATER chunk get
  // re-parsed against the accumulated text; this pure function's own
  // contract is simply "no match yet" for a chunk ending before the line's
  // terminator.
  it('returns undefined for a class token truncated by a chunk boundary (no trailing terminator)', () => {
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE} tmux=pa`, PURE_NONCE)).toBeUndefined()
  })

  it('returns undefined for a nonce truncated by a chunk boundary', () => {
    const mid = Math.floor(PURE_NONCE.length / 2)
    expect(parseTmuxSentinel(`setup ok ${PURE_NONCE.slice(0, mid)}`, PURE_NONCE)).toBeUndefined()
  })
})

// #242 tier 5. Two things this block locks down that no earlier #242 test
// did:
//   (b) a tier-3/4 failure reason reaches the renderer over the ACTUAL
//       `ssh:flowState:<sessionId>` IPC channel (win.webContents.send) --
//       every earlier test in this file asserted the reason via
//       getSshFlow(id).getState(), which is a real code path (the overlay's
//       catch-up poll uses it) but not the PUSH channel a mounted overlay is
//       actually listening on. A regression that stopped calling
//       emitSshFlowState (or started swallowing its throw silently) would
//       leave getState() correct while the renderer never hears about it --
//       exactly the gap this guards.
//   (a) SSHOptions.reconnect actually reaches the written claude command as
//       `--continue`, gated on tmux NOT being in play, end to end through
//       spawnPty (not just the pure buildSshClaudeFlags unit tested in
//       ssh-tmux.test.ts).
function makeSpyWin(): { win: unknown; sends: Array<{ channel: string; state: string; info?: string }> } {
  const sends: Array<{ channel: string; state: string; info?: string }> = []
  const win = {
    webContents: {
      send: (channel: string, msg: { state: string; info?: string }) => {
        sends.push({ channel, state: msg.state, info: msg.info })
      },
    },
    isDestroyed: () => false,
  }
  return { win, sends }
}

describe('spawnPty SSH branch — tier-failure reasons reach the renderer over ssh:flowState (#242 tier 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Mutation to prove this can fail: have the tier-3 stage-fail branch call
  // setFlowState directly (bypassing writeClaudeCmd's emit) or drop the
  // reason argument -- the assertion below finds no matching send.
  it('emits ssh:flowState:<id> carrying the tmux-stage-fail reason', () => {
    const { win, sends } = makeSpyWin()
    onDataListeners.length = 0
    spawnPty(win as never, 's-flowstate-stagefail', { ssh: SSH } as never)
    getSshFlow('s-flowstate-stagefail')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-flowstate-stagefail', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-flowstate-stagefail', 'ccc-tmux-stage {NONCE} fail=terminfo\r\n'))
    vi.advanceTimersByTime(300)
    const hit = sends.find(
      (s) => s.channel === 'ssh:flowState:s-flowstate-stagefail' && s.state === 'running-claude',
    )
    expect(hit).toBeDefined()
    expect(hit!.info).toBe('tmux-stage-fail:terminfo')
  })

  it('emits ssh:flowState:<id> carrying the tmux-push-fail reason', async () => {
    _setTmuxArchiveResolverForTest(async () => FAKE_TMUX_ARCHIVE)
    const { win, sends } = makeSpyWin()
    onDataListeners.length = 0
    spawnPty(win as never, 's-flowstate-pushfail', { ssh: SSH } as never)
    getSshFlow('s-flowstate-pushfail')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-flowstate-pushfail', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    feedPtyData('ccc-tmux-push-arch Linux-x86_64\r\n')
    feedPtyData(nonceSentinel('s-flowstate-pushfail', 'ccc-tmux-stage {NONCE} fail=download\r\n'))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(5000)
    feedPtyData(nonceSentinel('s-flowstate-pushfail', 'ccc-tmux-stage {NONCE} fail=terminfo\r\n'))
    await vi.advanceTimersByTimeAsync(300)
    const hit = sends.find(
      (s) => s.channel === 'ssh:flowState:s-flowstate-pushfail' && s.state === 'running-claude',
    )
    expect(hit).toBeDefined()
    expect(hit!.info).toBe('tmux-push-fail:terminfo')
    _setTmuxArchiveResolverForTest(null)
  })
})

describe('spawnPty SSH branch — SSHOptions.reconnect drives --continue on the bare launch (#242 tier 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Mutation to prove this can fail: drop the buildSshClaudeFlags call (or
  // its `!!ssh.reconnect`) from writeClaudeCmd -- the written command would
  // never contain '--continue'.
  it('writes --continue on the bare launch when reconnect is true and tmux staging fails', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-reconnect-bare', { ssh: { ...SSH, reconnect: true } } as never)
    writeMock.mockClear()
    getSshFlow('s-reconnect-bare')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-reconnect-bare', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-reconnect-bare', 'ccc-tmux-stage {NONCE} fail=terminfo\r\n'))
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0]).toContain('--continue')
    expect(claudeWrite![0]).not.toMatch(/new-session\s+-s\s+ccc-/)
  })

  // Mutation to prove this can fail: drop the `tmuxInPlay` gate inside
  // buildSshClaudeFlags (see ssh-tmux.test.ts for the isolated version of
  // this) -- here it additionally proves pty-manager actually WIRES
  // `tmuxWrapped` (the real outcome of the wrap attempt) through, not just
  // that the pure helper itself is correct.
  it('routes --continue into the tmux wrapper fresh-create branch only when reconnect is true and tmux IS in play', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-reconnect-tmux', { ssh: { ...SSH, reconnect: true } } as never)
    writeMock.mockClear()
    getSshFlow('s-reconnect-tmux')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-reconnect-tmux', 'setup ok {NONCE} tmux=path\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    const written = claudeWrite![0] as string
    expect(written).toContain('new-session -s ccc-s-reconnect-tmux')
    // Item 6: a LIVE reattach (`attach -t X` before its `|| <fresh>` backstop)
    // carries no --continue -- relaunching a running claude would be wrong.
    // Every fresh-create (the attach fallback AND the else) resumes with it.
    expect(written).toContain('attach -t ccc-s-reconnect-tmux || ')
    expect(written).not.toMatch(/attach -t ccc-s-reconnect-tmux --continue/)
    const creates = written.split('new-session -s ccc-s-reconnect-tmux ').slice(1)
    expect(creates.length).toBe(2)
    for (const c of creates) expect(c.startsWith(`'`)).toBe(true)
    expect(written).toContain('--continue')
  })

  // Mutation to prove this can fail: drop the `reconnect` gate itself (add
  // --continue unconditionally whenever tmux is unavailable) -- a session's
  // FIRST-ever connect (reconnect false/absent) would wrongly get
  // --continue even though there is no prior conversation.
  it('does NOT write --continue on a first connect (no reconnect flag) even when tmux staging fails', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-firstconnect-bare', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-firstconnect-bare')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-firstconnect-bare', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-firstconnect-bare', 'ccc-tmux-stage {NONCE} fail=terminfo\r\n'))
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite![0]).not.toContain('--continue')
  })
})


// SSH tmux enhancement (item 10): parseSetupAccountSentinel -- decode the
// nonce'd `acct=<base64email>` field, gate it to a display-valid email, and
// treat anything else as untrusted-for-display (dropped, not passed through).
describe('parseSetupAccountSentinel (item 10)', () => {
  const NONCE = 'abc123'
  const b64 = (v: string) => Buffer.from(v, 'utf-8').toString('base64')
  it('decodes a valid email from a full nonce-bearing sentinel', () => {
    const line = `setup ok ${NONCE} tmux=path acct=${b64('dev@example.com')}\r\n`
    expect(parseSetupAccountSentinel(line, NONCE)).toBe('dev@example.com')
  })
  it('works with tmux=none and tmux=home too', () => {
    expect(parseSetupAccountSentinel(`setup ok ${NONCE} tmux=none acct=${b64('a@b.co')}\r\n`, NONCE)).toBe('a@b.co')
    expect(parseSetupAccountSentinel(`setup ok ${NONCE} tmux=home acct=${b64('a@b.co')}\r\n`, NONCE)).toBe('a@b.co')
  })
  it('returns undefined when the account field is absent (back-compat sentinel)', () => {
    expect(parseSetupAccountSentinel(`setup ok ${NONCE} tmux=path\r\n`, NONCE)).toBeUndefined()
  })
  it('returns undefined for an empty acct field', () => {
    expect(parseSetupAccountSentinel(`setup ok ${NONCE} tmux=path acct=\r\n`, NONCE)).toBeUndefined()
  })
  it('drops a decoded value that is not a display-valid email (untrusted-for-display)', () => {
    // A hostile host trying to plant markup / a control sequence in the label.
    const evil = `setup ok ${NONCE} tmux=path acct=${b64('<img src=x onerror=alert(1)>')}\r\n`
    expect(parseSetupAccountSentinel(evil, NONCE)).toBeUndefined()
    const ctrl = `setup ok ${NONCE} tmux=path acct=${b64('a@b.co\x07;rm -rf')}\r\n`
    expect(parseSetupAccountSentinel(ctrl, NONCE)).toBeUndefined()
  })
  it('requires the correct nonce (spoof-resistant)', () => {
    const line = `setup ok WRONGNONCE tmux=path acct=${b64('dev@example.com')}\r\n`
    expect(parseSetupAccountSentinel(line, NONCE)).toBeUndefined()
  })
  it('requires the full line terminator (no partial-chunk match)', () => {
    const partial = `setup ok ${NONCE} tmux=path acct=${b64('dev@example.com')}`
    expect(parseSetupAccountSentinel(partial, NONCE)).toBeUndefined()
  })
  it('caps length -- an over-long decoded value is dropped', () => {
    const long = `setup ok ${NONCE} tmux=path acct=${b64('a'.repeat(300) + '@b.co')}\r\n`
    expect(parseSetupAccountSentinel(long, NONCE)).toBeUndefined()
  })
})

// ===========================================================================
// Adversarial-review regression tests (2026-08-18). Every block below pins a
// fix for a finding the mutation lens proved had NO failing-capable test:
// restart-race flow poisoning (BLOCKER), the in-band cleanup / gracefulExit
// self-injection into the tmux-wrapped Claude pane, end-target lifecycle, and
// the Windows staging gate.
// ===========================================================================
describe('spawnPty SSH branch — handlePtyExit + restart-race guard (adversarial review, BLOCKER)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('a STALE PTY exit from a restarted session does NOT poison the new flow', () => {
    onDataListeners.length = 0
    const i0 = ptyInstances.length
    // spawn A, then the renderer restart: kill A + respawn B with the SAME id.
    spawnPty(fakeWin, 's-restart', { ssh: SSH } as never)
    const flowA = getSshFlow('s-restart')
    killPty('s-restart')
    spawnPty(fakeWin, 's-restart', { ssh: SSH } as never)
    const flowB = getSshFlow('s-restart')
    expect(flowB).toBeDefined()
    expect(flowB).not.toBe(flowA)
    expect(flowB!.getState().state).toBe('connecting')
    // The OLD ssh finally dies (~400ms later in prod). Its exit must NOT reach
    // the new flow: ptySessions[s-restart] now points at B, so weAreCurrent is
    // false and handlePtyExit is skipped. Before the fix this flipped B to
    // failed('connection') and the overlay's only escape (Retry) re-raced it.
    ptyInstances[i0].__fireExit(0)
    expect(flowB!.getState().state).toBe('connecting')
    expect(flowB!.getState().info).not.toBe('connection')
  })

  it('a GENUINE PTY exit before claude-running emits failed(connection) so the overlay can Retry', () => {
    onDataListeners.length = 0
    const idx = ptyInstances.length
    spawnPty(fakeWin, 's-drop', { ssh: SSH } as never)
    const flow = getSshFlow('s-drop')!
    expect(flow.getState().state).toBe('connecting')
    ptyInstances[idx].__fireExit(255)
    // Captured ref survives the cleanup that follows in the same onExit.
    expect(flow.getState()).toEqual({ state: 'failed', info: 'connection' })
  })

  it('does NOT emit failed() when the flow already reached a terminal state (skipped)', () => {
    onDataListeners.length = 0
    const idx = ptyInstances.length
    spawnPty(fakeWin, 's-skip', { ssh: SSH } as never)
    const flow = getSshFlow('s-skip')!
    flow.skip()
    expect(flow.getState().state).toBe('skipped')
    ptyInstances[idx].__fireExit(0)
    expect(flow.getState().state).toBe('skipped')
  })
})

describe('killPty / gracefulExitPty — a tmux-persistent remote is DETACHED, never destroyed (adversarial review)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('killPty on a tmux-PERSISTENT SSH session writes NO in-band `rm` into the live Claude pane (detach only)', () => {
    driveToClaudeWrite('s-persist-close', 'setup ok {NONCE} tmux=path\r\n')
    // Confirm the launch actually wrapped in tmux (so the session is persistent).
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('has-session -t ccc-s-persist-close'))).toBe(true)
    writeMock.mockClear()
    killPty('s-persist-close')
    // The destructive `rm -f ~/.claude/...` would land in Claude's composer and
    // stay pre-typed in a session the user chose to leave running.
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('rm -f'))).toBe(false)
  })

  it('killPty on a NON-persistent SSH session still sweeps its sidecars in-band (unchanged behaviour)', () => {
    driveToClaudeWrite('s-nonpersist-close', 'setup ok {NONCE} tmux=none\r\n')
    // tmux=none -> staging fails (helper) -> bare launch, so NOT persistent.
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('has-session'))).toBe(false)
    writeMock.mockClear()
    killPty('s-nonpersist-close')
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('rm -f'))).toBe(true)
  })

  it('gracefulExitPty DETACHES a tmux-persistent SSH session (no ESC/Ctrl-C/`/exit`) so the remote survives app quit', () => {
    driveToClaudeWrite('s-persist-quit', 'setup ok {NONCE} tmux=path\r\n')
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('has-session'))).toBe(true)
    writeMock.mockClear()
    const idx = ptyInstances.length - 1
    void gracefulExitPty('s-persist-quit', 5000)
    // No exit-key sequence at all -- the fix kills the local PTY instead.
    vi.advanceTimersByTime(500)
    const wroteExitSeq = writeMock.mock.calls.some((c) => typeof c[0] === 'string' && (c[0].includes('/exit') || c[0] === '\x1b' || c[0] === '\x03'))
    expect(wroteExitSeq).toBe(false)
    // Resolve the pending promise (the fix's kill() is a no-op in the mock).
    ptyInstances[idx].__fireExit(0)
  })
})

describe('endSshRemote target lifecycle — survives a drop, cleared on deliberate close (adversarial review)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('captures the end-target at spawn, KEEPS it across a natural PTY exit (so End works after a drop), and drops it only on killPty', () => {
    onDataListeners.length = 0
    const idx = ptyInstances.length
    spawnPty(fakeWin, 's-endtarget', { ssh: SSH } as never)
    expect(_hasSshTargetForTest('s-endtarget')).toBe(true)
    // A transient drop (natural exit): cleanupSessionResources runs, but the
    // target must SURVIVE -- otherwise a later "End remote" is a silent no-op.
    ptyInstances[idx].__fireExit(255)
    expect(_hasSshTargetForTest('s-endtarget')).toBe(true)
    // Deliberate close drops it.
    killPty('s-endtarget')
    expect(_hasSshTargetForTest('s-endtarget')).toBe(false)
  })

  // #572 one hop deeper: End also has to reach INSIDE a container runtime, so
  // the SAME spawn-time capture carries the structured runtime and the sudo
  // password alongside the connection target.
  it('captures the structured container runtime AND the sudo password at spawn', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-endtarget-ctr', {
      ssh: { ...SSH, runtime: { type: 'container', engine: 'podman', container: 'ccc-test', sudo: true }, sudoPassword: 'sudo-pw' },
    } as never)
    const t = _getSshTargetForTest('s-endtarget-ctr')
    expect(t?.runtime).toEqual({ type: 'container', engine: 'podman', container: 'ccc-test', sudo: true })
    expect(t?.sudoPassword).toBe('sudo-pw')
    killPty('s-endtarget-ctr')
    expect(_getSshTargetForTest('s-endtarget-ctr')).toBeUndefined()
  })

  it('a plain host session captures no runtime and no sudo password', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-endtarget-plain', { ssh: SSH } as never)
    const t = _getSshTargetForTest('s-endtarget-plain')
    expect(t?.runtime).toBeUndefined()
    expect(t?.sudoPassword).toBeUndefined()
    killPty('s-endtarget-plain')
  })

  // ADR-009, the End half of the legacy-docker gap: without an effective
  // runtime these sessions captured `runtime: undefined`, so
  // buildContainerKillCommand returned '' and their claude orphaned inside the
  // container forever — #572, still open for exactly the population that had
  // been entering containers the longest.
  // Mutation to prove this can fail: capture `ssh.runtime` instead.
  it('a LEGACY docker post-command captures a DERIVED container runtime so End can reach inside', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-endtarget-legacy', {
      ssh: { ...SSH, postCommand: 'sudo docker exec -it ccc-test bash' },
    } as never)
    const t = _getSshTargetForTest('s-endtarget-legacy')
    expect(t?.runtime).toEqual({ type: 'container', engine: 'docker', container: 'ccc-test', mode: 'exec', sudo: true })
    expect(buildContainerKillCommand('s-endtarget-legacy', t?.runtime)).toContain(
      "docker exec ccc-test bash -c '",
    )
    killPty('s-endtarget-legacy')
  })

  it('a structured runtime always WINS over a docker-shaped post-command', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-endtarget-both', {
      ssh: {
        ...SSH,
        postCommand: 'sudo docker exec -it decoy bash',
        runtime: { type: 'container', engine: 'podman', container: 'real-one' },
      },
    } as never)
    expect(_getSshTargetForTest('s-endtarget-both')?.runtime).toEqual({ type: 'container', engine: 'podman', container: 'real-one' })
    killPty('s-endtarget-both')
  })
})

// ===========================================================================
// Follow-up adversarial pass (2026-08-18) — regression tests for two fixes:
//
//  1. The wrapped-launch WATCHDOG (handleWrappedLaunchFailure): the stage/push
//     smoke test runs `tmux new-session -d`, which never opens a client tty
//     and therefore never exercises terminfo — so a remote with no terminfo
//     db reports `ok`, the ATTACHED launch dies (`open terminal failed`), and
//     tier 2 re-selects the same binary forever with no recovery. The fix
//     watches the PTY for a bounded window after a tmux-WRAPPED launch and
//     falls back to the BARE claude launch on any refusal the remote reports.
//
//  2. The `destroyed` INVARIANT: destroying the flow mid-tier and then feeding
//     the stage sentinel used to drive a buildTmuxBinPatchCommand write into
//     the torn-down PTY and re-arm the idle fallback; and a destroy during the
//     tier-4 download/push made the resolving promise emit 'running-claude' on
//     `ssh:flowState:<sessionId>` — the channel a RESPAWNED session with the
//     same id is already subscribed to. Guards now sit in the onData handler
//     (right after the renderer data forward) and, as defence in depth, at the
//     top of setFlowState / armIdleFallback / writeClaudeCmd.
// ===========================================================================

/** Like makeSpyWin above, but records the RAW payload for every channel —
 *  needed to observe ssh:sessionInfo:<id> messages ({tmuxPersistent, ...}) and
 *  pty:data:<id> chunks, which makeSpyWin's {state, info} projection drops. */
function makeRecordingWin(): { win: unknown; sends: Array<{ channel: string; payload: unknown }> } {
  const sends: Array<{ channel: string; payload: unknown }> = []
  const win = {
    webContents: {
      send: (channel: string, payload: unknown) => {
        sends.push({ channel, payload })
      },
    },
    isDestroyed: () => false,
  }
  return { win, sends }
}

/**
 * Drive the manual SSH flow to a tmux-WRAPPED claude launch write (tier 1,
 * tmux=path). The wrapped-launch watchdog arms only when the wrapped command
 * is actually WRITTEN (inside writeClaudeCmd's 200ms-deferred write), so after
 * this helper returns the watch window is open and claude has NOT latched.
 */
function driveToWrappedLaunch(sessionId: string, win: unknown, sshExtra: Record<string, unknown> = {}): void {
  onDataListeners.length = 0
  spawnPty(win as never, sessionId, { ssh: { ...SSH, ...sshExtra } } as never)
  writeMock.mockClear()
  getSshFlow(sessionId)!.launchClaude()
  vi.advanceTimersByTime(300) // past writeHostSetupCmd's 200ms setup write
  feedPtyData(nonceSentinel(sessionId, 'setup ok {NONCE} tmux=path\r\n'))
  vi.advanceTimersByTime(1500) // idle fallback: setupDone -> proceedAfterSetup -> writeClaudeCmd scheduled
  vi.advanceTimersByTime(300) // writeClaudeCmd's 200ms write delay: wrapped write lands + watchdog arms
}

/** The exact refusal shape the fix was filed against (terminfo-less remote). */
const TMUX_REFUSAL = 'open terminal failed: missing or unsuitable terminal: xterm-256color\r\n'

/** Every write so far that is a claude launch NOT wrapped in tmux. */
function bareClaudeWrites(): string[] {
  return writeMock.mock.calls
    .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
    .filter((s) => s.includes('claude ') && !s.includes('has-session'))
}

describe('spawnPty SSH branch — wrapped-launch watchdog falls back to the bare launch (fail-posture follow-up)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // Mutation to prove this can fail: make handleWrappedLaunchFailure return
  // immediately — no bare write ever lands, tmuxPersistent stays true, and
  // the flow info never carries 'tmux-launch-refused'.
  it('(a)+(c) a remote refusal within the window writes a BARE claude launch, corrects tmuxPersistent to false, and carries tmux-launch-refused', () => {
    const { win, sends } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-refused', win)
    // Precondition: the launch really was tmux-wrapped (and announced as
    // persistent) before the refusal arrives.
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('has-session -t ccc-s-wd-refused'))).toBe(true)
    expect(sends.some((s) => s.channel === 'ssh:sessionInfo:s-wd-refused' && (s.payload as { tmuxPersistent?: boolean }).tmuxPersistent === true)).toBe(true)
    writeMock.mockClear()
    sends.length = 0
    feedPtyData(TMUX_REFUSAL)
    // The bare fallback write lands synchronously off the refusal chunk.
    const bare = bareClaudeWrites()
    expect(bare).toHaveLength(1)
    expect(bare[0]).not.toMatch(/new-session\s+-s\s+ccc-/)
    expect(bare[0]).toContain('claude ')
    // The persistence signal the wrapped write already emitted is corrected.
    const corrected = sends.filter((s) => s.channel === 'ssh:sessionInfo:s-wd-refused' && (s.payload as { tmuxPersistent?: boolean }).tmuxPersistent === false)
    expect(corrected).toHaveLength(1)
    // And the observable flow state carries the reason.
    expect(getSshFlow('s-wd-refused')!.getState()).toEqual({ state: 'running-claude', info: 'tmux-launch-refused' })
  })

  // Tier 5's whole point: reconnecting with no tmux in play is exactly the
  // case --continue exists for, so the bare RETRY carries it on a respawn.
  it('(b) the bare fallback carries --continue when the spawn was a reconnect', () => {
    const { win } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-recon', win, { reconnect: true })
    writeMock.mockClear()
    feedPtyData(TMUX_REFUSAL)
    const bare = bareClaudeWrites()
    expect(bare).toHaveLength(1)
    expect(bare[0]).toContain('--continue')
    expect(bare[0]).not.toContain('has-session')
  })

  it('(b) the bare fallback does NOT carry --continue on a first connect', () => {
    const { win } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-first', win) // no reconnect flag
    writeMock.mockClear()
    feedPtyData(TMUX_REFUSAL)
    const bare = bareClaudeWrites()
    expect(bare).toHaveLength(1)
    expect(bare[0]).not.toContain('--continue')
  })

  it('(d) fires AT MOST ONCE — a second refusal chunk produces no second bare write and no second sessionInfo emit', () => {
    const { win, sends } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-once', win)
    writeMock.mockClear()
    sends.length = 0
    feedPtyData(TMUX_REFUSAL)
    feedPtyData(TMUX_REFUSAL)
    expect(bareClaudeWrites()).toHaveLength(1)
    expect(sends.filter((s) => s.channel === 'ssh:sessionInfo:s-wd-once' && (s.payload as { tmuxPersistent?: boolean }).tmuxPersistent === false)).toHaveLength(1)
  })

  it('(e) does NOT fire for an UNwrapped launch — refusal-shaped output after a bare launch writes nothing', () => {
    // tmux=none: the helper routes through staging (fails it) and lands on
    // the bare launch, so the watchdog was never armed.
    driveToClaudeWrite('s-wd-unwrapped', 'setup ok {NONCE} tmux=none\r\n')
    expect(bareClaudeWrites()).toHaveLength(1)
    writeMock.mockClear()
    feedPtyData('sh: tmux: command not found\r\n')
    expect(writeMock.mock.calls).toHaveLength(0)
  })

  it('(f) does NOT fire once claude has latched as running — a refusal-shaped chunk after the UI latch writes nothing and leaves state alone', () => {
    const { win, sends } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-latched', win)
    // Claude's UI renders: the strict box-drawing latch flips claudeRunning.
    feedPtyData('╭──────────╮\r\n')
    expect(getSshFlow('s-wd-latched')!.getState().state).toBe('claude-running')
    writeMock.mockClear()
    sends.length = 0
    // e.g. claude's own output happens to quote a matching phrase.
    feedPtyData(TMUX_REFUSAL)
    expect(writeMock.mock.calls).toHaveLength(0)
    expect(sends.filter((s) => s.channel === 'ssh:sessionInfo:s-wd-latched')).toHaveLength(0)
    expect(getSshFlow('s-wd-latched')!.getState().state).toBe('claude-running')
  })

  it('(g) does NOT fire once the 6s window has elapsed', () => {
    const { win, sends } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-elapsed', win)
    // No refusal inside the window; the fake clock (Date is faked by
    // vi.useFakeTimers) crosses TMUX_LAUNCH_WATCH_MS = 6000.
    vi.advanceTimersByTime(6001)
    writeMock.mockClear()
    sends.length = 0
    feedPtyData(TMUX_REFUSAL)
    expect(writeMock.mock.calls).toHaveLength(0)
    expect(sends.filter((s) => s.channel === 'ssh:sessionInfo:s-wd-elapsed')).toHaveLength(0)
  })

  // ---- Round-2 adversarial pass: the FALSE-POSITIVE half of the watchdog. ----
  // The first cut matched bare `permission denied` / `command not found` /
  // `is a directory` anywhere in the chunk. Two proven false positives followed,
  // and the cost is not cosmetic: the bare claude line is typed into a pane that
  // already has claude running (landing in its composer as a chat message), and
  // dropping the session from sshTmuxWrappedBySession turns a later close into a
  // KILL of the remote instead of a detach.

  it('(h) does NOT fire when the chunk carries claude UI — a successful REATTACH redraw whose transcript contains "Permission denied"', () => {
    const { win, sends } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-attach', win, { reconnect: true })
    writeMock.mockClear()
    sends.length = 0
    // The redraw of an attached, live session: transcript text that happens to
    // quote a shell error, arriving in the SAME chunk as claude's UI. The UI
    // check must be consulted BEFORE the failure match (the claudeRunning latch
    // runs later in the same handler, so it cannot protect this chunk).
    feedPtyData("╭──────────╮\r\n│ ❯ ls: cannot open '/root': Permission denied\r\n")
    expect(writeMock.mock.calls).toHaveLength(0)
    expect(sends.filter((s) => s.channel === 'ssh:sessionInfo:s-wd-attach' && (s.payload as { tmuxPersistent?: boolean }).tmuxPersistent === false)).toHaveLength(0)
  })

  it('(i) does NOT fire on a generic error that never names tmux — claude\'s own EACCES startup stderr inside a working tmux', () => {
    const { win, sends } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-eacces', win)
    writeMock.mockClear()
    sends.length = 0
    feedPtyData("Error: EACCES: permission denied, open '/home/u/.claude/settings.json'\r\n")
    expect(writeMock.mock.calls).toHaveLength(0)
    expect(sends.filter((s) => s.channel === 'ssh:sessionInfo:s-wd-eacces')).toHaveLength(0)
  })

  it('(j) does NOT fire on "no server running on" — buildTmuxLaunchCommand\'s own || fresh-create leg already self-heals that race', () => {
    const { win, sends } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-norace', win)
    writeMock.mockClear()
    sends.length = 0
    feedPtyData('no server running on /tmp/tmux-1000/default\r\n')
    expect(writeMock.mock.calls).toHaveLength(0)
    expect(sends.filter((s) => s.channel === 'ssh:sessionInfo:s-wd-norace')).toHaveLength(0)
  })

  it('(k) STILL fires on a generic exec error that DOES name tmux on the line', () => {
    const { win } = makeRecordingWin()
    driveToWrappedLaunch('s-wd-generic', win)
    writeMock.mockClear()
    feedPtyData('bash: /home/u/.claude/bin/tmux: cannot execute binary file: Exec format error\r\n')
    expect(bareClaudeWrites()).toHaveLength(1)
  })
})

describe('spawnPty SSH branch — the destroyed invariant (lifecycle follow-up)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    _setTmuxArchiveResolverForTest(null)
  })

  // The attacker probe this pins: destroy mid-tier-3, then feed a VALID
  // (correct-nonce) stage-ok sentinel — pre-fix this drove a
  // buildTmuxBinPatchCommand write into the torn-down PTY and re-armed the
  // idle fallback. Mutation to prove this can fail: remove the
  // `if (destroyed) return` from the SSH onData handler — the stage-sentinel
  // block then runs and its synchronous settings-patch write lands
  // (writeMock gains a call), failing the zero-writes assertion.
  it('(a) destroy mid-tier-3: a later VALID stage-ok sentinel drives ZERO PTY writes and ZERO ssh:flowState/ssh:sessionInfo emits', () => {
    const { win, sends } = makeRecordingWin()
    onDataListeners.length = 0
    spawnPty(win as never, 's-destroyed-stage', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-destroyed-stage')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-destroyed-stage', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300) // staging fragment written; the stage sentinel is now awaited
    // Build the genuine sentinel BEFORE destroy so the test cannot depend on
    // the nonce registry's post-destroy lifetime.
    const sentinel = nonceSentinel('s-destroyed-stage', 'ccc-tmux-stage {NONCE} ok path=/home/dev/.claude/bin/tmux\r\n')
    getSshFlow('s-destroyed-stage')!.destroy()
    writeMock.mockClear()
    sends.length = 0
    feedPtyData(sentinel)
    vi.advanceTimersByTime(1000) // past writeClaudeCmd's 200ms delay, had one been scheduled
    expect(writeMock.mock.calls).toHaveLength(0) // no CCC_TMUX_BIN patch write, no claude write
    expect(sends.filter((s) => s.channel.startsWith('ssh:flowState:'))).toHaveLength(0)
    expect(sends.filter((s) => s.channel.startsWith('ssh:sessionInfo:'))).toHaveLength(0)
  })

  // The second attacker probe: a destroy during the tier-4 download let the
  // resolving promise emit 'running-claude' on ssh:flowState:<id> — a channel
  // a RESPAWNED session with the same id is already subscribed to. Mutation to
  // prove this can fail: remove writeClaudeCmd's top `if (destroyed) return` —
  // the aborted-push recovery path (writeClaudeCmd('tmux-push-fail:aborted'))
  // then runs its body and emitSshSessionInfo lands on ssh:sessionInfo:<id>,
  // failing the zero-sessionInfo assertion. (Its setFlowState call is caught
  // by setFlowState's own guard — that layer is pinned by (b2) below.)
  it('(b) destroy during the tier-4 download: the resolver settling afterwards writes nothing and emits nothing on ssh:flowState/ssh:sessionInfo', async () => {
    let resolveArchive!: (b: Buffer | null) => void
    _setTmuxArchiveResolverForTest(() => new Promise<Buffer | null>((res) => { resolveArchive = res }))
    const { win, sends } = makeRecordingWin()
    onDataListeners.length = 0
    spawnPty(win as never, 's-destroyed-push', { ssh: SSH } as never)
    writeMock.mockClear()
    getSshFlow('s-destroyed-push')!.launchClaude()
    vi.advanceTimersByTime(300)
    feedPtyData(nonceSentinel('s-destroyed-push', 'setup ok {NONCE} tmux=none\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    feedPtyData('ccc-tmux-push-arch Linux-x86_64\r\n')
    feedPtyData(nonceSentinel('s-destroyed-push', 'ccc-tmux-stage {NONCE} fail=download\r\n')) // attemptTmuxPush: download now pending
    getSshFlow('s-destroyed-push')!.destroy()
    writeMock.mockClear()
    sends.length = 0
    resolveArchive(FAKE_TMUX_ARCHIVE)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(6000) // would drain the transfer + writeClaudeCmd's delay if unguarded
    expect(writeMock.mock.calls).toHaveLength(0)
    expect(sends.filter((s) => s.channel.startsWith('ssh:flowState:'))).toHaveLength(0)
    expect(sends.filter((s) => s.channel.startsWith('ssh:sessionInfo:'))).toHaveLength(0)
  })

  // Defence-in-depth layer for the promise/captured-reference call sites that
  // never pass through onData: the flowController object outlives its sshFlows
  // entry (teardown races reach these methods through captured references —
  // the same seam M3's direct-destroy test uses). Mutation to prove this can
  // fail: remove the `if (destroyed) return` at the top of setFlowState — both
  // calls below then emit on ssh:flowState:<id> AND mutate the state a
  // still-held getState() reports.
  it('(b2) setFlowState itself is destroyed-guarded: a captured controller driven after destroy neither emits nor mutates state', () => {
    const { win, sends } = makeRecordingWin()
    onDataListeners.length = 0
    spawnPty(win as never, 's-destroyed-direct', { ssh: SSH } as never)
    const flow = getSshFlow('s-destroyed-direct')!
    expect(flow.getState().state).toBe('connecting')
    flow.destroy()
    sends.length = 0
    flow.handlePtyExit() // would setFlowState('failed', 'connection')
    flow.skip() //          would setFlowState('skipped')
    expect(sends.filter((s) => s.channel.startsWith('ssh:flowState:'))).toHaveLength(0)
    expect(flow.getState().state).toBe('connecting') // not even locally mutated
  })

  // The guard must sit AFTER the renderer data forward: a destroyed flow's
  // terminal is still a terminal. Mutation to prove this can fail: move the
  // onData `if (destroyed) return` ABOVE the win.webContents.send data
  // forward — the pty:data send below disappears.
  it('(c) terminal bytes STILL reach pty:data:<sessionId> after destroy', () => {
    const { win, sends } = makeRecordingWin()
    onDataListeners.length = 0
    spawnPty(win as never, 's-destroyed-data', { ssh: SSH } as never)
    getSshFlow('s-destroyed-data')!.destroy()
    sends.length = 0
    feedPtyData('post-destroy shell output\r\n')
    const dataSends = sends.filter((s) => s.channel === 'pty:data:s-destroyed-data')
    expect(dataSends).toHaveLength(1)
    expect(dataSends[0].payload).toContain('post-destroy shell output')
  })

  // Belt-and-braces by design, like the staging-timer destroy test above: the
  // re-arm is blocked TWICE (the onData guard bails before armIdleFallback is
  // ever called, and armIdleFallback's own guard bails if reached some other
  // way), so no SINGLE mutation fails this test — verified: removing only the
  // onData guard leaves it green (armIdleFallback's guard catches it), and
  // removing only armIdleFallback's guard leaves it green (onData bails
  // first). Removing BOTH (the full pre-fix shape) is what makes the
  // timer-count assertion fail. Recorded precisely so nobody later trusts a
  // single-mutation sensitivity this test does not have.
  it('(d) post-destroy data does not re-arm the idle fallback: no new timer, no state advance past 1.5s', () => {
    const { win, sends } = makeRecordingWin()
    onDataListeners.length = 0
    spawnPty(win as never, 's-destroyed-idle', { ssh: SSH } as never)
    const flow = getSshFlow('s-destroyed-idle')!
    // 'connecting' is the state whose idle handler WOULD advance (to
    // awaiting-claude) if the fallback re-armed and fired.
    expect(flow.getState().state).toBe('connecting')
    flow.destroy()
    sends.length = 0
    const timersBefore = vi.getTimerCount()
    feedPtyData('late teardown chatter\r\n')
    expect(vi.getTimerCount()).toBe(timersBefore) // nothing re-armed
    vi.advanceTimersByTime(5000) // way past IDLE_FALLBACK_MS (1.5s)
    expect(flow.getState().state).toBe('connecting')
    expect(sends.filter((s) => s.channel.startsWith('ssh:flowState:'))).toHaveLength(0)
  })
})

describe('spawnPty SSH branch — Windows remote skips the POSIX tmux staging ladder (item 3, adversarial review)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('remoteOs:windows delivers the PowerShell setup and never runs the POSIX `base64 -d | sh` staging on tmux=none', () => {
    onDataListeners.length = 0
    spawnPty(fakeWin, 's-win-remote', { ssh: { ...SSH, remoteOs: 'windows' }, model: 'opus[1m]' } as never)
    writeMock.mockClear()
    getSshFlow('s-win-remote')!.launchClaude()
    vi.advanceTimersByTime(300)
    // Windows setup is PowerShell-delivered, not the POSIX base64|node form.
    expect(writeMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('powershell'))).toBe(true)
    feedPtyData(nonceSentinel('s-win-remote', 'setup ok {NONCE} tmux=none acct=\r\n'))
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    // No POSIX staging ladder typed into cmd.exe, and no 20s stall path.
    expect(writeMock.mock.calls.some((c) => isStagingWrite(c[0]))).toBe(false)
    // The launch is the cmd.exe form (set "X=Y"&& claude), never tmux-wrapped.
    const claudeWrite = writeMock.mock.calls.map((c) => c[0]).find((a) => typeof a === 'string' && a.includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect(claudeWrite as string).not.toContain('has-session')
    // m1: the model id reaches cmd.exe DOUBLE-quoted (claude.cmd strips them),
    // never POSIX single-quoted (cmd.exe leaves those literal -> a broken flag).
    expect(claudeWrite as string).toContain('--model "opus[1m]"')
    expect(claudeWrite as string).not.toContain(`--model 'opus[1m]'`)
  })
})

// 2026-08-27 Pi tier-3 incident: on Windows the app reads ssh.exe through
// ConPTY, which re-encodes the remote stream and can glue its own escape
// sequences (window-title OSC, cursor/bracketed-paste CSIs) BETWEEN a
// sentinel's last token and its line terminator. Every parser here anchors on
// `(?=[\r\n])`, so glue either breaks the match outright (setup-ok: silent
// 20s timeout) or corrupts the capture (`\S+` swallows the escapes and a
// SUCCESSFUL remote stage is declared fail=unsafe-path; the arch probe
// latches "unrecognised"). The parsers now strip complete escape sequences
// first (ansi-strip.ts). GLUE below is the RC8-captured ConPTY shape
// (ui-detection.ts's incident comment), verbatim class: title OSC + cursor
// CSIs. Every test whose glue sits BETWEEN a token and the terminator fails
// when the stripAnsiForSentinel call is removed from its parser; the one
// mid-buffer case (glue on an EARLIER line) instead guards against an
// over-aggressive strip that would swallow the sentinel line — it passes
// under a no-op strip, which is correct, and is the reason ansi-strip.ts's
// OSC body aborts on \r\n rather than mirroring ui-detection's class.
describe('sentinel parsers — ConPTY glued-escape immunity (2026-08-27)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const GLUE = '\x1b]0;C:/WINDOWS/System32/OpenSSH/ssh.exe\x07\x1b[?25h'
  const NONCE = 'cafe0123deadbeef4567abcd'

  it('parseTmuxStageSentinel: ok path= with glued title-OSC + CSI before the terminator still parses as ok, with the clean path', () => {
    const r = parseTmuxStageSentinel(`ccc-tmux-stage ${NONCE} ok path=/home/pi/.claude/bin/tmux${GLUE}\r\n`, NONCE)
    expect(r).toEqual({ ok: true, path: '/home/pi/.claude/bin/tmux' })
  })

  it('parseTmuxStageSentinel: bracketed-paste CSI glued directly after the path (bash prompt redraw) still parses ok', () => {
    const r = parseTmuxStageSentinel(`ccc-tmux-stage ${NONCE} ok path=/home/pi/.claude/bin/tmux\x1b[?2004h\r\n`, NONCE)
    expect(r).toEqual({ ok: true, path: '/home/pi/.claude/bin/tmux' })
  })

  it('parseTmuxStageSentinel: charset-designation + cursor-save glue (a host tmux redraw) still parses ok', () => {
    // \x1b(B / \x1b7 are what conhost emits through a host-started tmux — the
    // families the first cut of ansi-strip.ts missed (adversarial review).
    const r = parseTmuxStageSentinel(`ccc-tmux-stage ${NONCE} ok path=/home/pi/.claude/bin/tmux\x1b(B\x1b7\r\n`, NONCE)
    expect(r).toEqual({ ok: true, path: '/home/pi/.claude/bin/tmux' })
  })

  it('parseTmuxStageSentinel: fail=<reason> with glue still yields the clean reason, not invalid-reason', () => {
    const r = parseTmuxStageSentinel(`ccc-tmux-stage ${NONCE} fail=download${GLUE}\r\n`, NONCE)
    expect(r).toEqual({ ok: false, reason: 'download' })
  })

  it('parseTmuxStageSentinel: the charset gate is still live for REAL garbage (a spoofed path with a shell metachar is still unsafe-path)', () => {
    const r = parseTmuxStageSentinel(`ccc-tmux-stage ${NONCE} ok path=/tmp/$(reboot)/tmux\r\n`, NONCE)
    expect(r).toEqual({ ok: false, reason: 'unsafe-path' })
  })

  it('parseTmuxStageSentinel: a trailing UNTERMINATED escape (title OSC split at the chunk boundary) does not resolve a half-line, and the completed buffer parses on the next chunk', () => {
    const chunk1 = `ccc-tmux-stage ${NONCE} ok path=/home/pi/.claude/bin/tmux\x1b]0;C:/WINDOWS/Sys`
    expect(parseTmuxStageSentinel(chunk1, NONCE)).toBeUndefined()
    expect(parseTmuxStageSentinel(`${chunk1}tem32/ssh.exe\x07\r\n`, NONCE)).toEqual({ ok: true, path: '/home/pi/.claude/bin/tmux' })
  })

  it('parseTmuxSentinel: setup-ok with glue between the class token and the terminator still reports the class', () => {
    expect(parseTmuxSentinel(`setup ok ${NONCE} tmux=path${GLUE}\r\n`, NONCE)).toBe('path')
    expect(parseTmuxSentinel(`setup ok ${NONCE} tmux=none${GLUE}\r\n`, NONCE)).toBe(null)
  })

  it('parseSetupAccountSentinel: glue after the acct field still yields the decoded account', () => {
    const acct = Buffer.from('dev@example.com').toString('base64')
    expect(parseSetupAccountSentinel(`setup ok ${NONCE} tmux=home acct=${acct}${GLUE}\r\n`, NONCE)).toBe('dev@example.com')
  })

  it('glue in the middle of the accumulated buffer (earlier chatty output) does not mask a later clean sentinel', () => {
    const buf = `motd banner${GLUE}\r\nsetup ok ${NONCE} tmux=home\r\n`
    expect(parseTmuxSentinel(buf, NONCE)).toBe('home')
  })

  it('end-to-end: a glued stage-ok sentinel still wraps the eventual claude launch in tmux (the incident regression — pre-fix this fell to the bare launch as unsafe-path)', () => {
    driveToStageWrite('s-glue-e2e')
    writeMock.mockClear()
    feedPtyData(nonceSentinel('s-glue-e2e', `ccc-tmux-stage {NONCE} ok path=/home/pi/.claude/bin/tmux${GLUE}\r\n`))
    vi.advanceTimersByTime(300)
    const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
    expect(claudeWrite).toBeDefined()
    expect((claudeWrite![0] as string)).toContain('"$HOME"/.claude/bin/tmux new-session -s ccc-s-glue-e2e')
  })
})
