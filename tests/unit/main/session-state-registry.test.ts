/**
 * readDetachedRemotesRegistry -- the side-effect-free read of the persisted
 * resume registry that main's #54 destination checks are built on. Both IPC
 * handler suites mock it away and inject their own arrays, so this is the one
 * place its real behaviour is pinned: what it returns, what it drops, and --
 * the reason it exists apart from loadSessionState() -- what it must NOT do to
 * the file or the read-failure latch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir = ''
vi.mock('../../../src/main/config-manager', () => ({
  getConfigDir: () => dir,
  ensureConfigDir: () => {},
  migrateConfigToProviderShape: (x: unknown) => x,
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }))

const { readDetachedRemotesRegistry, sessionStateReadFailed } = await import('../../../src/main/session-state')

const good = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId, configId: 'cfg-1', host: 'pi.local', username: 'mong', remotePath: '~/work',
  mux: 'tmux', label: 'Pi', detachedAt: 1, ...over,
})
const writeState = (body: unknown) => writeFileSync(join(dir, 'session-state.json'), typeof body === 'string' ? body : JSON.stringify(body))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccc-registry-read-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('readDetachedRemotesRegistry', () => {
  it('returns [] when there is no file, and when the state has no registry', () => {
    expect(readDetachedRemotesRegistry()).toEqual([])
    writeState({ sessions: [], activeSessionId: null, savedAt: 1 })
    expect(readDetachedRemotesRegistry()).toEqual([])
    writeState({ sessions: [], detachedRemotes: 'nope' })
    expect(readDetachedRemotesRegistry()).toEqual([])
  })

  it('returns the recorded entries with their #54 destination fields intact', () => {
    const a = good('a', { port: 2222, runtime: { type: 'container', engine: 'podman', container: 'dev' } })
    const legacy = good('b')
    writeState({ sessions: [], detachedRemotes: [a, legacy] })
    expect(readDetachedRemotesRegistry()).toEqual([a, legacy])
  })

  it('drops rows that lack the fields the destination check reads, and keeps the rest', () => {
    writeState({ sessions: [], detachedRemotes: [null, 42, [], { sessionId: 7 }, good('ok'), { ...good('no-host'), host: undefined }, { ...good('no-user'), username: 3 }, { ...good('no-path'), remotePath: null }] })
    expect(readDetachedRemotesRegistry().map((e) => e.sessionId)).toEqual(['ok'])
  })

  it('reads a corrupt file as [] WITHOUT moving it aside or tripping the load latch', () => {
    // loadSessionState() moves an unparseable file aside and remembers a read
    // failure; a consistency check inside an IPC handler must do neither.
    writeState('{ this is not json')
    expect(readDetachedRemotesRegistry()).toEqual([])
    expect(existsSync(join(dir, 'session-state.json'))).toBe(true)
    expect(readdirSync(dir)).toEqual(['session-state.json'])
    expect(sessionStateReadFailed()).toBe(false)
  })
})
