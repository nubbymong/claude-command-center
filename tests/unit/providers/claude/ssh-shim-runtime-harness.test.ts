// tests/unit/providers/claude/ssh-shim-runtime-harness.test.ts
//
// M7 (adversarial review round 5): the statusline shim (SSH_STATUSLINE_SHIM,
// ssh-shim.ts) was never EXECUTED by any test before this file -- its only
// coverage was source-order and substring assertions (see
// ssh-shim-tmux-statusline.test.ts), which survive any refactor that
// preserves the TEXT but changes the BEHAVIOUR. This extracts the shim's
// real source straight out of generateRemoteSetupScript's output (the exact
// bytes written to the remote, not a re-typed copy) and actually RUNS it,
// with `require('child_process').execFileSync` and `require('fs')`
// substituted for scripted stand-ins -- so the shim's own control flow
// (which branch wins, in which order) is what's under test, not a
// restatement of it.
//
// A real run (adversarial review) also found a false positive this file
// locks down: on a DETACHED tmux session the shim traced tmux-detached but
// `ok` stayed false, so it fell through to the ancestor-pts walk and a
// successful write there logged pts-ok -- a "success" trace for a sentinel
// nobody attached will ever see. Fixed by setting `ok=true` on that branch
// (nothing to display is not a failure to retry from a different device).
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import * as nodePath from 'path'
import { generateRemoteSetupScript } from '../../../../src/main/providers/claude/ssh-shim'

const NONCE = 'testnonce123abc'

/**
 * Pull the shim's REAL source text out of the REAL generateRemoteSetupScript
 * output -- the shim is embedded there as `fs.writeFileSync(shimPath,
 * <JSON-string-literal>,{mode:0o755,flag:'wx'})`. JSON.parse the literal to
 * recover exactly what the remote `node` process would parse back to source;
 * not a second hand-typed copy of SSH_STATUSLINE_SHIM.
 *
 * The write options gained `flag:'wx'` (+ an `rmSync` prefix) when beta hardened
 * the remote ~/.claude writes against a planted symlink (GHSA-phr3-g5qh-q4v5);
 * the end marker tracks that exact shape so a future options change surfaces
 * here instead of silently returning the wrong slice.
 */
function extractShimSource(): string {
  const script = generateRemoteSetupScript('sid-harness', null, undefined, NONCE)
  const marker = 'fs.writeFileSync(shimPath,'
  const idx = script.indexOf(marker)
  expect(idx).toBeGreaterThan(-1)
  const rest = script.slice(idx + marker.length)
  const endMarker = ",{mode:0o755,flag:'wx'})"
  const endIdx = rest.indexOf(endMarker)
  expect(endIdx).toBeGreaterThan(-1)
  const literal = rest.slice(0, endIdx)
  const source: string = JSON.parse(literal)
  // Strip the shebang line -- valid for `node <file>` execution on the
  // remote, but `#!` is not valid syntax for the Function constructor this
  // harness uses to actually run the script in-process.
  return source.replace(/^#!.*\n/, '')
}

interface HarnessResult {
  stdout: string[]
  stderr: string[]
  traces: string[]
  writes: Array<{ path: string; content: string }>
}

interface HarnessOptions {
  env: Record<string, string>
  execFileSync: (file: string, args: string[], opts: unknown) => string
  /** Paths that should report as a character device via fs.statSync(p).isCharacterDevice(). */
  charDevicePaths?: Set<string>
  /** Paths whose fs.writeFileSync call should THROW instead of succeeding. */
  unwritablePaths?: Set<string>
}

/**
 * Actually RUN the shim's real source -- `new Function('require','process',
 * source)` executes it in this process with `require`/`process` shadowed by
 * scripted stand-ins (device I/O and the tmux `display-message` call are
 * the only externally-observable effects a statusLine command has), then
 * feeds it a minimal valid statusline JSON payload on the faked stdin,
 * exactly as Claude Code would.
 */
function runShim(shimSource: string, opts: HarnessOptions): HarnessResult {
  const result: HarnessResult = { stdout: [], stderr: [], traces: [], writes: [] }
  const charDevicePaths = opts.charDevicePaths ?? new Set<string>()
  const unwritablePaths = opts.unwritablePaths ?? new Set<string>()
  const fakeFs = {
    appendFileSync: (_p: string, data: string) => { result.traces.push(String(data)) },
    writeFileSync: (p: string, data: string) => {
      if (unwritablePaths.has(p)) {
        const err = new Error(`EACCES: permission denied, open '${p}'`) as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      result.writes.push({ path: p, content: String(data) })
    },
    statSync: (p: string) => ({ isCharacterDevice: () => charDevicePaths.has(p) }),
    readlinkSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  }
  const fakeOs = { homedir: () => '/fake-home' }
  const fakeChildProcess = { execFileSync: opts.execFileSync }
  const fakeRequire = (name: string): unknown => {
    if (name === 'fs') return fakeFs
    if (name === 'os') return fakeOs
    if (name === 'path') return nodePath
    if (name === 'child_process') return fakeChildProcess
    throw new Error('ssh-shim-runtime-harness: unexpected require: ' + name)
  }
  const fakeStdin = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  const fakeProcess = {
    env: opts.env,
    pid: 4242,
    stdin: fakeStdin,
    stdout: { write: (s: string) => { result.stdout.push(s); return true } },
    stderr: { write: (s: string) => { result.stderr.push(s); return true } },
  }
  // eslint-disable-next-line no-new-func -- deliberate: this IS the harness.
  const runner = new Function('require', 'process', shimSource)
  runner(fakeRequire, fakeProcess)
  // The shim's 'end' handler runs entirely synchronously (JSON.parse, then
  // a chain of try/writeFileSync/catch calls, no awaits) -- emit() calls
  // listeners synchronously, so `result` is fully populated by the time
  // this function returns.
  fakeStdin.emit('data', JSON.stringify({ model: { display_name: 'Test Model' }, context_window: {}, cost: {} }))
  fakeStdin.emit('end')
  return result
}

const BASE_ENV = { TMUX: '/tmp/tmux-1000/default,1234,0', CCC_TMUX_BIN: '/fake/tmux', CLAUDE_MULTI_SESSION_ID: 'sid-harness' }

describe('SSH statusline shim -- real runtime harness (#242 M7)', () => {
  it('extracts real, non-empty shim source containing the $TMUX branch', () => {
    const src = extractShimSource()
    expect(src.length).toBeGreaterThan(200)
    expect(src).toContain('process.env.TMUX')
  })

  // Mutation to prove this can fail: revert the tmux-detached branch to NOT
  // set `ok=true` (the pre-fix shape) -- `result.writes` then gains an
  // entry for '/dev/tty' (the fallback this fix skips), the assertion on
  // writes.length fails, and the trace-order assertion below also flips.
  it('a detached tmux session (empty client_tty) is traced and does NOT fall through to any write attempt', () => {
    const src = extractShimSource()
    const result = runShim(src, {
      env: BASE_ENV,
      execFileSync: () => '', // empty output -> detached
    })
    expect(result.traces.some((t) => t.includes('tmux-detached'))).toBe(true)
    // The false positive this fix closes: no write anywhere (not /dev/tty,
    // not a pts walk hit) once tmux correctly reports "nothing to display".
    expect(result.writes).toHaveLength(0)
    expect(result.traces.some((t) => t.includes('pts-ok'))).toBe(false)
    expect(result.traces.some((t) => t.includes('tty-fail'))).toBe(false)
    // The shim always writes a single space to stdout for Claude's own
    // statusline text, regardless of which OSC path won.
    expect(result.stdout.join('')).toBe(' ')
  })

  // Multi-line display-message output: the shim must take ONLY the first
  // line (`out.split('\n')[0].trim()`), never treat the whole reply as the
  // device path.
  it('multi-line display-message output uses only the FIRST line as the tty path', () => {
    const src = extractShimSource()
    const result = runShim(src, {
      env: BASE_ENV,
      execFileSync: () => '/dev/pts/7\nunexpected-second-line\n',
      charDevicePaths: new Set(['/dev/pts/7']),
    })
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0].path).toBe('/dev/pts/7')
    expect(result.traces.some((t) => t.includes('tmux-clienttty-ok') && t.includes('/dev/pts/7'))).toBe(true)
  })

  // M1 (adversarial review round 5): a display-message reply that is NOT
  // under /dev/ or NOT a character device must be rejected before
  // fs.writeFileSync is ever called on it -- writeFileSync would otherwise
  // CREATE or TRUNCATE an arbitrary regular file at that path.
  it('M1: rejects a non-device path before ever calling writeFileSync on it, then falls through to /dev/tty', () => {
    const src = extractShimSource()
    const result = runShim(src, {
      env: BASE_ENV,
      execFileSync: () => '/tmp/not-a-device',
      // No charDevicePaths entry for '/tmp/not-a-device' -- statSync
      // reports isCharacterDevice() === false.
    })
    expect(result.writes.some((w) => w.path === '/tmp/not-a-device')).toBe(false)
    expect(result.traces.some((t) => t.includes('tmux-fail') && t.includes('not-under-dev'))).toBe(true)
    // Falls through to the /dev/tty fallback, which the default fake
    // succeeds at (no unwritablePaths entry for it).
    expect(result.writes.some((w) => w.path === '/dev/tty')).toBe(true)
  })

  it('M1: rejects a /dev/-prefixed path that is not actually a character device', () => {
    const src = extractShimSource()
    const result = runShim(src, {
      env: BASE_ENV,
      execFileSync: () => '/dev/not-a-chardev',
      charDevicePaths: new Set(), // explicitly NOT a character device
    })
    expect(result.writes.some((w) => w.path === '/dev/not-a-chardev')).toBe(false)
    expect(result.traces.some((t) => t.includes('tmux-fail') && t.includes('not-a-chardev'))).toBe(true)
  })

  // An unwritable target: the display-message reply is a genuine character
  // device (passes M1's validation) but the write itself fails (e.g. a
  // permissions problem) -- the shim must trace the failure and fall
  // through to the next tier rather than throwing out of the stdin handler.
  it('an unwritable (but validated) target is traced as a failure and falls through to /dev/tty', () => {
    const src = extractShimSource()
    const result = runShim(src, {
      env: BASE_ENV,
      execFileSync: () => '/dev/pts/9',
      charDevicePaths: new Set(['/dev/pts/9']),
      unwritablePaths: new Set(['/dev/pts/9']),
    })
    expect(result.writes.some((w) => w.path === '/dev/pts/9')).toBe(false)
    expect(result.traces.some((t) => t.includes('tmux-fail') && t.includes('/dev/pts/9') && t.includes('EACCES'))).toBe(true)
    expect(result.writes.some((w) => w.path === '/dev/tty')).toBe(true)
  })

  // The 2s timeout: execFileSync throwing an ETIMEDOUT-shaped error (what
  // Node's own execFileSync raises when its `timeout` option kills the
  // child) must be caught and traced, not left to propagate out of the
  // stdin 'end' handler and crash the statusLine child.
  it('a hung/half-dead tmux server (execFileSync timeout) is caught, traced, and falls through', () => {
    const src = extractShimSource()
    const result = runShim(src, {
      env: BASE_ENV,
      execFileSync: () => {
        const err = new Error('Command failed') as NodeJS.ErrnoException
        err.code = 'ETIMEDOUT'
        throw err
      },
    })
    expect(result.traces.some((t) => t.includes('tmux-fail') && t.includes('ETIMEDOUT'))).toBe(true)
    expect(result.writes.some((w) => w.path === '/dev/tty')).toBe(true)
    expect(result.stdout.join('')).toBe(' ') // never crashes; always finishes the handler
  })

  // Control: outside tmux entirely ($TMUX unset), the tmux branch must not
  // run at all, and the /dev/tty fallback should be the first (and, here,
  // successful) attempt.
  it('outside tmux ($TMUX unset), goes straight to /dev/tty with no tmux-* trace at all', () => {
    const src = extractShimSource()
    const result = runShim(src, {
      env: { CLAUDE_MULTI_SESSION_ID: 'sid-harness' },
      execFileSync: () => { throw new Error('should never be called') },
    })
    expect(result.traces.some((t) => t.includes('tmux'))).toBe(false)
    expect(result.writes.some((w) => w.path === '/dev/tty')).toBe(true)
  })
})
