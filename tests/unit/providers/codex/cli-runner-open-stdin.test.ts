// Usage track MP7 (ADR-022): the Codex runner's open-stdin mode and the
// app-server operation's constant command line.
//
// Open-stdin: the caller gets a writer just after the spawn, writes whole
// messages and ends stdin itself; a write after the run settled, began
// stopping or had its stdin ended does nothing; `stdin` and `openStdin`
// together start nothing; the deadline and the kill chain are the runner's as
// for any run. The app-server argv is the constant `app-server`, on the native
// route and through the npm shim's cmd.exe line alike.
//
// PURE: an injected spawn returning a scripted child; no process starts.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { runCodexCli, codexCommandLine } from '../../../../src/main/providers/codex/cli-runner'
import type { CodexCommand, CodexRunDeps, CodexStdinWriter } from '../../../../src/main/providers/codex/cli-runner'

class FakeStream extends EventEmitter { setEncoding() { return this } destroy() { return this } }

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess> & { written: string[]; endCalls: number }
  child.written = []
  child.endCalls = 0
  const stdin = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; end: (s?: string) => void; destroy: () => void }
  stdin.write = (s: string) => { child.written.push(s); return true }
  stdin.end = (s?: string) => { if (s !== undefined) child.written.push(s); child.endCalls++ }
  stdin.destroy = () => {}
  Object.assign(child, { stdin, stdout: new FakeStream(), stderr: new FakeStream(), pid: 4242 })
  return child
}

const CMD: CodexCommand = { file: '/usr/local/bin/codex', args: ['app-server'], verbatim: false, cwd: '/usr/local/bin' }

function deps(child: ReturnType<typeof fakeChild>, kill = vi.fn(async () => { child.emit('exit', null); child.emit('close', null) })) {
  const spawn = vi.fn(() => child as unknown as ChildProcess)
  const d: CodexRunDeps = { spawn, platform: 'linux', killTree: kill as unknown as CodexRunDeps['killTree'] }
  return { d, spawn, kill }
}

describe('open-stdin mode (usage track MP7)', () => {
  it('pipes stdin, hands the caller a writer once, and ends stdin only when the caller does', async () => {
    const child = fakeChild()
    const { d, spawn } = deps(child)
    let io: CodexStdinWriter | null = null
    const calls: number[] = []
    const done = runCodexCli(CMD, { env: {}, timeoutMs: 5000, openStdin: (w) => { io = w; calls.push(1) } }, d)
    expect(calls).toEqual([1])
    expect((spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    expect(io!.write('{"id":1}\n')).toBe(true)
    expect(child.endCalls).toBe(0)
    io!.end(); io!.end()
    expect(child.endCalls).toBe(1)
    expect(io!.write('late\n')).toBe(false)
    expect(child.written).toEqual(['{"id":1}\n'])
    child.emit('exit', 0); child.emit('close', 0)
    expect(await done).toMatchObject({ exitCode: 0, timedOut: false })
    expect(io!.write('after\n')).toBe(false)
  })

  it('refuses stdin and openStdin together, and starts nothing', async () => {
    const child = fakeChild()
    const { d, spawn } = deps(child)
    const r = await runCodexCli(CMD, { env: {}, timeoutMs: 5000, stdin: 'x', openStdin: () => {} }, d)
    expect(r.spawnError).toBe('invalid stdin')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('at the deadline the chain is killed with stdin still open, and writes stop', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const { d, kill } = deps(child)
      let io: CodexStdinWriter | null = null
      const done = runCodexCli(CMD, { env: {}, timeoutMs: 1000, openStdin: (w) => { io = w } }, d)
      await vi.advanceTimersByTimeAsync(1001)
      expect(kill).toHaveBeenCalledTimes(1)
      expect(io!.write('x\n')).toBe(false)
      const r = await done
      expect(r).toMatchObject({ timedOut: true, stopped: 'deadline' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a cancel kills the chain', async () => {
    const child = fakeChild()
    const { d, kill } = deps(child)
    const ac = new AbortController()
    const done = runCodexCli(CMD, { env: {}, timeoutMs: 5000, signal: ac.signal, openStdin: () => {} }, d)
    ac.abort()
    const r = await done
    expect(kill).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ stopped: 'cancel' })
  })

  it('a caller that throws gets its stdin closed', async () => {
    const child = fakeChild()
    const { d } = deps(child)
    const done = runCodexCli(CMD, { env: {}, timeoutMs: 5000, openStdin: () => { throw new Error('boom') } }, d)
    expect(child.endCalls).toBe(1)
    child.emit('exit', 1); child.emit('close', 1)
    expect((await done).exitCode).toBe(1)
  })

  it('without stdin or openStdin, stdin is ignored as before', async () => {
    const child = fakeChild()
    const { d, spawn } = deps(child)
    const done = runCodexCli(CMD, { env: {}, timeoutMs: 5000 }, d)
    expect((spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] })
    child.emit('exit', 0); child.emit('close', 0)
    await done
  })
})

// MP7 round 1, quality nit 2: a helper's output arrives in pipe-sized
// chunks, and a UTF-8 character may be split between two of them. The
// runner reads its output through the stream's own decoder, so the text the
// caller gets is whole.
describe('output decoding', () => {
  it('a multi-byte character split across two chunks reaches the caller whole', async () => {
    const child = fakeChild()
    const out = new PassThrough()
    Object.assign(child, { stdout: out })
    const { d } = deps(child)
    const text: string[] = []
    const done = runCodexCli(CMD, { env: {}, timeoutMs: 5000, openStdin: () => {}, onChunk: (s, stream) => { if (stream === 'stdout') text.push(s) } }, d)
    const line = Buffer.from('{"limitName":"Plan ' + String.fromCharCode(0x20ac) + String.fromCodePoint(0x1f600) + '"}\n', 'utf8')
    // Cut inside the three-byte euro sign, then inside the four-byte emoji.
    const euro = line.indexOf(0xe2)
    const emoji = line.indexOf(0xf0)
    out.write(line.subarray(0, euro + 1))
    out.write(line.subarray(euro + 1, emoji + 2))
    out.write(line.subarray(emoji + 2))
    await new Promise((r) => setTimeout(r, 0))
    child.emit('exit', 0); child.emit('close', 0)
    const r = await done
    expect(text.join('')).toBe(line.toString('utf8'))
    expect(text.join('')).not.toContain(String.fromCharCode(0xfffd))
    expect(r.stdout).toBe(line.toString('utf8'))
  })
})

describe('the app-server command line (ADR-022 bound 1)', () => {
  it('is the constant `app-server`, natively and through the npm shim', () => {
    expect(codexCommandLine('/usr/local/bin/codex', 'app-server', 'linux', {})).toEqual({ file: '/usr/local/bin/codex', args: ['app-server'], verbatim: false, cwd: '/usr/local/bin' })
    const shim = codexCommandLine('C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', 'app-server', 'win32', { SystemRoot: 'C:\\Windows' })
    expect(shim).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd" app-server"'],
      verbatim: true,
      cwd: 'C:\\Users\\u\\AppData\\Roaming\\npm',
    })
  })
})
