// rc.14 review F1 (aicc_planning#45): a container entry that fails must not
// become "the inner shell".
//
// After the runtime post-command (`docker exec -it <name> bash`) went out, the
// NEXT shell prompt was taken as the inner shell unconditionally. When the
// container is stopped or missing, or the engine is down, the failed exec
// returns to the HOST shell -- and Launch Claude then wrote the container
// setup and the claude command to the host. The flow now recognises the
// engines' failure shapes in the post-command's own output, fails, and keeps
// refusing the host ladder. Real pty-manager SSH flow, mocked transport (the
// harness shape the external review used); a successful entry is the positive
// control.
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

const { spawnPty, getSshFlow, killPty, CONTAINER_ENTRY_ERROR_RE } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const win = { webContents: { send: vi.fn() }, isDestroyed: () => false } as never
const ssh = { username: 'user', host: 'invalid.example', port: 22, remotePath: '~' }
const feed = (text: string) => onDataListeners.forEach((cb) => cb(text))
const wrote = (needle: string) => writeMock.mock.calls.some(([s]) => String(s).includes(needle))
const ids: string[] = []

function enterContainer(id: string, container = 'ccc-test') {
  ids.push(id)
  spawnPty(win, id, { ssh: { ...ssh, runtime: { type: 'container', engine: 'docker', container } } } as never)
  feed('user@host:~$ ')
  getSshFlow(id)!.runPostCommand()
  vi.advanceTimersByTime(201)
  expect(writeMock).toHaveBeenCalledWith(`docker exec -it ${container} bash\r`)
  writeMock.mockClear()
}

beforeEach(() => {
  vi.useFakeTimers()
  onDataListeners.length = 0
  writeMock.mockReset()
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
    feed('Error response from daemon: No such container: missing-review\r\nuser@host:~$ ')
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'failed', info: 'container entry failed' })
  })

  it('Launch Claude after the failure re-emits it and writes NOTHING to the host', () => {
    const id = 'entry-missing-launch'
    enterContainer(id, 'missing-review')
    feed('Error response from daemon: No such container: missing-review\r\nuser@host:~$ ')
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
    feed('user@host:~$ ')
    vi.advanceTimersByTime(5000) // well past the 1.5 s idle window
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })

  it('the error split across two chunks is still seen (line-buffered)', () => {
    const id = 'entry-split'
    enterContainer(id)
    feed('Error response from dae')
    feed('mon: container ccc-test is not running\r\nuser@host:~$ ')
    expect(getSshFlow(id)?.getState().state).toBe('failed')
  })

  it('Skip remains the explicit route onto the raw host shell', () => {
    const id = 'entry-skip'
    enterContainer(id)
    feed('Error response from daemon: No such container: ccc-test\r\nuser@host:~$ ')
    getSshFlow(id)!.skip()
    expect(getSshFlow(id)?.getState().state).toBe('skipped')
  })
})

describe('positive control: a successful entry', () => {
  it('the inner prompt still reaches awaiting-claude / inner, and Launch Claude writes the container setup', () => {
    const id = 'entry-ok'
    enterContainer(id)
    feed('root@0a1b2c3d4e5f:/# ')
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
    getSshFlow(id)!.launchClaude()
    vi.advanceTimersByTime(301)
    expect(wrote('base64 -d | node')).toBe(true)
  })

  it('ordinary post-command output that merely mentions a container is not a failure', () => {
    const id = 'entry-benign'
    enterContainer(id)
    feed('Entering container ccc-test (docker)\r\nroot@0a1b2c3d4e5f:/# ')
    expect(getSshFlow(id)?.getState()).toEqual({ state: 'awaiting-claude', info: 'inner' })
  })
})

describe('the failure shapes', () => {
  it('cover stopped/missing containers, engine down, engine missing, runtime exec failure', () => {
    for (const line of [
      'Error response from daemon: No such container: x',
      'Error response from daemon: container x is not running',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      'Cannot connect to Podman daemon',
      'bash: docker: command not found',
      'zsh: command not found: podman',
      'Error: no container with name or ID "x" found: no such container',
      'OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found',
    ]) expect(CONTAINER_ENTRY_ERROR_RE.test(line), line).toBe(true)
  })
  it('do not match a container prompt or a benign mention', () => {
    for (const line of ['root@abc:/# ', 'user@host:~$ ', 'docker exec -it ccc-test bash', 'Entering container']) {
      expect(CONTAINER_ENTRY_ERROR_RE.test(line), line).toBe(false)
    }
  })
})
