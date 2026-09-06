// rc.15 review R8 (Codex, 2026-09-06; aicc_planning#55 adjacent): the reviewer's
// characterization ("F11 residual: FOUND is emitted before execution, so a tmux
// operational failure still parses as verified empty") flipped into the desired
// behaviour, credit Codex rc.15 stability review; RED against 7ef62a2e before
// this change. Per Codex 4.2, the PRODUCTION builder is run under a real POSIX
// sh against synthetic tmux binaries -- hand-built frames would only prove the
// parser accepts what the test author imagined. Positive controls are labelled.
//
// The probe used to print FOUND before `ls` ran and discard stderr, so a client
// that existed but could not talk to a still-running server (protocol mismatch
// after an upgrade, permission error) printed FOUND and nothing else -- the
// exact shape of "no sessions" -- and a live detached session was pruned. Now
// `ls` runs first, FOUND carries its exit status, its output follows, and only
// status 0 (names) or tmux's own "no server" phrasings are authoritative; every
// other failure leaves the host UNVERIFIED and prunes nothing.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileMock,
}))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
}))
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no PTY in this test') } }))

const { buildTmuxListCommand, parseTmuxLivenessOutput, TMUX_LIVENESS_BEGIN, TMUX_LIVENESS_END, TMUX_LIVENESS_FOUND } = await import('../../../src/main/ssh-liveness')
const { probeTmuxLive } = await import('../../../src/main/pty-manager')
const { deadSessionIds, hasUnverifiedOffer } = await import('../../../src/renderer/utils/detachedRemotesLiveness')

function have(shell: string): boolean {
  const r = spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore', timeout: 10000, windowsHide: true })
  return !r.error && r.status === 0
}
const HAVE_SH = have('sh')

// Never a silent skip: a runner without `sh` cannot run the R8 gate, and must say
// so in red rather than report green.
it('a POSIX sh is available on this runner (the R8 gate needs it)', () => { expect(HAVE_SH).toBe(true) })

// A synthetic tmux whose behaviour the test picks per run. Installed as the
// on-PATH candidate (a temp bin dir first on PATH) and, when asked, as the
// staged candidate ("$HOME"/.claude/bin/tmux, with HOME pointed at a temp dir).
const MODES: Record<string, string> = {
  names: 'printf "ccc-live1\\nccc-live2\\n"; exit 0',
  empty: 'exit 0',
  noserver: 'echo "no server running on /tmp/tmux-1000/default" >&2; exit 1',
  nosuchfile: 'echo "error connecting to /tmp/tmux-1000/default (No such file or directory)" >&2; exit 1',
  oldnoserver: 'echo "failed to connect to server: No such file or directory" >&2; exit 1',
  mismatch: 'echo "protocol version mismatch (client 8, server 7)" >&2; exit 1',
  denied: 'echo "error connecting to /tmp/tmux-0/default (Permission denied)" >&2; exit 1',
  crash: 'exit 134',
  lost: 'echo "lost server" >&2; exit 1',
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-liveness-r8-'))
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function fakeTmux(dir: string, mode: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'tmux')
  fs.writeFileSync(f, `#!/bin/sh\n${MODES[mode]}\n`)
  fs.chmodSync(f, 0o755)
}
/** Run the PRODUCTION probe command under sh with the synthetic tmux binaries. */
function runProbe(onPath: string, staged?: string): string {
  const run = fs.mkdtempSync(path.join(tmp, 'run-'))
  const bin = path.join(run, 'bin')
  fakeTmux(bin, onPath)
  const home = path.join(run, 'home')
  fs.mkdirSync(home, { recursive: true })
  if (staged) fakeTmux(path.join(home, '.claude', 'bin'), staged)
  const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
  const r = spawnSync('sh', ['-c', buildTmuxListCommand()], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, PATH: `${posix(bin)}:${process.env.PATH ?? ''}`, HOME: posix(home) },
  })
  if (r.error) throw r.error
  return r.stdout
}

const target = { username: 'u', host: 'h.invalid', port: 22 }
const probeWith = (raw: string) => {
  execFileMock.mockImplementationOnce((_bin: unknown, _args: unknown, _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
    cb(null, raw, '')
    return { unref() {} }
  })
  return probeTmuxLive(target, ['live-before-tmux-upgrade'])
}
const UNVERIFIED = { outcome: 'unverified', liveSessionIds: [] as string[] }

beforeEach(() => { execFileMock.mockReset() })

describe.skipIf(!HAVE_SH)('the production probe under a real sh (Codex R8, flipped)', () => {
  it('Codex: a found client whose `ls` fails with a protocol mismatch -> UNVERIFIED, nothing pruned, the entry stays offered with the "could not verify" note', async () => {
    const raw = runProbe('mismatch')
    const parsed = parseTmuxLivenessOutput(raw)
    // frames[0] is the on-PATH candidate (first in the candidate order); a real
    // tmux at an absolute candidate path on the runner adds later frames.
    expect(parsed.frames[0]).toEqual({ status: 1, outcome: 'error', lines: ['protocol version mismatch (client 8, server 7)'] })
    expect(parsed.completed).toBe(false) // 7ef62a2e: completed:true, names:[] -- verified empty
    expect(parsed.unverifiedReason).toContain('protocol version mismatch')
    const result = await probeWith(raw)
    expect(result).toEqual(UNVERIFIED) // 7ef62a2e: verified, liveSessionIds []
    expect(deadSessionIds(['live-before-tmux-upgrade'], result)).toEqual([]) // 7ef62a2e: pruned as dead
    const entry = { sessionId: 'live-before-tmux-upgrade', configId: 'cfg', host: 'h.invalid', username: 'u', remotePath: '~', mux: 'tmux' as const, detachedAt: 1 }
    expect(hasUnverifiedOffer([entry], { 'live-before-tmux-upgrade': 'unverified' })).toBe(true)
  })

  it('a permission error on the socket -> UNVERIFIED', async () => {
    const raw = runProbe('denied')
    expect(parseTmuxLivenessOutput(raw).completed).toBe(false)
    expect(await probeWith(raw)).toEqual(UNVERIFIED)
  })

  it('a client that dies without a word (exit 134) -> UNVERIFIED', async () => {
    const raw = runProbe('crash')
    const parsed = parseTmuxLivenessOutput(raw)
    expect(parsed.frames[0]).toMatchObject({ status: 134, outcome: 'error', lines: [] })
    expect(parsed.completed).toBe(false)
    expect(parsed.unverifiedReason).toContain('exited 134')
  })

  it('"lost server" is an operational failure, not an empty answer -> UNVERIFIED', async () => {
    expect(parseTmuxLivenessOutput(runProbe('lost')).completed).toBe(false)
  })

  it('mixed candidates: one lists names, another cannot talk to its server -> UNVERIFIED (a server the first did not see may exist)', async () => {
    const raw = runProbe('names', 'mismatch')
    const parsed = parseTmuxLivenessOutput(raw)
    expect(parsed.frames[0].outcome).toBe('names') // on-PATH candidate
    expect(parsed.frames.at(-1)?.outcome).toBe('error') // the staged candidate, last in the order
    expect(parsed.completed).toBe(false)
    expect(await probeWith(raw)).toEqual(UNVERIFIED)
  })

  for (const mode of ['noserver', 'nosuchfile', 'oldnoserver'] as const) {
    it(`positive control: tmux saying there is no server (${mode}) is an AUTHORITATIVE empty answer -> verified, the queried id IS dead`, async () => {
      const raw = runProbe(mode)
      const parsed = parseTmuxLivenessOutput(raw)
      expect(parsed.frames[0].outcome).toBe('no-server')
      expect(parsed.completed).toBe(true)
      expect(parsed.names).not.toContain('live-before-tmux-upgrade')
      const result = await probeWith(raw)
      expect(result).toEqual({ outcome: 'verified', liveSessionIds: [] })
      expect(deadSessionIds(['live-before-tmux-upgrade'], result)).toEqual(['live-before-tmux-upgrade'])
    })
  }

  it('positive control: a compatible live client lists its sessions -> verified with names', async () => {
    const raw = runProbe('names')
    const parsed = parseTmuxLivenessOutput(raw)
    expect(parsed.completed).toBe(true)
    expect(parsed.names).toEqual(expect.arrayContaining(['ccc-live1', 'ccc-live2']))
    expect(parsed.frames[0]).toEqual({ status: 0, outcome: 'names', lines: ['ccc-live1', 'ccc-live2'] })
  })

  it('positive control: a true empty listing (exit 0, no names) is verified-empty', async () => {
    const parsed = parseTmuxLivenessOutput(runProbe('empty'))
    expect(parsed.completed).toBe(true)
    expect(parsed.frames[0]).toEqual({ status: 0, outcome: 'names', lines: [] })
  })

  it('positive control: two authoritative candidates: names from one, no server from the other -> verified with the union', async () => {
    const parsed = parseTmuxLivenessOutput(runProbe('names', 'noserver'))
    expect(parsed.frames[0].outcome).toBe('names')
    expect(parsed.frames.at(-1)?.outcome).toBe('no-server')
    expect(parsed.completed).toBe(true)
    expect(parsed.names).toEqual(expect.arrayContaining(['ccc-live1', 'ccc-live2']))
  })
})

describe('frames the builder could not have written (fail-open)', () => {
  const run = (body: string) => parseTmuxLivenessOutput(`${TMUX_LIVENESS_BEGIN}\n${body}${TMUX_LIVENESS_END}\n`)

  it('a FOUND with no status (the pre-R8 shape, or a forgery) is a malformed frame -> UNVERIFIED, never empty', () => {
    const parsed = run(`${TMUX_LIVENESS_FOUND}\n`)
    expect(parsed.frames[0]).toMatchObject({ status: null, outcome: 'error' })
    expect(parsed.completed).toBe(false)
    expect(parsed.unverifiedReason).toContain('malformed')
  })

  it('a FOUND with a non-numeric status is malformed too', () => {
    expect(run(`${TMUX_LIVENESS_FOUND} ok\nccc-a\n`).completed).toBe(false)
  })

  it('a non-zero status with text that is not tmux\'s no-server phrasing is an error, even if it mentions the socket', () => {
    expect(run(`${TMUX_LIVENESS_FOUND} 1\nerror connecting to /tmp/tmux-1000/default (Connection refused)\n`).frames[0].outcome).toBe('error')
  })

  it('positive control: no FOUND at all (no candidate binary exists) stays unverified, as rc.14 F11 made it', () => {
    const parsed = run('')
    expect(parsed).toMatchObject({ completed: false, shellCompleted: true, tmuxFound: false })
    expect(parsed.unverifiedReason).toContain('no tmux binary')
  })
})
