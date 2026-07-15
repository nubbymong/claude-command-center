import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { Writable } from 'stream'

const stdinChunks: string[] = []
let lastSpawnArgs: string[] | null = null
let mockExitCode = 0
let mockStdout = ''
let mockStderr = ''

vi.mock('child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    lastSpawnArgs = [...args]
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = Object.assign(new Writable({
      write(chunk: any, _enc: BufferEncoding, cb: () => void) {
        stdinChunks.push(chunk.toString())
        cb()
      },
    }), { writable: true })
    proc.kill = vi.fn()
    queueMicrotask(() => {
      if (mockStdout) proc.stdout.emit('data', mockStdout)
      if (mockStderr) proc.stderr.emit('data', mockStderr)
      proc.emit('close', mockExitCode)
    })
    return proc
  },
}))

beforeEach(() => {
  stdinChunks.length = 0
  lastSpawnArgs = null
  mockExitCode = 0
  mockStdout = ''
  mockStderr = ''
})

describe('codexLoginWithApiKey', () => {
  it('passes the key via stdin and not via args', async () => {
    const { codexLoginWithApiKey } = await import('../../../../src/main/providers/codex/auth')
    const out = await codexLoginWithApiKey('sk-test-secret')
    expect(out.ok).toBe(true)
    expect(lastSpawnArgs).toEqual(['login', '--with-api-key'])
    expect(stdinChunks.join('')).toContain('sk-test-secret')
    expect(lastSpawnArgs?.includes('sk-test-secret')).toBe(false)
  })

  it('redacts the api-key from the error message on failure', async () => {
    mockExitCode = 1
    mockStderr = 'Authentication failed for key sk-test-secret due to invalid credentials'
    const { codexLoginWithApiKey } = await import('../../../../src/main/providers/codex/auth')
    const out = await codexLoginWithApiKey('sk-test-secret')
    expect(out.ok).toBe(false)
    expect(out.error).toBeDefined()
    expect(out.error).not.toContain('sk-test-secret')
    expect(out.error).toContain('***REDACTED***')
  })
})

describe('codexLogout', () => {
  it('returns { ok: true } when subprocess exits 0', async () => {
    mockExitCode = 0
    const { codexLogout } = await import('../../../../src/main/providers/codex/auth')
    const out = await codexLogout()
    expect(out).toEqual({ ok: true })
    expect(lastSpawnArgs).toEqual(['logout'])
  })

  it('returns { ok: false } when subprocess exits non-zero', async () => {
    mockExitCode = 1
    const { codexLogout } = await import('../../../../src/main/providers/codex/auth')
    const out = await codexLogout()
    expect(out).toEqual({ ok: false })
  })
})
