import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { createCapturedRunner, splitArgs } from '../../src/main/gui-exe-runner'
import { CAPTURED_RUN_MAX_BYTES, CAPTURED_RUN_MAX_CONCURRENT, type ExeSubsystem } from '../../src/shared/gui-exe'

// #379. This runner is the ONE renderer-reachable spawn added by the fix, so
// most of what is pinned here is what it REFUSES. The gate is: a GUI-subsystem
// PE image, at an absolute path we resolved ourselves, with an argv array and no
// shell. Everything else is turned away and keeps its existing route.

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() { /* pushed by the test */ } })
  stderr = new Readable({ read() { /* pushed by the test */ } })
  pid = 4321
  killed = false
  kill(): boolean { this.killed = true; return true }
}

interface Harness {
  runner: ReturnType<typeof createCapturedRunner>
  spawn: ReturnType<typeof vi.fn>
  child: FakeChild
  chunks: Array<{ stream: string; chunk: string }>
  exits: Array<Record<string, unknown>>
  killed: number[]
}

function harness(over: { subsystem?: ExeSubsystem; resolved?: string | null } = {}): Harness {
  const child = new FakeChild()
  const spawn = vi.fn(() => child)
  const chunks: Array<{ stream: string; chunk: string }> = []
  const exits: Array<Record<string, unknown>> = []
  const killed: number[] = []
  let n = 0

  const runner = createCapturedRunner({
    spawn: spawn as never,
    sniff: async () => over.subsystem ?? 'gui',
    resolve: () => (over.resolved === undefined ? 'C:\\tools\\bambu-studio.exe' : over.resolved),
    resolveWorkingDir: (cwd) => cwd ?? 'C:\\work',
    newId: () => `run-${++n}`,
    now: () => 1000,
    killTree: (pid) => { killed.push(pid) },
    platform: 'win32',
  })

  return { runner, spawn, child, chunks, exits, killed }
}

const events = (h: Harness) => ({
  onChunk: (c: { stream: string; chunk: string }) => h.chunks.push(c),
  onExit: (e: Record<string, unknown>) => h.exits.push(e),
})

describe('splitArgs', () => {
  it('splits on whitespace, matching what buildCommandLine produced', () => {
    expect(splitArgs('--debug 2 --zzz-not-a-flag')).toEqual(['--debug', '2', '--zzz-not-a-flag'])
  })

  it('groups a quoted argument', () => {
    expect(splitArgs('--out "C:\\My Files\\a.3mf"')).toEqual(['--out', 'C:\\My Files\\a.3mf'])
    expect(splitArgs("--out 'C:\\My Files\\a.3mf'")).toEqual(['--out', 'C:\\My Files\\a.3mf'])
  })

  it('does NOT treat a backslash as an escape -- it is a path separator here', () => {
    expect(splitArgs('C:\\tools\\x.3mf')).toEqual(['C:\\tools\\x.3mf'])
  })

  it('keeps an explicitly empty quoted argument', () => {
    expect(splitArgs('--name "" --x')).toEqual(['--name', '', '--x'])
  })

  it('is empty for an empty tail', () => {
    expect(splitArgs('')).toEqual([])
    expect(splitArgs('   ')).toEqual([])
  })
})

describe('createCapturedRunner — the gate', () => {
  it('spawns a GUI-subsystem exe with pipes, no shell, and not detached', async () => {
    const h = harness()
    const res = await h.runner.start({ command: 'bambu-studio --debug 2', cwd: 'C:\\work' }, events(h) as never)

    expect(res.runId).toBe('run-1')
    expect(h.spawn).toHaveBeenCalledTimes(1)
    const [file, args, opts] = h.spawn.mock.calls[0] as [string, string[], Record<string, unknown>]

    // The ABSOLUTE path we resolved and sniffed -- never the bare token, which
    // would let the OS search PATH again and run a different file.
    expect(file).toBe('C:\\tools\\bambu-studio.exe')
    expect(args).toEqual(['--debug', '2'])

    // The four options this whole issue turns on.
    expect(opts.shell).toBe(false)          // no shell to inject into
    expect(opts.detached).toBe(false)       // DETACHED_PROCESS still bleeds (#379 matrix row 2)
    expect(opts.windowsHide).toBe(true)
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])  // the pipes that survive
    expect(opts.cwd).toBe('C:\\work')
  })

  it('REFUSES a console-subsystem exe -- it has no bleed problem to solve', async () => {
    const h = harness({ subsystem: 'console' })
    const res = await h.runner.start({ command: 'git status' }, events(h) as never)
    expect(res.runId).toBeNull()
    expect(res.error).toMatch(/not a GUI-subsystem/)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('REFUSES a .cmd/.bat shim -- not a PE, and the cmd.exe re-parse is the CVE-2024-27980 class', async () => {
    const h = harness({ subsystem: 'not-pe', resolved: 'C:\\tools\\tool.cmd' })
    const res = await h.runner.start({ command: 'tool --flag' }, events(h) as never)
    expect(res.runId).toBeNull()
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('REFUSES a driver/EFI image (Subsystem neither 2 nor 3)', async () => {
    const h = harness({ subsystem: 'other' })
    const res = await h.runner.start({ command: 'weird' }, events(h) as never)
    expect(res.runId).toBeNull()
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('refuses a command whose program cannot be resolved', async () => {
    const h = harness({ resolved: null })
    const res = await h.runner.start({ command: '$env:TOOL --version' }, events(h) as never)
    expect(res.runId).toBeNull()
    expect(res.error).toMatch(/Could not find/)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('refuses a line with no program at all', async () => {
    const h = harness()
    expect((await h.runner.start({ command: '   ' }, events(h) as never)).runId).toBeNull()
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('never lets shell metacharacters become anything but literal argv', async () => {
    // There is no shell, so these are ordinary characters. Pinned because the
    // moment someone "helpfully" adds shell:true, this test fails.
    const h = harness()
    await h.runner.start({ command: 'bambu-studio a&b c|d $(x) `y` ;z' }, events(h) as never)
    const [, args] = h.spawn.mock.calls[0] as [string, string[]]
    expect(args).toEqual(['a&b', 'c|d', '$(x)', '`y`', ';z'])
  })

  it('refuses more arguments than a command button could plausibly carry', async () => {
    const h = harness()
    const many = Array.from({ length: 200 }, (_, i) => `--a${i}`).join(' ')
    const res = await h.runner.start({ command: `bambu-studio ${many}` }, events(h) as never)
    expect(res.runId).toBeNull()
    expect(res.error).toMatch(/Too many arguments/)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('refuses a single absurdly long argument', async () => {
    const h = harness()
    const res = await h.runner.start({ command: `bambu-studio ${'x'.repeat(5000)}` }, events(h) as never)
    expect(res.runId).toBeNull()
    expect(h.spawn).not.toHaveBeenCalled()
  })
})

describe('createCapturedRunner — capture', () => {
  it('streams stdout and stderr back, tagged, with the runId in every chunk', async () => {
    const h = harness()
    const res = await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    h.child.stdout.push(Buffer.from('banner line\n'))
    h.child.stderr.push(Buffer.from('a warning\n'))
    await new Promise((r) => setImmediate(r))

    expect(h.chunks).toEqual([
      { runId: res.runId, stream: 'stdout', chunk: 'banner line\n' },
      { runId: res.runId, stream: 'stderr', chunk: 'a warning\n' },
    ])
  })

  it('carries the runId on the exit event too, so a fast process cannot be missed', async () => {
    const h = harness()
    const res = await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    h.child.emit('close', 0, null)
    expect(h.exits).toEqual([{ runId: res.runId, code: 0, signal: null, truncated: false, durationMs: 0 }])
  })

  it('reports a non-zero exit -- the worked example exits 0xFFFFFFFE on a bad flag', async () => {
    const h = harness()
    await h.runner.start({ command: 'bambu-studio --zzz-not-a-flag' }, events(h) as never)
    h.child.emit('close', 4294967294, null)
    expect(h.exits[0].code).toBe(4294967294)
  })

  it('does not split a multi-byte character across two chunks', async () => {
    const h = harness()
    await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    const euro = Buffer.from('€', 'utf8') // 3 bytes
    h.child.stdout.push(euro.subarray(0, 2))
    h.child.stdout.push(euro.subarray(2))
    await new Promise((r) => setImmediate(r))
    expect(h.chunks.map((c) => c.chunk).join('')).toBe('€')
  })

  it('caps output and flags it, without killing the process', async () => {
    const h = harness()
    await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    h.child.stdout.push(Buffer.alloc(CAPTURED_RUN_MAX_BYTES + 1000, 0x61))
    await new Promise((r) => setImmediate(r))
    const total = h.chunks.reduce((n, c) => n + c.chunk.length, 0)
    expect(total).toBe(CAPTURED_RUN_MAX_BYTES)
    expect(h.child.killed).toBe(false)

    h.child.emit('close', 0, null)
    expect(h.exits[0].truncated).toBe(true)
  })

  it('reports a spawn error rather than hanging', async () => {
    const h = harness()
    await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    h.child.emit('error', new Error('EACCES'))
    expect(h.exits[0]).toMatchObject({ code: null, error: 'EACCES' })
  })

  it('settles exactly once even when error and close both fire', async () => {
    const h = harness()
    await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    h.child.emit('error', new Error('boom'))
    h.child.emit('close', 1, null)
    expect(h.exits).toHaveLength(1)
  })
})

describe('createCapturedRunner — lifecycle', () => {
  it('cancels a run, killing the process tree', async () => {
    const h = harness()
    const res = await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    expect(h.runner.activeCount()).toBe(1)
    expect(h.runner.cancel(res.runId!)).toBe(true)
    expect(h.child.killed).toBe(true)
    expect(h.killed).toEqual([4321])
  })

  it('cancelling an unknown runId is false, not a throw', async () => {
    const h = harness()
    expect(h.runner.cancel('nope')).toBe(false)
  })

  it('drops the run from the active set when it exits', async () => {
    const h = harness()
    await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    expect(h.runner.activeCount()).toBe(1)
    h.child.emit('close', 0, null)
    expect(h.runner.activeCount()).toBe(0)
  })

  it('refuses to exceed the concurrency cap', async () => {
    const h = harness()
    for (let i = 0; i < CAPTURED_RUN_MAX_CONCURRENT; i++) {
      // A fresh child per start so they all stay active.
      h.spawn.mockImplementationOnce(() => new FakeChild() as never)
      const r = await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
      expect(r.runId).not.toBeNull()
    }
    const over = await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    expect(over.runId).toBeNull()
    expect(over.error).toMatch(/Too many captured runs/)
  })

  it('cancelAll kills everything still running', async () => {
    const h = harness()
    const kids = [new FakeChild(), new FakeChild()]
    h.spawn.mockImplementationOnce(() => kids[0] as never).mockImplementationOnce(() => kids[1] as never)
    await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    await h.runner.start({ command: 'bambu-studio' }, events(h) as never)
    h.runner.cancelAll()
    expect(kids[0].killed).toBe(true)
    expect(kids[1].killed).toBe(true)
  })
})
