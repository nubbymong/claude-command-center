// rc.14 review F1 (aicc_planning#45) -> rc.15 review R1 (Codex, 2026-09-06):
// a container entry that cannot be PROVEN must never become "the inner shell".
//
// rc.14 taught the flow the engines' failure shapes and the host prompt coming
// back. The rc.15 review (FINDINGS.md R1, evidence/remote-followup.review.test.ts)
// showed that was still "absence of evidence": a zsh `%` host prompt the regex
// never captured, or a prompt with a changing command counter, still promoted a
// CANCELLED sudo entry to inner after 1.5s of idle, and Launch Claude then wrote
// the container setup and claude onto the HOST. rc.16 inverts the rule: the
// entry command is composed so that a process INSIDE the named container prints
// `__CCC_<attempt-nonce>_IN__` before the shell starts; inner is set on that
// sentinel ALONE, never on prompt shape or silence. The wrapper prints OUT when
// the shell exits, and Launch re-proves the attached shell (CCC_ENTRY guard)
// before any ordinary write. Prompt-shaped output and engine errors remain as
// fast-fail hints only.
//
// Real pty-manager SSH flow, mocked transport (the harness shape the external
// review used). The cases marked "Codex" are the review's own characterizations
// flipped into the desired behaviour (credit: Codex rc.15 stability review);
// each was RED against 7ef62a2e before this change. Positive controls are
// labelled as such and are not counted as repair evidence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'linux',
}))

const onDataListeners: Array<(data: string) => void> = []
const onExitListeners: Array<(e: { exitCode: number }) => void> = []
const writeMock = vi.fn()
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (cb: (data: string) => void) => onDataListeners.push(cb),
    onExit: (cb: (e: { exitCode: number }) => void) => onExitListeners.push(cb),
    write: writeMock,
    kill: vi.fn(),
    pid: 4242,
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
}))

const {
  spawnPty, getSshFlow, killPty, CONTAINER_ENTRY_ERROR_RE, CONTAINER_ENGINE_NOT_FOUND_RE, _getSetupLineBufferLenForTest,
  _getSshEntryNonceForTest, _getSshNonceForTest,
} = await import('../../src/main/pty-manager')
const { composeContainerEntryCommand, buildEntryGuardCommand, entrySentinel } = await import('../../src/shared/container-command')
const { SSH_ENTRY } = await import('../../src/shared/ssh-entry')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const sendMock = vi.fn()
const win = { webContents: { send: sendMock }, isDestroyed: () => false } as never
const ssh = { username: 'user', host: 'invalid.example', port: 22, remotePath: '~' }
const spawnPtyId = (id: string, opts: unknown) => spawnPty(win, id, opts as never)
const feed = (text: string) => onDataListeners.forEach((cb) => cb(text))
/** The ssh process dies (a natural PTY exit, not a deliberate close). */
const exitPty = () => onExitListeners.forEach((cb) => cb({ exitCode: 255 }))
const wrote = (needle: string) => writeMock.mock.calls.some(([s]) => String(s).includes(needle))
const writes = () => writeMock.mock.calls.map(([s]) => String(s))
/** Every flow state emitted for `id`, in order. */
const states = (id: string) => sendMock.mock.calls
  .filter(([ch]) => ch === `ssh:flowState:${id}`)
  .map(([, p]) => (p as { state: string }).state)
const infos = (id: string) => sendMock.mock.calls
  .filter(([ch]) => ch === `ssh:flowState:${id}`)
  .map(([, p]) => (p as { state: string; info?: string }).info)
const ids: string[] = []

type Runtime = { type: 'container'; engine: 'docker' | 'podman'; container: string; sudo?: boolean; mode?: 'exec' | 'start'; containerDir?: string; shell?: 'bash' | 'sh' }
const HOST_PROMPT = 'user@host:~$ '
const INNER_PROMPT = 'root@0a1b2c3d4e5f:/# '
const GUARD = buildEntryGuardCommand() + '\r'

/** The current attempt's entry sentinels, from the REAL nonce spawnPty minted. */
const nonceOf = (id: string) => {
  const n = _getSshEntryNonceForTest(id)
  expect(n, 'an entry nonce for the current attempt').toBeDefined()
  return n!
}
const IN = (id: string) => `${entrySentinel(nonceOf(id), 'IN')}\r\n`
const OUT = (id: string) => `${entrySentinel(nonceOf(id), 'OUT')}\r\n`
const HERE = (id: string) => `${entrySentinel(nonceOf(id), 'HERE')}\r\n`

/** Spawn a container session, land on the host prompt, click Run post-connect
 *  command, and let the 200ms deferred write go out. Returns the exact command
 *  typed -- the sentinel-bearing shape composed around this attempt's nonce. */
function enterContainer(id: string, container = 'ccc-test', extra: Partial<Runtime> & { sudoPassword?: string } = {}) {
  ids.push(id)
  const { sudoPassword, ...rt } = extra
  const runtime: Runtime = { type: 'container', engine: 'docker', container, ...rt }
  spawnPty(win, id, { ssh: { ...ssh, sudoPassword, runtime } } as never)
  feed(HOST_PROMPT)
  expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
  getSshFlow(id)!.runPostCommand()
  vi.advanceTimersByTime(201)
  const cmd = composeContainerEntryCommand(runtime, nonceOf(id))!
  expect(writeMock).toHaveBeenCalledWith(`${cmd}\r`)
  writeMock.mockClear()
  return cmd
}

/** Click Launch Claude in the inner shell and answer the launch guard, so the
 *  container setup goes out. Asserts the guard was the ONLY write before the
 *  answer -- nothing ordinary is written until the attached shell proves itself. */
function launchAndAnswerGuard(id: string) {
  getSshFlow(id)!.launchClaude()
  expect(writes()).toEqual([GUARD])
  writeMock.mockClear()
  feed(HERE(id))
  vi.advanceTimersByTime(301)
}

/** The host prompt as the unterminated trailing line is PENDING (readline may
 *  still repaint the echoed command after it); 1.5s of silence confirms the
 *  host is back. Tests that end on the returned prompt take this step. */
const settle = () => vi.advanceTimersByTime(1600)
/** Output came back but no sentinel and no recognised prompt: the flow holds
 *  (10+1) x 1.5s from the last output (the engine's start-up allowance on a
 *  host whose prompt cannot be stripped), then fails. */
const unprovenDeadline = () => vi.advanceTimersByTime(16600)

beforeEach(() => {
  vi.useFakeTimers()
  onDataListeners.length = 0
  onExitListeners.length = 0
  writeMock.mockReset()
  sendMock.mockReset()
})
afterEach(() => {
  for (const id of ids.splice(0)) killPty(id)
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('the entry command (rc.15 review R1): a process inside the container announces the entry', () => {
  it('composes the sentinel wrapper around a per-attempt nonce; the joined IN token is NOT in the typed line', () => {
    const id = 'entry-cmd'
    const cmd = enterContainer(id)
    const n = nonceOf(id)
    expect(cmd).toBe(`docker exec -it ccc-test sh -c 'printf "__CCC_%s_%s__\\n" ${n} IN; CCC_ENTRY=${n} bash; printf "__CCC_%s_%s__\\n" ${n} OUT'`)
    expect(cmd).not.toContain(entrySentinel(n, 'IN'))
    expect(cmd).not.toContain(entrySentinel(n, 'OUT'))
    // Separate from the per-session setup nonce: a copied setup sentinel can
    // never double as an entry proof.
    expect(n).not.toBe(_getSshNonceForTest(id))
  })

  it('keeps sudo, podman, -w and the configured shell', () => {
    const id = 'entry-cmd-full'
    const cmd = enterContainer(id, 'dev', { engine: 'podman', sudo: true, containerDir: '/srv/app', shell: 'sh' })
    const n = nonceOf(id)
    expect(cmd).toBe(`sudo podman exec -it -w /srv/app dev sh -c 'printf "__CCC_%s_%s__\\n" ${n} IN; CCC_ENTRY=${n} sh; printf "__CCC_%s_%s__\\n" ${n} OUT'`)
  })

  it('a LEGACY free-text docker line is composed the same way, with ITS shell (sh) and -w preserved (Codex plan-review condition 2)', () => {
    const id = 'entry-cmd-legacy'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, postCommand: 'sudo docker exec -it -w /work review sh' } } as never)
    feed(HOST_PROMPT)
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    const n = nonceOf(id)
    expect(writes()).toEqual([`sudo docker exec -it -w /work review sh -c 'printf "__CCC_%s_%s__\\n" ${n} IN; CCC_ENTRY=${n} sh; printf "__CCC_%s_%s__\\n" ${n} OUT'\r`])
    // ...and it is a container session: the sentinel is required, a prompt alone is not entry.
    writeMock.mockClear()
    feed('$ ')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('a structured runtime keeps the free-text prep in front of the composed entry', () => {
    const id = 'entry-cmd-prep'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, postCommand: 'echo prep', runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed(HOST_PROMPT)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(writes()[0]).toMatch(/^echo prep && docker exec -it ccc-test sh -c '/)
  })
})

describe('Codex R1 characterizations, flipped: cancelled or unproven entries never become inner', () => {
  it('Codex: cancel sudo on a zsh-style `%` prompt (never captured by the regex) -> NOT inner after idle, FAILED by the deadline, Launch writes nothing', () => {
    const id = 'codex-zsh-cancel'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'review', sudo: true } } } as never)
    feed('user@mac ~ % ')
    vi.advanceTimersByTime(1600) // the idle fallback carries the flow to awaiting-postcommand
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed('[sudo] password for user: ')
    feed('^C\r\nuser@mac ~ % ')
    vi.advanceTimersByTime(1600) // 7ef62a2e promoted to inner here
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    expect(states(id)).not.toContain('awaiting-claude')
    getSshFlow(id)!.launchClaude() // a click while unproven: refused, nothing written
    expect(writes()).toEqual([])
    expect(states(id).at(-1)).toBe('running-postcommand') // re-emitted, so the overlay's busy flag clears
    unprovenDeadline()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
    expect(wrote('base64 -d | node')).toBe(false)
  })

  it('Codex: a recognised host prompt with a CHANGING command counter after a cancelled sudo is not inner: failed at the first idle', () => {
    const id = 'codex-counter-cancel'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'review', sudo: true } } } as never)
    feed('user@host [1]$ ')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed('[sudo] password for user: ')
    feed('^C\r\nuser@host [2]$ ') // the exact-line compare cannot match [1] against [2]
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand') // 7ef62a2e: awaiting-claude/inner
    expect(states(id)).not.toContain('awaiting-claude')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
  })

  it('Codex: identical minimal host and container prompts (`$ `) promote ONLY with the sentinel', () => {
    const idOk = 'codex-identical-in'
    ids.push(idOk)
    spawnPty(win, idOk, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'review' } } } as never)
    feed('$ ')
    getSshFlow(idOk)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`${IN(idOk)}$ `) // 7ef62a2e: failed ("the host prompt is back")
    expect(getSshFlow(idOk)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })

    const idNo = 'codex-identical-no-in'
    ids.push(idNo)
    spawnPty(win, idNo, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'review' } } } as never)
    feed('$ ')
    getSshFlow(idNo)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed('$ ')
    settle()
    expect(getSshFlow(idNo)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('an IN split across chunks: not inner before the last fragment, inner after it, with no prompt at all', () => {
    const id = 'entry-split-in'
    enterContainer(id)
    const token = entrySentinel(nonceOf(id), 'IN')
    feed(token.slice(0, 9))
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(token.slice(9, -2))
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(token.slice(-2)) // the closer, but no terminator yet: not a sentinel
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed('\r\n')
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('the echo of the typed command never matches (the token is only ever JOINED inside the container); the real IN does', () => {
    const id = 'entry-echo-only'
    const cmd = enterContainer(id)
    feed(`${cmd}\r\n`)
    settle()
    expect(states(id)).not.toContain('awaiting-claude')
    feed(IN(id))
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a static banner/MOTD cannot forge it: a nonce-less or wrong-nonce sentinel is ignored', () => {
    const id = 'entry-forged'
    enterContainer(id)
    feed('__CCC_IN__\r\n__CCC_deadbeefdeadbeefdeadbeef_IN__\r\n')
    settle()
    expect(states(id)).not.toContain('awaiting-claude')
    unprovenDeadline()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('a prior ATTEMPT\'s nonce is ignored: Run again mints a fresh one and only the new IN promotes', () => {
    const id = 'entry-prior-nonce'
    enterContainer(id)
    const stale = entrySentinel(nonceOf(id), 'IN')
    feed(`Error response from daemon: No such container: ccc-test\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(_getSshEntryNonceForTest(id)).toBeUndefined() // the failed attempt's nonce is gone
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(nonceOf(id)).not.toBe(stale.split('_')[3])
    feed(`${stale}\r\n`) // a delayed IN from the first attempt
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    expect(states(id)).not.toContain('awaiting-claude')
    feed(IN(id))
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('Run again re-probes with a fresh nonce and REFUSES the launch until it is proven, without any error text having latched', () => {
    const id = 'entry-run-again-unproven'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    writeMock.mockClear()
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(writes()).toHaveLength(1)
    writeMock.mockClear()
    feed('Entering...\r\n') // output, no proof
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
    unprovenDeadline()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })
})

describe('IN is the sole proof, judged before the sudo auto-answer (Codex 1.2 / plan-review condition 4)', () => {
  const SECRET = 'synthetic-sudo-secret'

  it('IN and a container-side [sudo] prompt in ONE chunk: inner is set first, the host secret is NOT typed', () => {
    const id = 'entry-in-plus-sudo'
    // No runtime.sudo: the host never prompts, so the secret is "unsent" when
    // the container's own rc file asks for a password right after entry.
    enterContainer(id, 'ccc-test', { sudoPassword: SECRET })
    feed(`${IN(id)}[sudo] password for root: `)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([])
    expect(wrote(SECRET)).toBe(false)
  })

  it('a sudo prompt AFTER a proven entry (a later chunk) is never answered either', () => {
    const id = 'entry-sudo-after-in'
    enterContainer(id, 'ccc-test', { sudoPassword: SECRET })
    feed(IN(id))
    feed('[sudo] password for root: ')
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([])
  })

  it('positive control: the HOST sudo prompt raised by the entry itself is answered once, then IN arrives, then nothing more', () => {
    const id = 'entry-host-sudo-then-in'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: SECRET })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([`${SECRET}\r`])
    writeMock.mockClear()
    feed(`\r\n${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed('[sudo] password for root: ')
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([])
  })
})

describe('after IN, the entry is not a permanent latch (Codex 4-A / plan-review condition 1)', () => {
  it('OUT after IN (an rc file that runs `exit`): fails closed as "left the container", Launch writes nothing', () => {
    const id = 'entry-in-then-out'
    enterContainer(id)
    feed(`${IN(id)}${OUT(id)}${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    expect(states(id)).not.toContain('awaiting-claude')
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
  })

  it('the user leaves the container shell later (OUT in a later chunk, then the host prompt): inner is withdrawn, nothing launches', () => {
    const id = 'entry-exit-later'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed(`exit\r\n${OUT(id)}${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
    // Run again re-enters from the host prompt with a new nonce.
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(writes()).toEqual([`${composeContainerEntryCommand({ type: 'container', engine: 'docker', container: 'ccc-test' }, nonceOf(id))}\r`])
  })

  it('Launch re-proves the attached shell: the guard is the ONLY write until HERE answers, then the container setup goes out', () => {
    const id = 'entry-guard-ok'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([GUARD])
    expect(getSshFlow(id)?.getState().state).toBe('running-setup')
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([GUARD]) // still nothing ordinary
    writeMock.mockClear()
    feed(`printf '__CCC_%s_%s__\\n' "$CCC_ENTRY" HERE\r\n`) // the echo: no joined token
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
    feed(HERE(id))
    vi.advanceTimersByTime(301)
    expect(wrote('base64 -d | node')).toBe(true)
  })

  it('detach keys / a stopped container: the host prompt is attached again with no OUT -- the guard gets no nonce back and the launch fails closed with ZERO ordinary writes', () => {
    const id = 'entry-guard-detached'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    feed(`\r\n${HOST_PROMPT}`) // the exec client detached; a prompt the flow cannot judge
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' }) // no passive signal exists
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([GUARD])
    writeMock.mockClear()
    feed('__CCC__HERE__\r\n' + HOST_PROMPT) // the host shell expands an empty CCC_ENTRY
    vi.advanceTimersByTime(5100)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    expect(writes()).toEqual([])
    expect(wrote('base64 -d | node')).toBe(false)
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
  })

  it('a different attempt\'s nonce answering the guard does not count', () => {
    const id = 'entry-guard-wrong-nonce'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    writeMock.mockClear()
    feed('__CCC_0123456789abcdef01234567_HERE__\r\n')
    vi.advanceTimersByTime(5100)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    expect(writes()).toEqual([])
  })

  it('OUT arriving while the guard is out fails it at once', () => {
    const id = 'entry-guard-out'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    writeMock.mockClear()
    feed(`${OUT(id)}${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    vi.advanceTimersByTime(5100)
    expect(writes()).toEqual([])
  })

  it('a second Launch click while the guard is out writes nothing more', () => {
    const id = 'entry-guard-double-click'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([GUARD])
  })

  it('the guard timer is cleared on teardown (no failure emitted for a dead flow)', () => {
    const id = 'entry-guard-teardown'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    killPty(id)
    ids.splice(ids.indexOf(id), 1)
    sendMock.mockClear()
    vi.advanceTimersByTime(6000)
    expect(states(id)).toEqual([])
  })
})

describe('shapes that cannot be proven are never auto-promoted (Codex 4-B): explicit consent instead', () => {
  it('`start -ai`: the attach finishes on some prompt -> awaiting-claude/UNVERIFIED (never inner); Launch anyway runs setup in the attached process', () => {
    const id = 'entry-start-ai'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test', mode: 'start' } } } as never)
    feed(HOST_PROMPT)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(writes()).toEqual(['docker start -ai ccc-test\r'])
    expect(_getSshEntryNonceForTest(id)).toBeUndefined() // no sentinel is possible
    writeMock.mockClear()
    feed(`starting...\r\n${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'unverified' })
    expect(infos(id)).not.toContain('inner')
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([]) // no guard: nothing to prove against
    vi.advanceTimersByTime(301)
    expect(wrote('base64 -d | node')).toBe(true)
    // The consent path re-runs setup in the ATTACHED shell (the pre-existing
    // inner semantics: 'container' setup stage), never the host ladder.
    expect(infos(id)).toContain('container')
    expect(infos(id)).not.toContain('host')
  })

  it('`start -ai`: a cancelled sudo on a `%` host also lands on UNVERIFIED, not inner', () => {
    const id = 'entry-start-ai-zsh'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test', mode: 'start', sudo: true } } } as never)
    feed('user@mac ~ % ')
    vi.advanceTimersByTime(1600)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed('[sudo] password for user: ')
    feed('^C\r\nuser@mac ~ % ')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'unverified' })
    expect(infos(id)).not.toContain('inner')
  })

  it('`start -ai`: a recognised HOST prompt coming back still fails (the fast-fail hints stay)', () => {
    const id = 'entry-start-ai-hostback'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test', mode: 'start' } } } as never)
    feed(HOST_PROMPT)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`Error response from daemon: No such container: ccc-test\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('a free-text post-command with no recognised container shape: UNVERIFIED on its next prompt, never inner', () => {
    const id = 'entry-free-text'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, postCommand: 'source ~/.venv/bin/activate' } } as never)
    feed(HOST_PROMPT)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(writes()).toEqual(['source ~/.venv/bin/activate\r'])
    feed(`(venv) ${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'unverified' })
    expect(infos(id)).not.toContain('inner')
    // Launch anyway: setup re-runs in the attached shell (as the old inner path did), no guard, no host ladder.
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(wrote('base64 -d | node')).toBe(true)
    expect(writes().some((w) => w.includes('CCC_ENTRY'))).toBe(false)
    expect(infos(id)).toContain('container')
    expect(infos(id)).not.toContain('host')
  })

  it('a docker line with flags the parser does not know is free text: UNVERIFIED, with no sentinel', () => {
    const id = 'entry-unknown-docker'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, postCommand: 'docker exec -it --privileged dev bash' } } as never)
    feed(HOST_PROMPT)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(writes()).toEqual(['docker exec -it --privileged dev bash\r'])
    expect(_getSshEntryNonceForTest(id)).toBeUndefined()
    feed(INNER_PROMPT)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'unverified' })
  })
})

describe('docker exec fails and the HOST prompt comes back (rc.14 F1, still caught)', () => {
  it('REGRESSION: the flow fails instead of reading the host prompt as the inner shell', () => {
    const id = 'entry-missing'
    enterContainer(id, 'missing-review')
    feed(`Error response from daemon: No such container: missing-review\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('Launch Claude after the failure re-emits it and writes NOTHING to the host', () => {
    const id = 'entry-missing-launch'
    enterContainer(id, 'missing-review')
    feed(`Error response from daemon: No such container: missing-review\r\n${HOST_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(wrote('base64 -d | node')).toBe(false) // no host/container setup blob
    expect(wrote('claude --settings')).toBe(false)
    expect(writes()).toEqual([])
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('the idle fallback does not promote the host shell either', () => {
    const id = 'entry-idle'
    enterContainer(id)
    feed('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\r\n')
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    feed(HOST_PROMPT)
    vi.advanceTimersByTime(5000)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('the error split across two chunks is still seen (line-buffered)', () => {
    const id = 'entry-split'
    enterContainer(id)
    feed('Error response from dae')
    feed(`mon: container ccc-test is not running\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })

  it('Skip remains the explicit route onto the raw host shell', () => {
    const id = 'entry-skip'
    enterContainer(id)
    feed(`Error response from daemon: No such container: ccc-test\r\n${HOST_PROMPT}`)
    getSshFlow(id)!.skip()
    expect(getSshFlow(id)?.getState().state).toBe('skipped')
  })

  it('REGRESSION: Ctrl-C at the sudo prompt (no error text at all) fails the entry', () => {
    const id = 'entry-ctrl-c'
    enterContainer(id, 'ccc-test', { sudo: true })
    feed('[sudo] password for user: ')
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(`^C\r\n${HOST_PROMPT}`)
    expect(states(id)).not.toContain('awaiting-claude')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(wrote('base64 -d | node')).toBe(false)
  })

  it('REGRESSION: three refused sudo attempts fail the entry (shape AND prompt)', () => {
    const id = 'entry-sudo-refused'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: 'synthetic-wrong' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual(['synthetic-wrong\r'])
    feed('\r\nSorry, try again.\r\n[sudo] password for user: ')
    feed(`\r\nsudo: 3 incorrect password attempts\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('REGRESSION: the docker socket refusing us fails the entry', () => {
    const id = 'entry-socket'
    enterContainer(id)
    feed('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/containers/ccc-test/json": dial unix /var/run/docker.sock: connect: permission denied\r\n')
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })

  it('REGRESSION: podman refusing to exec into a stopped container fails the entry', () => {
    const id = 'entry-podman'
    enterContainer(id, 'ccc-test', { engine: 'podman' })
    feed(`Error: can only create exec sessions on running containers: container state improper\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })

  it('a bare host prompt with no text before it (an unknown refusal) fails the entry once nothing follows it', () => {
    const id = 'entry-bare-return'
    enterContainer(id)
    feed(`\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand') // pending, not yet decided
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('a host prompt back with text no regex lists (terminated line, more after) fails once idle confirms it', () => {
    const id = 'entry-mid-chunk'
    enterContainer(id)
    feed(`Some refusal in words we do not list\r\n${HOST_PROMPT}\r\n`)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('a repaint chunk that ends right after the prompt, then the echo, then IN + the inner prompt, is a HEALTHY entry', () => {
    const id = 'entry-split-repaint'
    const cmd = enterContainer(id)
    feed(`\r${HOST_PROMPT}`) // readline redraws the prompt; the chunk ends here
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand') // pending, not failed
    feed(`${cmd}\r\n`) // the echoed command arrives in the next chunk
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('the same split repaint followed by silence is a hang: held, then failed, never promoted', () => {
    const id = 'entry-split-repaint-hang'
    const cmd = enterContainer(id)
    feed(`\r${HOST_PROMPT}`)
    feed(`${cmd}\r\n`)
    vi.advanceTimersByTime(6000)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    vi.advanceTimersByTime(20000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('a double repaint inside ONE line (`prompt \\r prompt cmd`) is still only the echo', () => {
    const id = 'entry-double-repaint'
    const cmd = enterContainer(id)
    feed(`${HOST_PROMPT}\r${HOST_PROMPT}${cmd}\r\n`)
    vi.advanceTimersByTime(20000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('the host prompt is re-read from the LAST prompt before the click, so a cd on the host first is fine', () => {
    const id = 'entry-cd-first'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed(HOST_PROMPT)
    feed('cd proj\r\nuser@host:~/proj$ ') // the user did prep by hand, as the overlay invites
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed('Some refusal in words we do not list\r\nuser@host:~/proj$ ') // the CURRENT host prompt returns
    settle()
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })

  it('a host prompt repaint still in flight during the 200ms deferred write is NOT the prompt returning', () => {
    const id = 'entry-repaint-window'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed(HOST_PROMPT)
    getSshFlow(id)!.runPostCommand()
    feed(HOST_PROMPT) // repaint (a resize, a PROMPT_COMMAND) arriving before the write
    vi.advanceTimersByTime(201)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })
})

describe('the host-back signal is robust (review 2c), and no prompt shape ever promotes', () => {
  it('a BEL after the returned host prompt does not promote it to inner', () => {
    const id = 'entry-bel'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    feed('\x07')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('a host that rings the BELL at its prompt is still captured (control bytes stripped), so the failure is caught', () => {
    const id = 'entry-bell-prompt'
    ids.push(id)
    spawnPtyId(id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } })
    feed(`user@host:~$ \x07`)
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`^C\r\n${HOST_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('a bare CR repaint after the returned host prompt does not promote it', () => {
    const id = 'entry-cr-after'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    feed('\r')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('the user typing at the returned host prompt does not promote it to inner', () => {
    const id = 'entry-user-types'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    feed('ls')
    vi.advanceTimersByTime(600)
    feed(` -la\r\nfile.txt\r\n` + HOST_PROMPT)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('the user typing `cd ~` (ends in a prompt char) at the returned prompt is not the inner shell', () => {
    const id = 'entry-user-cd'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    feed('cd ~')
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    settle()
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })

  it('a login prompt split across PTY chunks is still captured (line-buffered), so the failure is still caught', () => {
    const id = 'entry-split-login'
    ids.push(id)
    spawnPtyId(id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } })
    feed('user@ho')
    feed('st:~$ ')
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`Some refusal in words we do not list\r\n${HOST_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('a wrong saved sudo password, then its newline echo, still holds (not promoted) and then fails on the error', () => {
    const id = 'entry-sudo-wrong'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: 'synthetic-wrong' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual(['synthetic-wrong\r'])
    feed('\r\n')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    expect(states(id)).not.toContain('awaiting-claude')
    feed('Sorry, try again.\r\n[sudo] password for user: ')
    feed(`\r\nsudo: 3 incorrect password attempts\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('an unknown container-looking prompt WITHOUT the sentinel (the old promotion path) is not inner: failed at the first idle', () => {
    const id = 'entry-prompt-no-in'
    enterContainer(id)
    feed(`Entering container ccc-test (docker)\r\n${INNER_PROMPT}`) // 7ef62a2e: awaiting-claude/inner on this chunk
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })
})

describe('the engine-not-found line is a suspicion the prompt decides', () => {
  it('on the host (no engine installed) with the host prompt back: failed', () => {
    const id = 'entry-nf-host'
    enterContainer(id)
    feed(`bash: docker: command not found\r\n${HOST_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('from an rc file INSIDE a healthy container (after IN), followed by the inner prompt: the inner shell (not a failure)', () => {
    const id = 'entry-nf-rcfile'
    enterContainer(id)
    feed(`${IN(id)}bash: docker: command not found\r\n${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('from an rc file inside a healthy container whose prompt the regex does not know (starship): the inner shell, on the sentinel', () => {
    const id = 'entry-nf-rcfile-starship'
    enterContainer(id)
    feed(`${IN(id)}bash: docker: command not found\r\n~/proj on main \r\n❯ `)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('on a zsh host whose `%` prompt never matches, the idle fallback fails the entry instead of promoting', () => {
    const id = 'entry-nf-zsh'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed('user@mac ~ % ')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed('zsh: command not found: docker\r\nuser@mac ~ % ')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('sudo saying the engine binary is missing is definitive (sudo runs on the host)', () => {
    const id = 'entry-nf-sudo'
    enterContainer(id, 'ccc-test', { sudo: true })
    feed('sudo: docker: command not found\r\n')
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })
})

describe('the idle fallback over a silent, waiting or unproven entry', () => {
  it('nothing but the command echo comes back (hung engine): held, then FAILED, never promoted', () => {
    const id = 'entry-hang'
    const cmd = enterContainer(id)
    feed(`${cmd}\r\n`)
    vi.advanceTimersByTime(6000)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    vi.advanceTimersByTime(20000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('the host prompt repainted in front of the echo (readline/ConPTY) is still only the echo: held, then FAILED', () => {
    const id = 'entry-hang-repaint'
    const cmd = enterContainer(id)
    feed(`\r${HOST_PROMPT}${cmd}\r\n`)
    vi.advanceTimersByTime(6000)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    vi.advanceTimersByTime(20000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('the zsh `\\r ESC[K` repaint variant of the echo is echo too', () => {
    const id = 'entry-hang-repaint-zsh'
    const cmd = enterContainer(id)
    feed(`\r\x1b[K${HOST_PROMPT}${cmd}\r\n`)
    vi.advanceTimersByTime(20000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('the repainted echo followed by IN + the inner prompt is a healthy entry', () => {
    const id = 'entry-repaint-then-inner'
    const cmd = enterContainer(id)
    feed(`\r${HOST_PROMPT}${cmd}\r\n`)
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a remote that never even echoes, on a flow the idle path carried to awaiting-postcommand, still hits the silence cap', () => {
    const id = 'entry-no-echo'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed('user@mac ~ % ')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    vi.advanceTimersByTime(20000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('a partial echo (chunk ends mid-command) is still only the echo', () => {
    const id = 'entry-partial-echo'
    const cmd = enterContainer(id)
    feed(cmd.slice(0, 12))
    feed(`${cmd.slice(12)}\r\n`)
    vi.advanceTimersByTime(20000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('a partial echo that ends on `-w ~` (a prompt char, but a PREFIX of the command) is echo, not a waiting shell', () => {
    const id = 'entry-partial-echo-tilde'
    const cmd = enterContainer(id, 'ccc-test', { containerDir: '~/proj' })
    const cut = cmd.indexOf('~') + 1
    feed(cmd.slice(0, cut))
    settle() // a recognised-prompt-shaped trailing line -- but it is our own echo: hold, do not fail yet
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(`${cmd.slice(cut)}\r\n${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a terse genuine line that is a WORD of the command (`bash`) counts as output -- and with IN it is the inner shell', () => {
    const id = 'entry-terse-output'
    const cmd = enterContainer(id)
    feed(`${cmd}\r\n${IN(id)}bash\r\n❯ `)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('output that is a word from the middle of the command, without IN, is output -- unproven, and FAILED by the deadline', () => {
    const id = 'entry-substring-output'
    const cmd = enterContainer(id)
    feed(`${cmd}\nbash\n-it `)
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand') // held, not promoted
    unprovenDeadline()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('a slow container start that then prints IN and its prompt still lands on the inner shell', () => {
    const id = 'entry-slow-start'
    const cmd = enterContainer(id)
    feed(`${cmd}\r\n`)
    vi.advanceTimersByTime(6000)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('an inner shell whose prompt the regex does not know (starship) is inner on IN -- and NOT on idle without it', () => {
    const idIn = 'entry-starship-in'
    enterContainer(idIn)
    feed(`${IN(idIn)}\r\n~/proj on main \r\n❯ `)
    expect(getSshFlow(idIn)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })

    const idNo = 'entry-starship-no-in'
    const cmd = enterContainer(idNo)
    feed(`${cmd}\r\n`)
    feed('\r\n~/proj on main \r\n❯ ') // 7ef62a2e: promoted on idle
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(idNo)?.getState().state).toBe('running-postcommand')
    unprovenDeadline()
    expect(getSshFlow(idNo)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(idNo)).not.toContain('awaiting-claude')
  })

  it('a sudo prompt waiting for the user (no saved secret) is not promoted over while they type; IN after it is the entry', () => {
    const id = 'entry-sudo-wait'
    enterContainer(id, 'ccc-test', { sudo: true })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(10000)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    expect(states(id)).not.toContain('awaiting-claude')
    feed(`\r\n${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a sudo prompt replaced by a starship prompt WITHOUT IN does not promote (7ef62a2e promoted at the first idle)', () => {
    const id = 'entry-sudo-then-starship'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: 'synthetic-sudo' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    feed('\r\n~/proj on main \r\n❯ ')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    unprovenDeadline()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('the sudo-prompt hold is BOUNDED, and FAILS (never promotes the host) at the cap: a prompt still waiting after ~61s', () => {
    const id = 'entry-sudo-wait-bound'
    enterContainer(id, 'ccc-test', { sudo: true })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(90000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('the unproven hold resets on fresh output and is measured from the LAST output', () => {
    const id = 'entry-unproven-reset'
    enterContainer(id)
    feed('starting container...\r\n')
    vi.advanceTimersByTime(13600) // nine holds spent
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed('still starting...\r\n') // fresh output: budget restored
    vi.advanceTimersByTime(13600)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })
})

describe('Run again after a failed entry', () => {
  it('re-runs the post-command from the failed state, with a NEW nonce, and judges the new attempt on its own sentinel', () => {
    const id = 'entry-run-again'
    enterContainer(id, 'ccc-test')
    feed(`Error response from daemon: No such container: ccc-test\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    getSshFlow(id)!.runPostCommand()
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    vi.advanceTimersByTime(201)
    const n = nonceOf(id)
    expect(writes()).toEqual([`docker exec -it ccc-test sh -c 'printf "__CCC_%s_%s__\\n" ${n} IN; CCC_ENTRY=${n} bash; printf "__CCC_%s_%s__\\n" ${n} OUT'\r`])
    writeMock.mockClear()
    feed(`${IN(id)}${INNER_PROMPT}`) // the user started it in the meantime
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    launchAndAnswerGuard(id)
    expect(wrote('base64 -d | node')).toBe(true) // the container setup, not a refusal
  })

  it('offers the saved sudo secret to the new attempt', () => {
    const id = 'entry-run-again-sudo'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: 'synthetic-sudo' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    feed(`\r\n^C\r\n${HOST_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    writeMock.mockClear()
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([
      `${composeContainerEntryCommand({ type: 'container', engine: 'docker', container: 'ccc-test', sudo: true }, nonceOf(id))}\r`,
      'synthetic-sudo\r',
    ])
  })

  it('judges the second attempt against the host prompt AS IT STANDS (a cd on the host in between)', () => {
    const id = 'entry-run-again-cd'
    enterContainer(id)
    feed(`Error response from daemon: No such container: ccc-test\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    feed('cd proj\r\nuser@host:~/proj$ ')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed('Some refusal in words we do not list\r\nuser@host:~/proj$ ')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id).filter((s) => s === 'awaiting-claude')).toEqual([])
  })

  it('a second failure is caught the same way', () => {
    const id = 'entry-run-again-fail'
    enterContainer(id)
    feed(`\r\n${HOST_PROMPT}`)
    settle()
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`Error response from daemon: No such container: ccc-test\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('is refused from any state other than the failed entry (or awaiting-postcommand)', () => {
    const id = 'entry-run-again-refused'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-claude')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(writes()).toEqual([])
  })
})

describe('positive controls: a successful, proven entry', () => {
  it('IN + the inner prompt reach awaiting-claude / inner, and Launch (guard answered) writes the container setup', () => {
    const id = 'entry-ok'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    launchAndAnswerGuard(id)
    expect(wrote('base64 -d | node')).toBe(true)
  })

  it('ordinary post-command output that merely mentions a container, then IN, is not a failure', () => {
    const id = 'entry-benign'
    enterContainer(id)
    feed(`Entering container ccc-test (docker)\r\n${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a sudo entry with a saved secret: prompt answered, IN, inner shell reached', () => {
    const id = 'entry-sudo-ok'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: 'synthetic-sudo' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual(['synthetic-sudo\r'])
    feed(`\r\n${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('IN glued with ConPTY escapes (a title OSC between the token and its newline) still proves the entry', () => {
    const id = 'entry-in-glued'
    enterContainer(id)
    feed(`${entrySentinel(nonceOf(id), 'IN')}\x1b]0;root@ctr: /\x07\x1b[?25h\r\n${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })
})

describe('the runtime line buffer', () => {
  it('is dropped once the inner shell is accepted', () => {
    const id = 'entry-buf-ok'
    enterContainer(id)
    feed('Entering container')
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeGreaterThan(0)
    feed(`\r\n${IN(id)}${INNER_PROMPT}`)
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeUndefined()
  })

  it('is dropped when the session is torn down mid-entry, along with the attempt nonce', () => {
    const id = 'entry-buf-teardown'
    enterContainer(id)
    feed('partial output with no newline')
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeGreaterThan(0)
    expect(_getSshEntryNonceForTest(id)).toBeDefined()
    killPty(id)
    ids.splice(ids.indexOf(id), 1)
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeUndefined()
    expect(_getSshEntryNonceForTest(id)).toBeUndefined()
  })

  it('stays bounded while the after-entry watch runs through a chatty container setup', () => {
    const id = 'entry-buf-bounded'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    feed('x'.repeat(10000))
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeLessThanOrEqual(4096)
  })
})

describe('the failure shapes', () => {
  it('CONTAINER_ENTRY_ERROR_RE: stopped/missing containers, engine down or refusing, runtime exec failure, sudo refusals', () => {
    for (const line of [
      'Error response from daemon: No such container: x',
      'Error response from daemon: container x is not running',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      'Cannot connect to Podman daemon',
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
      'Error: no container with name or ID "x" found: no such container',
      'Error: can only create exec sessions on running containers: container state improper',
      'OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found',
      'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown',
      'sudo: 3 incorrect password attempts',
      'sudo: a password is required',
      'sudo: no password was provided',
      'user is not in the sudoers file.  This incident will be reported.',
      "Sorry, user user is not allowed to execute '/usr/bin/docker exec -it x bash' as root on host.",
      'sudo: docker: command not found',
      'x\rsudo: docker: command not found',
    ]) expect(CONTAINER_ENTRY_ERROR_RE.test(line), line).toBe(true)
  })
  it('CONTAINER_ENTRY_ERROR_RE does not match a prompt, a benign mention, the bare shell not-found line, or "is not running" alone', () => {
    for (const line of [
      'root@abc:/# ', 'user@host:~$ ', 'docker exec -it ccc-test bash', 'Entering container',
      'bash: docker: command not found', 'zsh: command not found: podman',
      'my-service is not running, starting it', 'checking docker: not found in cache, pulling',
    ]) expect(CONTAINER_ENTRY_ERROR_RE.test(line), line).toBe(false)
  })
  it('CONTAINER_ENTRY_ERROR_RE uses a BOUNDED quantifier (no unbounded .+ on remote-controlled text)', () => {
    expect(CONTAINER_ENTRY_ERROR_RE.source).not.toContain('.+')
    expect(CONTAINER_ENTRY_ERROR_RE.source).toContain('[^\\r\\n]{0,200} is not allowed')
    expect(CONTAINER_ENTRY_ERROR_RE.test('Sorry, user dev is not allowed to execute \'/usr/bin/docker\' as root')).toBe(true)
  })

  it('CONTAINER_ENGINE_NOT_FOUND_RE: the shells\' own not-found lines for the engine binary, as whole lines', () => {
    for (const line of [
      'bash: docker: command not found', '-bash: podman: command not found', 'sh: 1: docker: not found',
      'zsh: command not found: podman', 'fish: Unknown command: docker\r\nbash: docker: command not found\r\n',
    ]) expect(CONTAINER_ENGINE_NOT_FOUND_RE.test(line), line).toBe(true)
    for (const line of [
      'docker exec -it ccc-test bash', 'checking docker: not found in cache, pulling',
      'Error response from daemon: No such container: x', 'root@abc:/# ',
    ]) expect(CONTAINER_ENGINE_NOT_FOUND_RE.test(line), line).toBe(false)
  })
})

// Adversarial pass on #598: the saved sudo secret exists for the post-command's
// own `sudo <engine> exec`, which prompts on the HOST. Once the flow is in the
// inner shell, a sudo-shaped prompt is printed by something INSIDE the container
// (a MOTD, a .bashrc, a process the user ran), and typing the host's secret into
// it hands that secret to the container.
describe('the saved sudo secret never reaches the container', () => {
  const SECRET = 'synthetic-sudo-secret'

  it('a sudo prompt printed inside an ENTERED container is not answered', () => {
    const id = 'sudo-inside-container'
    const cmd = enterContainer(id, 'ccc-test', { sudoPassword: SECRET })
    feed(`${cmd}\r\n${IN(id)}${INNER_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed('[sudo] password for root: ')
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([])
    expect(wrote(SECRET)).toBe(false)
  })

  it('positive control: the HOST sudo prompt raised by the post-command itself is answered, once, and never again inside', () => {
    const id = 'sudo-on-host'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: SECRET })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([`${SECRET}\r`])
    writeMock.mockClear()
    feed(`\r\n${IN(id)}${INNER_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed('[sudo] password for root: ')
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([])
  })

  // ADR-009 adversarial review (Lens A, R1 BLOCKER U9): once THIS session has
  // been proven inside the container, the host sudo secret is never offered
  // again -- whatever revokes the inner state. Absent the containerEverEntered
  // latch, a failEntry clears inInnerShell and the sudo gate re-opens, handing
  // the host secret to a `[sudo]` prompt the (still-attached) container prints.
  it('ADR-009: after a proven entry is LOST (a forged OUT from inside), a container sudo prompt is STILL refused the host secret', () => {
    const id = 'sudo-after-lost-entry'
    // sudo:false so no host sudo ran -- sudoPasswordSent stays false, the exact
    // state in which the gate would otherwise fire once inInnerShell is cleared.
    const cmd = enterContainer(id, 'ccc-test', { sudoPassword: SECRET })
    feed(`${cmd}\r\n${IN(id)}${INNER_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    // A process inside the container (which can read the exported CCC_ENTRY)
    // forges an OUT -> the flow believes the shell LEFT and clears inInnerShell.
    feed(OUT(id))
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    writeMock.mockClear()
    feed('[sudo] password for root: ')
    vi.advanceTimersByTime(200)
    // 7ef62a2e + first R1 cut: `synthetic-sudo-secret\r` written to the container.
    expect(wrote(SECRET)).toBe(false)
    expect(writes()).toEqual([])
  })

  it('ADR-009: Run again after a lost entry does not re-open the host secret to the container', () => {
    const id = 'sudo-after-run-again'
    const cmd = enterContainer(id, 'ccc-test', { sudoPassword: SECRET })
    feed(`${cmd}\r\n${IN(id)}${INNER_PROMPT}`)
    settle()
    feed(OUT(id)) // lost
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    // Run again resets sudoPasswordSent and mints a fresh attempt, but the
    // container-ever-entered latch survives it.
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed('[sudo] password for root: ')
    vi.advanceTimersByTime(200)
    expect(wrote(SECRET)).toBe(false)
  })
})

// Independent spec + quality reviews on the first R1 cut (2026-09-06). Each
// case below was a finding: a path that could still write claude to the host
// after the shell was lost, a setup latch that stuck Run again in a spinner, a
// guard timer outliving the PTY, the sudo secret reaching an unverified attach,
// and the plan's post-IN prompt matrix.
describe('R1 review round: a container shell lost AFTER the setup went out', () => {
  it('spec BLOCKER: OUT after the setup was written -> failed; the next prompt-shaped line writes NO claude command; Run again re-enters and re-runs the setup', () => {
    const id = 'entry-lost-after-setup'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    launchAndAnswerGuard(id)
    expect(wrote('base64 -d | node')).toBe(true)
    writeMock.mockClear()
    feed(`setup ok ${_getSshNonceForTest(id)} tmux=none\r\n`) // containerSetupDone, no prompt yet
    feed(`${OUT(id)}${HOST_PROMPT}`) // the container shell is gone before the inner prompt returns
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    feed(`\r\n${HOST_PROMPT}`) // the user presses Enter on the host: a prompt-shaped line
    settle()
    expect(writes()).toEqual([])
    expect(wrote('claude --settings')).toBe(false)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    // Run again: a fresh attempt, a fresh setup (the latch was released).
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed(`${IN(id)}${INNER_PROMPT}`)
    launchAndAnswerGuard(id)
    expect(wrote('base64 -d | node')).toBe(true)
    expect(getSshFlow(id)?.getState().state).toBe('running-setup')
  })

  it('quality MAJOR: Retry Launch after a container setup timeout re-runs the guard and the setup instead of spinning', () => {
    const id = 'entry-setup-timeout-retry'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    launchAndAnswerGuard(id)
    expect(wrote('base64 -d | node')).toBe(true)
    vi.advanceTimersByTime(10001) // SETUP_TIMEOUT_MS with no `setup ok`
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container setup timeout' })
    writeMock.mockClear()
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([GUARD])
    writeMock.mockClear()
    feed(HERE(id))
    vi.advanceTimersByTime(301)
    expect(wrote('base64 -d | node')).toBe(true)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'running-setup', info: 'container' })
  })

  it('quality: the guard timer is inert after a natural PTY exit (the connection failure is not overwritten)', () => {
    const id = 'entry-guard-pty-exit'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([GUARD])
    exitPty()
    expect(sendMock.mock.calls.filter(([ch]) => ch === `ssh:flowState:${id}`).at(-1)?.[1]).toEqual({ state: 'failed', info: 'connection' })
    writeMock.mockClear()
    vi.advanceTimersByTime(6000)
    expect(sendMock.mock.calls.filter(([ch]) => ch === `ssh:flowState:${id}`).at(-1)?.[1]).toEqual({ state: 'failed', info: 'connection' })
    expect(infos(id)).not.toContain('left the container')
    expect(writes()).toEqual([])
  })
})

describe('R1 review round: the unverified attach and the sudo secret', () => {
  it('spec MAJOR: a sudo prompt printed after an UNVERIFIED start -ai attach is not answered with the host secret', () => {
    const id = 'entry-start-ai-sudo'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, sudoPassword: 'synthetic-host-sudo', runtime: { type: 'container', engine: 'docker', container: 'ccc-test', mode: 'start' } } } as never)
    feed(HOST_PROMPT)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed(`starting...\r\n${INNER_PROMPT}`)
    settle() // a saved sudo secret holds the prompt path; the idle fallback decides
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'unverified' })
    feed('[sudo] password for appuser: ') // the entrypoint's own startup sudo
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([])
  })

  it('a free-text command that reached UNVERIFIED gets no host secret either', () => {
    const id = 'entry-free-text-sudo'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, sudoPassword: 'synthetic-host-sudo', postCommand: 'ssh other-box' } } as never)
    feed(HOST_PROMPT)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed('user@other-box:~$ ')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'unverified' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([])
  })
})

describe('R1 review round: the shell that never took the terminal', () => {
  it('sh present but the configured bash missing: IN, the not-found line and OUT in one chunk -> the shell is gone (the diagnosis is on screen), nothing launches', () => {
    const id = 'entry-no-bash'
    enterContainer(id)
    feed(`${IN(id)}sh: bash: not found\r\n${OUT(id)}${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    expect(states(id)).not.toContain('awaiting-claude')
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
  })
})

describe('R1 review round: the post-IN prompt matrix (plan-review condition 1)', () => {
  const HOSTS: Array<[string, string]> = [
    ['fixed', 'user@host:~$ '],
    ['percent (zsh)', 'user@mac ~ % '],
    ['changing counter', 'user@host [1]$ '],
    ['identical to the container', INNER_PROMPT],
  ]
  for (const [kind, hostPrompt] of HOSTS) {
    it(`OUT after IN with a ${kind} host prompt -> left the container, Launch writes nothing`, () => {
      const id = `entry-matrix-out-${kind.replace(/\W+/g, '-')}`
      ids.push(id)
      spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
      feed(hostPrompt)
      vi.advanceTimersByTime(1600)
      getSshFlow(id)!.runPostCommand()
      vi.advanceTimersByTime(201)
      writeMock.mockClear()
      feed(`${IN(id)}${INNER_PROMPT}`)
      expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
      feed(`exit\r\n${OUT(id)}${hostPrompt}`)
      expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
      getSshFlow(id)!.launchClaude()
      vi.advanceTimersByTime(301)
      expect(writes()).toEqual([])
    })

    it(`detach (no OUT) with a ${kind} host prompt -> the launch guard fails closed, zero ordinary writes`, () => {
      const id = `entry-matrix-detach-${kind.replace(/\W+/g, '-')}`
      ids.push(id)
      spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
      feed(hostPrompt)
      vi.advanceTimersByTime(1600)
      getSshFlow(id)!.runPostCommand()
      vi.advanceTimersByTime(201)
      writeMock.mockClear()
      feed(`${IN(id)}${INNER_PROMPT}`)
      feed(`\r\n${hostPrompt}`)
      vi.advanceTimersByTime(1600) // whatever the idle hint decides, Launch is judged by the guard
      getSshFlow(id)!.launchClaude()
      const guardWrites = writes().filter((w) => w === GUARD)
      writeMock.mockClear()
      feed('__CCC__HERE__\r\n' + hostPrompt)
      vi.advanceTimersByTime(5100)
      expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
      expect(writes()).toEqual([])
      expect(guardWrites.length).toBeLessThanOrEqual(1)
    })
  }

  it('the idle host-back hint: a recognised host prompt back after IN, with a DIFFERENT container prompt, fails at idle without waiting for Launch', () => {
    const id = 'entry-hostback-hint'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    feed(`\r\n${HOST_PROMPT}`) // detach keys: the host is back, no OUT
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
  })

  it('the idle host-back hint never fires for IDENTICAL prompts (the container prompt IS the host prompt line)', () => {
    const id = 'entry-hostback-identical'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed('$ ')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`${IN(id)}$ `)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed('ls\r\nfile\r\n$ ')
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a slow engine on a host whose prompt cannot be stripped (zsh %) still lands on inner inside the start-up allowance', () => {
    const id = 'entry-slow-zsh'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed('user@mac ~ % ')
    vi.advanceTimersByTime(1600)
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`user@mac ~ % ${writes()[0].trim()}\r\n`) // the echo, with a prompt the regex cannot strip in front
    vi.advanceTimersByTime(12000) // a loaded box: the exec takes a while
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })
})

describe('R1 review round 2: the claude command gets its own proof; Launch is inert once claude was typed', () => {
  /** Enter, prove, launch, answer the first guard, let the setup go out and
   *  come back `setup ok` with the container prompt. The flow now holds the
   *  claude command behind a SECOND guard: returns with it as the only write. */
  function setupDone(id: string) {
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    launchAndAnswerGuard(id)
    expect(wrote('base64 -d | node')).toBe(true)
    writeMock.mockClear()
    feed(`setup ok ${_getSshNonceForTest(id)} tmux=none\r\n${INNER_PROMPT}`)
    settle()
  }

  it('quality MAJOR: after `setup ok` the guard goes out again (its own overlay state), and claude is typed only once HERE answers', () => {
    const id = 'reproof-before-claude'
    setupDone(id)
    expect(writes()).toEqual([GUARD])
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'running-setup', info: SSH_ENTRY.VERIFYING })
    writeMock.mockClear()
    feed(HERE(id))
    vi.advanceTimersByTime(500)
    expect(wrote('claude')).toBe(true)
    expect(getSshFlow(id)?.getState().state).toBe('running-claude')
  })

  it('quality MAJOR: a detach between `setup ok` and the claude write (host prompt back, no OUT) fails closed as LEFT -- claude is never typed', () => {
    const id = 'detach-before-claude'
    setupDone(id)
    expect(writes()).toEqual([GUARD])
    writeMock.mockClear()
    feed(`__CCC__HERE__\r\n${HOST_PROMPT}`) // the host shell expands an empty CCC_ENTRY
    vi.advanceTimersByTime(5001)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    settle()
    expect(writes()).toEqual([])
    expect(wrote('claude')).toBe(false)
  })

  it('quality MAJOR: Retry Launch after claude exited to the container shell is inert -- no guard typed, no LEFT verdict, the failure re-emitted as it stands', () => {
    const id = 'retry-after-claude-exit'
    setupDone(id)
    feed(HERE(id))
    vi.advanceTimersByTime(500)
    expect(wrote('claude')).toBe(true)
    writeMock.mockClear()
    feed(`\r\n${INNER_PROMPT}`) // claude is gone; the container prompt is back
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'claude exited to shell' })
    sendMock.mockClear()
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([])
    expect(states(id)).toEqual(['failed'])
    vi.advanceTimersByTime(6000)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'claude exited to shell' })
    expect(infos(id)).not.toContain('left the container')
    expect(writes()).toEqual([])
  })

  it('quality MINOR: OUT inside the 300 ms deferred setup write -- the blob never lands on the host prompt behind it', () => {
    const id = 'out-inside-deferred-setup'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([GUARD])
    writeMock.mockClear()
    feed(HERE(id)) // the setup is scheduled 300 ms out...
    feed(`${OUT(id)}${HOST_PROMPT}`) // ...and the shell is gone before it goes
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
  })

  it('quality MINOR: Skip after a proven entry hands the shell over -- an `exit` typed later does not re-raise the overlay', () => {
    const id = 'skip-then-exit'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.skip()
    expect(getSshFlow(id)?.getState().state).toBe('skipped')
    feed(`exit\r\n${OUT(id)}${HOST_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState().state).toBe('skipped')
    expect(infos(id)).not.toContain('left the container')
  })

  it('a container setup timeout armed when the shell was lost never overwrites the LEFT verdict', () => {
    const id = 'left-then-setup-timeout'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    launchAndAnswerGuard(id)
    expect(wrote('base64 -d | node')).toBe(true)
    feed(`${OUT(id)}${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    vi.advanceTimersByTime(10001) // SETUP_TIMEOUT_MS
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    expect(infos(id)).not.toContain('container setup timeout')
  })

  it('a HERE carrying the current nonce while no guard is out changes nothing (no setup without a Launch)', () => {
    const id = 'stray-here'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed(HERE(id))
    vi.advanceTimersByTime(301)
    expect(writes()).toEqual([])
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })
})

describe('R1 review round 3: Skip and the after-entry watch', () => {
  it('spec MAJOR: Skip at the post-command offer, then Run: the new attempt IS watched -- an OUT after IN fails closed, never a lasting "inner"', () => {
    const id = 'skip-first-then-run'
    ids.push(id)
    const runtime: Runtime = { type: 'container', engine: 'docker', container: 'ccc-test' }
    spawnPty(win, id, { ssh: { ...ssh, runtime } } as never)
    feed(HOST_PROMPT)
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.skip()
    expect(getSshFlow(id)?.getState().state).toBe('skipped')
    feed(`\r\n${HOST_PROMPT}`) // the user presses Enter: the post-command offer comes back
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed(`exit\r\n${OUT(id)}${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([])
  })

  it('a Skip given while the attempt is in flight (IPC; the overlay offers none there) does not stand the watch down for the entry that then lands', () => {
    const id = 'skip-mid-attempt'
    enterContainer(id)
    getSshFlow(id)!.skip()
    expect(getSshFlow(id)?.getState().state).toBe('skipped')
    feed(`${IN(id)}${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed(`exit\r\n${OUT(id)}${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'left the container' })
  })

  it('quality MINOR: Skip while the launch guard is out withdraws it -- no "left the container" verdict fires later', () => {
    const id = 'skip-during-guard'
    enterContainer(id)
    feed(`${IN(id)}${INNER_PROMPT}`)
    getSshFlow(id)!.launchClaude()
    expect(writes()).toEqual([GUARD])
    writeMock.mockClear()
    getSshFlow(id)!.skip()
    expect(getSshFlow(id)?.getState().state).toBe('skipped')
    vi.advanceTimersByTime(6000)
    expect(getSshFlow(id)?.getState().state).toBe('skipped')
    expect(infos(id)).not.toContain('left the container')
    expect(writes()).toEqual([])
  })
})
