// rc.14 review F1 (aicc_planning#45): a container entry that fails must not
// become "the inner shell".
//
// After the runtime post-command (`docker exec -it <name> bash`) went out, the
// NEXT shell prompt was taken as the inner shell unconditionally. When the
// container is stopped or missing, or the engine is down, the failed exec
// returns to the HOST shell -- and Launch Claude then wrote the container
// setup and the claude command to the host. The flow now recognises the
// engines' (and sudo's) failure shapes in the post-command's own output, AND
// the host shell's own prompt line coming back (round 2: the review's sudo /
// socket / podman / silent cases print nothing a regex lists), fails, and
// refuses the host ladder until the post-command is run again. Real
// pty-manager SSH flow, mocked transport (the harness shape the external
// review used); a successful entry is the positive control.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'linux',
}))

const onDataListeners: Array<(data: string) => void> = []
const writeMock = vi.fn()
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (cb: (data: string) => void) => onDataListeners.push(cb),
    onExit: () => {},
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
} = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const sendMock = vi.fn()
const win = { webContents: { send: sendMock }, isDestroyed: () => false } as never
const ssh = { username: 'user', host: 'invalid.example', port: 22, remotePath: '~' }
const spawnPtyId = (id: string, opts: unknown) => spawnPty(win, id, opts as never)
const feed = (text: string) => onDataListeners.forEach((cb) => cb(text))
const wrote = (needle: string) => writeMock.mock.calls.some(([s]) => String(s).includes(needle))
const writes = () => writeMock.mock.calls.map(([s]) => String(s))
/** Every flow state emitted for `id`, in order. */
const states = (id: string) => sendMock.mock.calls
  .filter(([ch]) => ch === `ssh:flowState:${id}`)
  .map(([, p]) => (p as { state: string }).state)
const ids: string[] = []

type Runtime = { type: 'container'; engine: 'docker' | 'podman'; container: string; sudo?: boolean }
const HOST_PROMPT = 'user@host:~$ '
const INNER_PROMPT = 'root@0a1b2c3d4e5f:/# '

/** Spawn a container session, land on the host prompt, click Run post-connect
 *  command, and let the 200ms deferred write go out. Returns the command. */
function enterContainer(id: string, container = 'ccc-test', extra: Partial<Runtime> & { sudoPassword?: string } = {}) {
  ids.push(id)
  const { sudoPassword, ...rt } = extra
  const runtime: Runtime = { type: 'container', engine: 'docker', container, ...rt }
  spawnPty(win, id, { ssh: { ...ssh, sudoPassword, runtime } } as never)
  feed(HOST_PROMPT)
  expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
  getSshFlow(id)!.runPostCommand()
  vi.advanceTimersByTime(201)
  const cmd = `${runtime.sudo ? 'sudo ' : ''}${runtime.engine} exec -it ${container} bash`
  expect(writeMock).toHaveBeenCalledWith(`${cmd}\r`)
  writeMock.mockClear()
  return cmd
}

/** The host prompt as the unterminated trailing line is PENDING (readline may
 *  still repaint the echoed command after it); 1.5s of silence confirms the
 *  host is back. Tests that end on the returned prompt take this step. */
const settle = () => vi.advanceTimersByTime(1600)

beforeEach(() => {
  vi.useFakeTimers()
  onDataListeners.length = 0
  writeMock.mockReset()
  sendMock.mockReset()
})
afterEach(() => {
  for (const id of ids.splice(0)) killPty(id)
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('docker exec fails and the HOST prompt comes back', () => {
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
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('the idle fallback does not promote the host shell either', () => {
    const id = 'entry-idle'
    enterContainer(id)
    feed('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\r\n')
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    feed(HOST_PROMPT)
    vi.advanceTimersByTime(5000) // well past the 1.5 s idle window
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
})

// Round 2 (review MAJOR): failures that print nothing CONTAINER_ENTRY_ERROR_RE
// knows, or nothing at all. The host's own prompt line coming back is the
// signal; the regex is only the fast path.
describe('round 2: the host prompt itself coming back is a failed entry', () => {
  it('REGRESSION: Ctrl-C at the sudo prompt (no error text at all) fails the entry', () => {
    const id = 'entry-ctrl-c'
    enterContainer(id, 'ccc-test', { sudo: true }) // no sudo secret saved: the user is prompted
    feed('[sudo] password for user: ')
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(`^C\r\n${HOST_PROMPT}`)
    expect(states(id)).not.toContain('awaiting-claude') // the host prompt is never the inner shell
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
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand') // the host prompt is the trailing line; idle decides
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('REGRESSION (quality review): a repaint chunk that ends right after the prompt, then the echo, then the inner prompt, is a HEALTHY entry', () => {
    const id = 'entry-split-repaint'
    const cmd = enterContainer(id)
    feed(`\r${HOST_PROMPT}`) // readline redraws the prompt; the chunk ends here
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand') // pending, not failed
    feed(`${cmd}\r\n`) // the echoed command arrives in the next chunk
    feed(INNER_PROMPT)
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
    feed(INNER_PROMPT)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })
})

// Review 2c (spec + quality): the host-back signal must survive a `\r`/BEL
// repaint, the user typing at the returned prompt, and a login prompt split
// across chunks, and must not be a per-chunk flag a single byte can erase.
describe('review 2c: the host-back signal is robust', () => {
  it('REGRESSION: a BEL after the returned host prompt does not promote it to inner', () => {
    const id = 'entry-bel'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    feed('\x07') // a bell: not stripped, not whitespace -- must not blank the trailing line
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('REGRESSION: a host that rings the BELL at its prompt is still captured (control bytes stripped), so the failure is caught', () => {
    const id = 'entry-bell-prompt'
    ids.push(id)
    spawnPtyId(id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } })
    feed(`user@host:~$ \x07`) // the login prompt arrives with a trailing bell
    vi.advanceTimersByTime(1600) // the bell defeats the connect-time prompt match; the idle fallback carries it
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`^C\r\n${HOST_PROMPT}`) // a clean host prompt back
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('REGRESSION: a bare CR repaint after the returned host prompt does not promote it', () => {
    const id = 'entry-cr-after'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    feed('\r') // cursor to col 0, nothing overwrites -- the prompt is still on screen
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('REGRESSION: the user typing at the returned host prompt does not promote it to inner', () => {
    const id = 'entry-user-types'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    feed('ls') // they are back on the host and start typing
    vi.advanceTimersByTime(600)
    feed(` -la\r\nfile.txt\r\n` + HOST_PROMPT) // runs it; a fresh host prompt returns
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('REGRESSION: the user typing `cd ~` (ends in a prompt char) at the returned prompt is not the inner shell', () => {
    const id = 'entry-user-cd'
    enterContainer(id)
    feed(`^C\r\n${HOST_PROMPT}`)
    feed('cd ~') // trailing now `user@host:~$ cd ~`, ends in ~ but starts with the host prompt
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand') // NOT promoted by the prompt path
    settle()
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })

  it('REGRESSION: a login prompt split across PTY chunks is still captured (line-buffered), so the failure is still caught', () => {
    const id = 'entry-split-login'
    ids.push(id)
    spawnPtyId(id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } })
    feed('user@ho') // the login prompt arrives in two chunks
    feed('st:~$ ')
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(`Some refusal in words we do not list\r\n${HOST_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('REGRESSION: a wrong saved sudo password, then its newline echo, still holds (not promoted) and then fails on the error', () => {
    const id = 'entry-sudo-wrong'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: 'synthetic-wrong' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual(['synthetic-wrong\r'])
    feed('\r\n') // the Enter echo: must NOT blank the sticky prompt and promote
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    expect(states(id)).not.toContain('awaiting-claude')
    feed('Sorry, try again.\r\n[sudo] password for user: ')
    feed(`\r\nsudo: 3 incorrect password attempts\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })
})

describe('round 2: the engine-not-found line is a suspicion the prompt decides', () => {
  it('on the host (no engine installed) with the host prompt back: failed', () => {
    const id = 'entry-nf-host'
    enterContainer(id)
    feed(`bash: docker: command not found\r\n${HOST_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('from an rc file INSIDE a healthy container, followed by the inner prompt: the inner shell (not a failure)', () => {
    const id = 'entry-nf-rcfile'
    enterContainer(id)
    feed(`bash: docker: command not found\r\n${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('from an rc file inside a healthy container whose prompt the regex does not know (starship): still the inner shell on idle', () => {
    // The host prompt is known and did NOT come back, so we cannot be on the host.
    const id = 'entry-nf-rcfile-starship'
    enterContainer(id)
    feed('bash: docker: command not found\r\n~/proj on main \r\n❯ ')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('on a zsh host whose `%` prompt never matches, the idle fallback fails the entry instead of promoting', () => {
    const id = 'entry-nf-zsh'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed('user@mac ~ % ')
    vi.advanceTimersByTime(1600) // the idle fallback carries the flow to awaiting-postcommand
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

describe('round 2: the idle fallback over a silent or waiting entry', () => {
  it('REGRESSION: nothing but the command echo comes back (hung engine): held, then FAILED, never promoted', () => {
    const id = 'entry-hang'
    const cmd = enterContainer(id)
    feed(`${cmd}\r\n`) // the echo is all the remote ever sends
    vi.advanceTimersByTime(6000) // several idle periods: still holding
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    vi.advanceTimersByTime(20000) // past the silence cap
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })

  it('REGRESSION: the host prompt repainted in front of the echo (readline/ConPTY) is still only the echo: held, then FAILED', () => {
    const id = 'entry-hang-repaint'
    const cmd = enterContainer(id)
    feed(`\r${HOST_PROMPT}${cmd}\r\n`) // ConPTY redraws the prompt line with the typed command
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

  it('the repainted echo followed by the inner prompt is a healthy entry', () => {
    const id = 'entry-repaint-then-inner'
    const cmd = enterContainer(id)
    feed(`\r${HOST_PROMPT}${cmd}\r\n`)
    feed(INNER_PROMPT)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('REGRESSION (quality review): a remote that never even echoes, on a flow the idle path carried to awaiting-postcommand, still hits the silence cap', () => {
    const id = 'entry-no-echo'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } } } as never)
    feed('user@mac ~ % ')
    vi.advanceTimersByTime(1600) // idle path -> awaiting-postcommand; no timer left pending
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    // nothing ever comes back
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

  it('a terse genuine line that is a WORD of the command (`bash`) counts as output: the container is not failed', () => {
    const id = 'entry-terse-output'
    const cmd = enterContainer(id)
    feed(`${cmd}\r\nbash\r\n❯ `) // a container that prints its shell name, then a starship prompt
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('echo is a PREFIX of the command, not any substring: a line that is a word from the middle of it is output', () => {
    // Synthetic: a container printing only words that occur inside the command
    // and a prompt (`-it `) that is itself a substring. Pins the rule so a terse
    // container is never mistaken for silence.
    const id = 'entry-substring-output'
    const cmd = enterContainer(id)
    feed(`${cmd}
bash
-it `)
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a slow container start that then prints its prompt still lands on the inner shell', () => {
    const id = 'entry-slow-start'
    const cmd = enterContainer(id)
    feed(`${cmd}\r\n`)
    vi.advanceTimersByTime(6000)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    feed(INNER_PROMPT)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('an inner shell whose prompt the regex does not know (starship) still promotes on idle, as it always did', () => {
    const id = 'entry-starship'
    const cmd = enterContainer(id)
    feed(`${cmd}\r\n`)
    feed('\r\n~/proj on main \r\n❯ ') // ❯ lines strip to '' for prompt purposes; output was seen though
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a sudo prompt waiting for the user (no saved secret) is not promoted over while they type', () => {
    const id = 'entry-sudo-wait'
    enterContainer(id, 'ccc-test', { sudo: true })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(10000)
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    expect(states(id)).not.toContain('awaiting-claude')
    feed(`\r\n${INNER_PROMPT}`) // the user typed it; the entry succeeded
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a sudo prompt the inner shell has since replaced (starship, strips to nothing for the sticky) does NOT hold: promoted at the first idle', () => {
    const id = 'entry-sudo-then-starship'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: 'synthetic-sudo' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    feed('\r\n~/proj on main \r\n❯ ')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('the sudo-prompt hold is BOUNDED, and FAILS (never promotes the host) at the cap: a prompt still waiting after ~61s', () => {
    const id = 'entry-sudo-wait-bound'
    enterContainer(id, 'ccc-test', { sudo: true })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(90000) // well past MAX_ENTRY_PROMPT_HOLD_FIRES x 1.5s
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id)).not.toContain('awaiting-claude')
  })
})

describe('round 2: Run again after a failed entry', () => {
  it('re-runs the post-command from the failed state and judges the new attempt on its own output', () => {
    const id = 'entry-run-again'
    enterContainer(id, 'ccc-test')
    feed(`Error response from daemon: No such container: ccc-test\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    getSshFlow(id)!.runPostCommand()
    expect(getSshFlow(id)?.getState().state).toBe('running-postcommand')
    vi.advanceTimersByTime(201)
    expect(writes()).toEqual(['docker exec -it ccc-test bash\r'])
    writeMock.mockClear()
    feed(INNER_PROMPT) // the user started it in the meantime
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
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
    expect(writes()).toEqual(['sudo docker exec -it ccc-test bash\r', 'synthetic-sudo\r'])
  })

  it('judges the second attempt against the host prompt AS IT STANDS (a cd on the host in between)', () => {
    const id = 'entry-run-again-cd'
    enterContainer(id)
    feed(`Error response from daemon: No such container: ccc-test\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
    feed('cd proj\r\nuser@host:~/proj$ ') // the user moves on the host before clicking Run again
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
    feed(INNER_PROMPT)
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-claude')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(writes()).toEqual([])
  })
})

describe('positive control: a successful entry', () => {
  it('the inner prompt still reaches awaiting-claude / inner, and Launch Claude writes the container setup', () => {
    const id = 'entry-ok'
    enterContainer(id)
    feed(INNER_PROMPT)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(wrote('base64 -d | node')).toBe(true)
  })

  it('ordinary post-command output that merely mentions a container is not a failure', () => {
    const id = 'entry-benign'
    enterContainer(id)
    feed(`Entering container ccc-test (docker)\r\n${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })

  it('a sudo entry with a saved secret: prompt answered, inner shell reached', () => {
    const id = 'entry-sudo-ok'
    enterContainer(id, 'ccc-test', { sudo: true, sudoPassword: 'synthetic-sudo' })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual(['synthetic-sudo\r'])
    feed(`\r\n${INNER_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })
})

describe('the runtime line buffer', () => {
  it('is dropped once the inner shell is accepted', () => {
    const id = 'entry-buf-ok'
    enterContainer(id)
    feed('Entering container')
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeGreaterThan(0)
    feed(`\r\n${INNER_PROMPT}`)
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeUndefined()
  })

  it('is dropped when the session is torn down mid-entry', () => {
    const id = 'entry-buf-teardown'
    enterContainer(id)
    feed('partial output with no newline')
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeGreaterThan(0)
    killPty(id)
    ids.splice(ids.indexOf(id), 1)
    expect(_getSetupLineBufferLenForTest(id, 'runtime')).toBeUndefined()
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
      'sudo: 3 incorrect password attempts',
      'sudo: a password is required',
      'sudo: no password was provided',
      'user is not in the sudoers file.  This incident will be reported.',
      "Sorry, user user is not allowed to execute '/usr/bin/docker exec -it x bash' as root on host.",
      'sudo: docker: command not found',
      'x\rsudo: docker: command not found', // a ConPTY \r repaint counts as a line start
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
    // The `Sorry, user ... is not allowed` alternative must not scan an
    // unbounded run of remote bytes; a bounded char-class keeps the match
    // linear and short. Structural, because the input is attacker-shaped.
    expect(CONTAINER_ENTRY_ERROR_RE.source).not.toContain('.+')
    expect(CONTAINER_ENTRY_ERROR_RE.source).toContain('[^\\r\\n]{0,200} is not allowed')
    // And it still matches a real refusal.
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

  it('REGRESSION: a sudo prompt printed inside an ENTERED container (idle-fallback promotion) is not answered', () => {
    const id = 'sudo-inside-container'
    // No runtime.sudo: the host never prompts, so the secret is still "unsent"
    // when the inner shell appears -- and the idle fallback promotes regardless.
    const cmd = enterContainer(id, 'ccc-test', { sudoPassword: SECRET })
    feed(`${cmd}\r\n${INNER_PROMPT}`)
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
    feed(`\r\n${INNER_PROMPT}`)
    settle()
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    feed('[sudo] password for root: ')
    vi.advanceTimersByTime(200)
    expect(writes()).toEqual([])
  })
})
