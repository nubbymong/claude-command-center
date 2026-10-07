// @vitest-environment node
//
// The darwin store's DEFAULT `security` runner (adversarial review pass 3,
// m12): how execFile's outcomes map to { code, timedOut }, which every caller's
// found / not-found / unknown decision rests on. A timeout or a missing binary
// must never look like exit 44 ("not found" = signed out), and the secret goes
// through stdin only. child_process is mocked; nothing runs.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Cb = (err: unknown, stdout: string, stderr: string) => void
const seen: { file: string; args: string[]; opts: Record<string, unknown>; stdinEnd: unknown[] }[] = []
let behave: (cb: Cb) => void = (cb) => cb(null, '', '')
let throwSync: Error | null = null

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], opts: Record<string, unknown>, cb: Cb) => {
    if (throwSync) throw throwSync
    const rec = { file, args, opts, stdinEnd: [] as unknown[] }
    seen.push(rec)
    setTimeout(() => behave(cb), 0)
    return { stdin: { end: (v: unknown) => { rec.stdinEnd.push(v) } } }
  },
}))

const { _defaultSecurityRunnerForTest: run, SECURITY_BIN } = await import('../../src/main/claude-credential-store-darwin')

beforeEach(() => { seen.length = 0; throwSync = null })

describe('defaultRunner', () => {
  it('success: code 0, stdout kept; the absolute binary, no shell, the timeout, stdin carries the input', async () => {
    behave = (cb) => cb(null, 'out\n', '')
    expect(await run(['-i'], { input: 'secret-line\n', timeoutMs: 1234 })).toEqual({ code: 0, stdout: 'out\n', stderr: '', timedOut: false })
    expect(seen[0].file).toBe(SECURITY_BIN)
    expect(seen[0].args).toEqual(['-i'])
    expect(seen[0].opts).toMatchObject({ shell: false, timeout: 1234 })
    expect(seen[0].stdinEnd).toEqual(['secret-line\n'])
  })

  it('a non-zero exit keeps its numeric code (44 = not found), not timed out', async () => {
    behave = (cb) => cb(Object.assign(new Error('exit'), { code: 44, killed: false, signal: null }), '', '')
    expect(await run(['find-generic-password'], { timeoutMs: 10 })).toEqual({ code: 44, stdout: '', stderr: '', timedOut: false })
  })

  it('a timeout kill: timedOut, and NO exit code (never mistaken for 44)', async () => {
    behave = (cb) => cb(Object.assign(new Error('killed'), { code: null, killed: true, signal: 'SIGTERM' }), '', '')
    expect(await run(['find-generic-password'], { timeoutMs: 10 })).toEqual({ code: null, stdout: '', stderr: '', timedOut: true })
  })

  it('a kill by another signal is still no exit code', async () => {
    behave = (cb) => cb(Object.assign(new Error('killed'), { code: null, killed: false, signal: 'SIGKILL' }), '', '')
    const r = await run(['find-generic-password'], { timeoutMs: 10 })
    expect(r.code).toBeNull()
  })

  it('ENOENT (no /usr/bin/security): no exit code, not timed out', async () => {
    behave = (cb) => cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', '')
    expect(await run(['find-generic-password'], { timeoutMs: 10 })).toEqual({ code: null, stdout: '', stderr: '', timedOut: false })
  })

  it('execFile throwing synchronously resolves (never rejects) with no exit code', async () => {
    throwSync = new Error('EAGAIN')
    expect(await run(['find-generic-password'], { timeoutMs: 10 })).toEqual({ code: null, stdout: '', stderr: 'EAGAIN', timedOut: false })
  })

  it('no input: stdin is still closed (empty), so security -i never waits on it', async () => {
    behave = (cb) => cb(null, '', '')
    await run(['find-generic-password'], { timeoutMs: 10 })
    expect(seen[0].stdinEnd).toEqual([''])
  })
})
