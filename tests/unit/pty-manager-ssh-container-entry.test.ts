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

  it('a bare host prompt with no text before it (an unknown refusal) fails the entry', () => {
    const id = 'entry-bare-return'
    enterContainer(id)
    feed(`\r\n${HOST_PROMPT}`)
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('the host prompt coming back mid-chunk (followed by more output) is still seen', () => {
    const id = 'entry-mid-chunk'
    enterContainer(id)
    feed(`sudo: a password is required\r\n${HOST_PROMPT}\r\n`)
    expect(getSshFlow(id)?.getState().state).toBe('failed')
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
    feed('Error: no such container\r\nuser@host:~/proj$ ') // unknown text; the CURRENT host prompt returns
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

describe('round 2: the engine-not-found line is a suspicion the prompt decides', () => {
  it('on the host (no engine installed) with the host prompt back: failed', () => {
    const id = 'entry-nf-host'
    enterContainer(id)
    feed(`bash: docker: command not found\r\n${HOST_PROMPT}`)
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

  it('the sudo-prompt hold is BOUNDED: a stale prompt line can delay but never wedge the flow', () => {
    const id = 'entry-sudo-wait-bound'
    enterContainer(id, 'ccc-test', { sudo: true })
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(90000) // well past MAX_ENTRY_PROMPT_HOLD_FIRES x 1.5s
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-claude')
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
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
    expect(states(id).filter((s) => s === 'awaiting-claude')).toEqual([])
  })

  it('a second failure is caught the same way', () => {
    const id = 'entry-run-again-fail'
    enterContainer(id)
    feed(`\r\n${HOST_PROMPT}`)
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
    ]) expect(CONTAINER_ENTRY_ERROR_RE.test(line), line).toBe(true)
  })
  it('CONTAINER_ENTRY_ERROR_RE does not match a prompt, a benign mention, the bare shell not-found line, or "is not running" alone', () => {
    for (const line of [
      'root@abc:/# ', 'user@host:~$ ', 'docker exec -it ccc-test bash', 'Entering container',
      'bash: docker: command not found', 'zsh: command not found: podman',
      'my-service is not running, starting it', 'checking docker: not found in cache, pulling',
    ]) expect(CONTAINER_ENTRY_ERROR_RE.test(line), line).toBe(false)
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
