// P3.15 round 3 (K1, K2): a PTY's input must never take the app down. On
// Windows node-pty writes a PTY's input to a socket over the console's input
// pipe and gives that socket no 'error' listener; a write that fails there
// (the VM run at 98455d52: "write EAGAIN" right after the program in the PTY
// ended, under node-pty's bundled ConPTY) was an uncaught exception, and the
// app quit. guardPtyInput gives that socket its listener.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'

const { guardPtyInput, ptyInputSocket } = await import('../../../src/main/pty-input-guard')

/** A Windows PTY as node-pty builds it: the input socket on its agent. */
const windowsPty = () => {
  const inSocket = new EventEmitter()
  return { pty: { _agent: { inSocket } }, inSocket }
}
const failure = (code: string) => Object.assign(new Error(`write ${code}`), { code, errno: -4088, syscall: 'write' })

describe('guardPtyInput', () => {
  it('an input socket with no listener throws on an error: what quit the app', () => {
    const { inSocket } = windowsPty()
    expect(() => inSocket.emit('error', failure('EAGAIN'))).toThrow('write EAGAIN')
  })

  it('every error on the input socket is caught (EAGAIN, EPIPE and any other), and the first is reported once', () => {
    for (const code of ['EAGAIN', 'EPIPE', 'EINVAL']) {
      const { pty, inSocket } = windowsPty()
      const seen = vi.fn()
      expect(guardPtyInput(pty, seen), code).toBe(true)
      expect(() => inSocket.emit('error', failure(code)), code).not.toThrow()
      // A later write on the destroyed socket fails again: caught too, not reported again.
      expect(() => inSocket.emit('error', failure('ERR_STREAM_DESTROYED')), code).not.toThrow()
      expect(seen, code).toHaveBeenCalledTimes(1)
      expect(seen.mock.calls[0][0].code, code).toBe(code)
    }
  })

  it('a report that throws is still caught: the guard never lets an error out', () => {
    const { pty, inSocket } = windowsPty()
    guardPtyInput(pty, () => { throw new Error('reporting failed') })
    expect(() => inSocket.emit('error', failure('EAGAIN'))).not.toThrow()
  })

  it('a PTY with no input socket (macOS and Linux, where node-pty handles its own write errors) is left alone', () => {
    for (const pty of [{}, { _agent: {} }, { _agent: { inSocket: 'not a stream' } }, null, undefined]) {
      expect(ptyInputSocket(pty)).toBeNull()
      expect(guardPtyInput(pty, () => {})).toBe(false)
    }
  })

  it('the installed node-pty still writes a Windows PTY\'s input to its agent\'s inSocket (the shape the guard relies on)', () => {
    const lib = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'node-pty', 'lib')
    const terminal = fs.readFileSync(path.join(lib, 'windowsTerminal.js'), 'utf8')
    const agent = fs.readFileSync(path.join(lib, 'windowsPtyAgent.js'), 'utf8')
    expect(terminal).toMatch(/_this\._agent = new windowsPtyAgent_1\.WindowsPtyAgent\(/)
    expect(terminal).toMatch(/this\._agent\.inSocket\.write\(data\)/)
    expect(agent).toMatch(/Object\.defineProperty\(WindowsPtyAgent\.prototype, "inSocket"/)
    expect(agent).toMatch(/this\._inSocket = new net_1\.Socket\(\{/)
    // ...and still gives it no 'error' listener of its own (when it does, the guard is belt and braces).
    expect(agent).not.toMatch(/_inSocket\.on\('error'/)
  })
})
