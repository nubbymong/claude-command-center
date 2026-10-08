// @vitest-environment node
//
// Re-attack r3, MINOR 4: the realm probe's default runner. More output than
// it keeps (maxBuffer) is an UNREADABLE answer, never "did not answer in
// time"; a real timeout is still a timeout; the CLI is run with no shell.
import { describe, it, expect, vi } from 'vitest'

type Cb = (err: unknown, stdout: string) => void
let behave: (cb: Cb) => void = (cb) => cb(null, '{}')
const seen: Array<{ file: string; opts: Record<string, unknown> }> = []
vi.mock('node:child_process', () => ({
  execFile: (file: string, _args: string[], opts: Record<string, unknown>, cb: Cb) => { seen.push({ file, opts }); setTimeout(() => behave(cb), 0); return {} },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { _defaultRealmProbeRunnerForTest: run } = await import('../../src/main/mac-realm-guard')
const opts = { env: {}, cwd: '/', timeoutMs: 10 }

describe('the realm probe runner', () => {
  it('over maxBuffer: oversize, not a timeout', async () => {
    behave = (cb) => cb(Object.assign(new Error('maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }), 'x'.repeat(10))
    const r = await run('/v/claude', ['auth', 'status'], opts)
    expect(r.oversize).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(seen[seen.length - 1]).toMatchObject({ file: '/v/claude', opts: { shell: false } })
  })
  it('a real timeout stays a timeout', async () => {
    behave = (cb) => cb(Object.assign(new Error('killed'), { code: null, killed: true, signal: 'SIGTERM' }), '')
    const r = await run('/v/claude', ['auth', 'status'], opts)
    expect(r.timedOut).toBe(true)
    expect(r.oversize).toBeUndefined()
  })
  it('success: exit 0 and the output', async () => {
    behave = (cb) => cb(null, '{"configDirectory":"/x"}')
    expect(await run('/v/claude', ['auth', 'status'], opts)).toEqual({ code: 0, stdout: '{"configDirectory":"/x"}', timedOut: false })
  })
})
