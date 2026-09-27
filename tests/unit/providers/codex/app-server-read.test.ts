// Usage track MP7 (ADR-022; the owner's scoped WP1.41 exception): one Codex
// usage read through `codex app-server`, orchestrated by the auth operations.
//
// Only a discovered CLI whose version is `supported` (never too-new, too-old
// or unknown); only a managed realm (this computer's own Codex folder is
// never read); the realm's status-run checks; CODEX_HOME the realm and the
// allowlisted environment (no ambient OpenAI or Codex authority); the realm
// held as a reader until the chain has ended; one helper at a time; the
// constant argv; exactly the three messages; the answer must name the realm;
// after the verdict stdin is closed and, if the helper does not exit within
// the grace period, its chain is killed; the initialize answer and the whole
// read are bounded; every failure fails closed.
//
// PURE: an injected run stands in for the runner (it drives openStdin and
// onChunk as the real one does); no process starts.
import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import { createCodexAuthOperations } from '../../../../src/main/providers/codex/auth-operations'
import type { CodexAuthDeps } from '../../../../src/main/providers/codex/auth-operations'
import type { CodexCommand, CodexRunOptions, CodexRunResult, CodexStdinWriter } from '../../../../src/main/providers/codex/cli-runner'
import { codexRealmHome } from '../../../../src/main/providers/codex/realm-paths'
import {
  APP_SERVER_EXIT_GRACE_MS, APP_SERVER_INITIALIZE_TIMEOUT_MS, APP_SERVER_READ_DEADLINE_MS,
} from '../../../../src/main/providers/codex/app-server-client'

const RES = 'C:\\Users\\u\\AppData\\Roaming\\conductor'
const EXT = 'C:\\Users\\u\\.codex'
const EXE = 'C:\\Tools\\codex.exe'
const MANAGED = 'realm-' + 'a'.repeat(32)
const EXTERNAL = 'realm-' + 'b'.repeat(32)
const STAT = { size: 10, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '2', isFile: true }
const homeOf = (id: string) => {
  const realm = id === EXTERNAL
    ? { id, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'external-default' as const, pathRef: 'external-default' }
    : { id, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'conductor-managed' as const, pathRef: `managed:${id}` }
  const h = codexRealmHome(realm, { resourcesDir: RES, externalDefaultHome: EXT }, path.win32)
  if (!h.ok) throw new Error(h.message)
  return { realm, home: h.home }
}

type Helper = (io: { write: (s: string) => void; messages: string[]; exit: (code?: number) => void; ended: () => boolean; signal: AbortSignal }, opts: CodexRunOptions) => void

/** A stand-in for the runner: runs `helper` as the "process". It settles when
 *  the helper exits, or when the run is stopped (deadline or cancel: the
 *  kill chain), as the real runner does. */
function fakeRun(helper: Helper) {
  const runs: Array<{ cmd: CodexCommand; opts: CodexRunOptions; messages: string[]; killed: boolean }> = []
  const run = vi.fn((cmd: CodexCommand, opts: CodexRunOptions) => new Promise<CodexRunResult>((resolve) => {
    const rec = { cmd, opts, messages: [] as string[], killed: false }
    runs.push(rec)
    let done = false
    let stdinEnded = false
    const settle = (r: Partial<CodexRunResult>) => { if (!done) { done = true; resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, ...r }) } }
    const deadline = setTimeout(() => { rec.killed = true; settle({ timedOut: true, stopped: 'deadline' }) }, opts.timeoutMs)
    opts.signal?.addEventListener('abort', () => { clearTimeout(deadline); rec.killed = true; settle({ stopped: 'cancel', spawnError: 'cancelled' }) }, { once: true })
    const writer: CodexStdinWriter = {
      write: (t) => { if (done || stdinEnded) return false; rec.messages.push(t); queueMicrotask(() => onStdin(t)); return true },
      end: () => { stdinEnded = true; queueMicrotask(() => onEnd()) },
    }
    const listeners: Array<(t: string) => void> = []
    const endListeners: Array<() => void> = []
    const onStdin = (t: string) => { for (const l of listeners) l(t) }
    const onEnd = () => { for (const l of endListeners) l() }
    helper({
      write: (s) => { if (!done) opts.onChunk?.(s, 'stdout') },
      messages: rec.messages,
      exit: (code = 0) => { clearTimeout(deadline); settle({ exitCode: code }) },
      ended: () => stdinEnded,
      signal: opts.signal as AbortSignal,
    }, Object.assign(opts, { __onStdin: (l: (t: string) => void) => listeners.push(l), __onEnd: (l: () => void) => endListeners.push(l) }))
    opts.openStdin?.(writer)
  }))
  return { run, runs }
}

/** A well-behaved helper: answers initialize naming CODEX_HOME, then the read,
 *  and exits when stdin closes (unless `stay`). */
function helper(o: { home?: (env: Record<string, string>) => string; stay?: boolean; silent?: boolean; read?: unknown } = {}): Helper {
  return (io, opts) => {
    const on = (opts as unknown as { __onStdin: (l: (t: string) => void) => void }).__onStdin
    const onEnd = (opts as unknown as { __onEnd: (l: () => void) => void }).__onEnd
    on((t) => {
      if (o.silent) return
      const m = JSON.parse(t)
      if (m.method === 'initialize') io.write(JSON.stringify({ id: m.id, result: { codexHome: o.home ? o.home(opts.env) : opts.env.CODEX_HOME, platformFamily: 'windows', platformOs: 'windows', userAgent: 'codex_cli_rs/0.155.1' } }) + '\n')
      if (m.method === 'account/rateLimits/read') io.write(JSON.stringify({ id: m.id, result: o.read ?? { rateLimits: { limitId: 'codex', primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, planType: 'pro' } } }) + '\n')
    })
    onEnd(() => { if (!o.stay) io.exit(0) })
  }
}

function setup(o: { version?: string; compatibility?: string; helper?: Helper; env?: Record<string, string> } = {}) {
  const fr = fakeRun(o.helper ?? helper())
  const deps: CodexAuthDeps = {
    lookupRealm: async (r) => {
      const { realm } = homeOf(r.authRealmId)
      return { ok: true, realm: realm as never, roots: { resourcesDir: RES, externalDefaultHome: EXT } }
    },
    realmIdentity: (home) => ({ canonical: home, dev: '9', ino: String(home.length), isDirectory: true }),
    proven: () => ({ state: 'found', executable: EXE, version: o.version ?? '0.155.1', compatibility: (o.compatibility ?? 'supported') as never, checkedAt: 1, identity: { path: EXE, ...STAT } }) as never,
    executablePorts: { resolve: () => EXE, realpath: (p) => p, stat: () => STAT, platform: 'win32' },
    baseEnv: async () => ({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-ambient-0000000000000000', CODEX_HOME: EXT, ...o.env }),
    run: fr.run as unknown as CodexAuthDeps['run'],
    envFilePresent: () => false,
  }
  return { ops: createCodexAuthOperations(deps), ...fr }
}

afterEach(() => { vi.useRealTimers() })

describe('readUsage: who may be read (ADR-022 bounds 2, 5)', () => {
  it('a managed realm on a supported CLI: one helper, constant argv, CODEX_HOME the realm, no ambient authority', async () => {
    const t = setup()
    const r = await t.ops.readUsage({ authRealmId: MANAGED })
    expect(r.ok).toBe(true)
    expect(t.runs).toHaveLength(1)
    expect(t.runs[0].cmd.args).toEqual(['app-server'])
    expect(t.runs[0].opts.env.CODEX_HOME).toBe(homeOf(MANAGED).home)
    expect(t.runs[0].opts.env.OPENAI_API_KEY).toBeUndefined()
    expect(t.runs[0].opts.timeoutMs).toBe(APP_SERVER_READ_DEADLINE_MS)
    expect(t.runs[0].opts.stdin).toBeUndefined()
    // Exactly the three messages, in order.
    expect(t.runs[0].messages.map((m) => JSON.parse(m).method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
    for (const m of t.runs[0].messages) expect(m).not.toMatch(/thread|turn|conversation|supportsLunaReserve|experimental/)
  })

  it('never for a version outside the supported range, or an unproven CLI', async () => {
    for (const [version, compatibility] of [['0.157.1', 'too-new'], ['0.150.0', 'too-old'], ['0.155.1', 'unknown'], ['0.157.1', 'supported']]) {
      const t = setup({ version, compatibility })
      expect(await t.ops.readUsage({ authRealmId: MANAGED }), `${version} ${compatibility}`).toEqual({ ok: false, kind: 'refused', reason: 'version' })
      expect(t.runs).toHaveLength(0)
    }
  })

  it('never this computer\'s own Codex folder', async () => {
    const t = setup()
    expect(await t.ops.readUsage({ authRealmId: EXTERNAL })).toEqual({ ok: false, kind: 'refused', reason: 'external-realm' })
    expect(t.runs).toHaveLength(0)
  })

  it('one helper at a time', async () => {
    const t = setup({ helper: helper({ stay: true }) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = t.ops.readUsage({ authRealmId: MANAGED })
    expect(await t.ops.readUsage({ authRealmId: MANAGED })).toEqual({ ok: false, kind: 'refused', reason: 'busy' })
    await vi.advanceTimersByTimeAsync(APP_SERVER_EXIT_GRACE_MS + 10)
    expect((await first).ok).toBe(true)
    // Free again once the chain has ended.
    const again = t.ops.readUsage({ authRealmId: MANAGED })
    await vi.advanceTimersByTimeAsync(APP_SERVER_EXIT_GRACE_MS + 10)
    expect((await again).ok).toBe(true)
  })
})

describe('readUsage: the helper is always shut down (ADR-022 bound 4)', () => {
  it('a helper that exits when stdin closes is not killed', async () => {
    const t = setup()
    expect((await t.ops.readUsage({ authRealmId: MANAGED })).ok).toBe(true)
    expect(t.runs[0].killed).toBe(false)
  })

  it('a helper that stays up after the answer is killed after the grace period, and the reading still returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup({ helper: helper({ stay: true }) })
    const p = t.ops.readUsage({ authRealmId: MANAGED })
    await vi.advanceTimersByTimeAsync(APP_SERVER_EXIT_GRACE_MS - 100)
    expect(t.runs[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    const r = await p
    expect(t.runs[0].killed).toBe(true)
    expect(r.ok).toBe(true)
  })

  it('a helper that never answers initialize is killed at its bound: transient timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup({ helper: helper({ silent: true, stay: true }) })
    const p = t.ops.readUsage({ authRealmId: MANAGED })
    await vi.advanceTimersByTimeAsync(APP_SERVER_INITIALIZE_TIMEOUT_MS + 10)
    expect(await p).toEqual({ ok: false, kind: 'transient', reason: 'timeout' })
    expect(t.runs[0].killed).toBe(true)
  })

  it('a helper that names another home fails as unsupported and is shut down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup({ helper: helper({ home: () => EXT, stay: true }) })
    const p = t.ops.readUsage({ authRealmId: MANAGED })
    await vi.advanceTimersByTimeAsync(APP_SERVER_EXIT_GRACE_MS + 10)
    expect(await p).toEqual({ ok: false, kind: 'unsupported', reason: 'codex-home' })
    expect(t.runs[0].killed).toBe(true)
    expect(t.runs[0].messages.map((m) => JSON.parse(m).method)).toEqual(['initialize'])
  })

  it('a caller\'s cancel kills the chain: transient cancelled', async () => {
    const t = setup({ helper: helper({ silent: true, stay: true }) })
    const ac = new AbortController()
    const p = t.ops.readUsage({ authRealmId: MANAGED }, { signal: ac.signal })
    await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0))
    ac.abort()
    expect(await p).toEqual({ ok: false, kind: 'transient', reason: 'cancelled' })
    expect(t.runs[0].killed).toBe(true)
  })

  it('a helper that exits early is transient; a run that could not start is transient', async () => {
    const early = setup({ helper: (io) => { io.exit(1) } })
    expect(await early.ops.readUsage({ authRealmId: MANAGED })).toEqual({ ok: false, kind: 'transient', reason: 'exit' })
  })
})
