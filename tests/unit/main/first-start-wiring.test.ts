// [host] ADR-025: the shipped wiring of the first-start warm-up. The
// composition root hands the Claude package a warm-up that runs with exactly
// the environment Claude's discovery built; the Codex package's own discovery
// warms before its --version run, and its launch warms with the environment
// that run is built with (a fresh throwaway home, never the user's own); and
// the app's quit stops a warm-up still running. The warm-up itself and the
// Codex CLI run are faked; the only file is an empty codex.exe in a temp
// folder, which nothing runs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const h = vi.hoisted(() => ({
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  runs: [] as Array<{ file: string; args: string[]; env: Record<string, string> }>,
  flushed: 0,
  exe: '',
}))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
  flushFirstStartWarmups: () => { h.flushed++ },
}))
vi.mock('../../../src/main/providers/codex/spawn', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/providers/codex/spawn')>()),
  resolveCodexBinary: () => (h.exe ? { cmd: h.exe, args: [] } : null),
}))
vi.mock('../../../src/main/providers/codex/cli-runner', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/providers/codex/cli-runner')>()),
  runCodexCli: async (cmd: { file: string; args: string[] }, opts: { env: Record<string, string> }) => {
    h.runs.push({ file: cmd.file, args: cmd.args, env: opts.env })
    h.order.push(`run ${cmd.file} ${cmd.args.join(' ')}`)
    return { exitCode: 0, stdout: 'codex-cli 0.155.1\n', stderr: '', timedOut: false, truncated: false }
  },
}))

const { createCodexPackage } = await import('../../../src/main/providers/codex')
const { claudeReviewPorts, flushPendingProviderCliKills } = await import('../../../src/main/providers/compose')
const { harness, EXE: HARNESS_EXE } = await import('../../wp1/accounts-harness')

let dir = ''
beforeEach(() => {
  h.order.length = 0; h.warm.length = 0; h.runs.length = 0; h.flushed = 0
  dir = mkdtempSync(join(tmpdir(), 'ccc-first-start-wiring-'))
  h.exe = join(dir, 'codex.exe')
  writeFileSync(h.exe, '')
})
afterEach(() => {
  delete process.env.OPENAI_API_KEY_FIRST_START_MARK
  rmSync(dir, { recursive: true, force: true })
})

describe('the composition root (ADR-025)', () => {
  it('Claude\'s warm-up port runs with exactly the environment discovery built', async () => {
    const env = { PATH: 'C:\\Windows\\System32', NoDefaultCurrentDirectoryInExePath: '1' }
    await claudeReviewPorts.warmFirstStart!('C:\\Users\\A\\.local\\bin\\claude.exe', env)
    expect(h.warm.map((w) => w.program)).toEqual(['C:\\Users\\A\\.local\\bin\\claude.exe'])
    expect((await (h.warm[0].env as () => Promise<{ env: unknown }> | { env: unknown })()).env).toBe(env)
  })

  it('the quit stops a warm-up still running, with the CLI runs\' own kills', () => {
    flushPendingProviderCliKills()
    expect(h.flushed).toBe(1)
  })
})

describe.runIf(process.platform === 'win32')('the Codex package (ADR-025)', () => {
  it('its own discovery warms the executable it resolved before the --version run, with that run\'s environment', async () => {
    const pkg = createCodexPackage({ hostHome: { env: {}, homeDir: dir } })
    expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
    expect(h.order.map((o) => o.toLowerCase())).toEqual([`warm ${h.exe}`, `run ${h.exe} --version`].map((o) => o.toLowerCase()))
    const warmEnv = (await (h.warm[0].env as () => Promise<{ env: unknown }> | { env: unknown })()).env
    expect(warmEnv).toBe(h.runs[0].env)
  })

  it('its launch warms with --version\'s environment: a fresh throwaway home, removed afterwards, and no API key', async () => {
    process.env.OPENAI_API_KEY_FIRST_START_MARK = 'sk-never-0000'
    const t = await harness()
    await t.codex.launch!.warmFirstStart!(HARNESS_EXE)
    expect(h.warm.map((w) => w.program)).toEqual([HARNESS_EXE])
    const built = await (h.warm[0].env as () => Promise<{ env: Record<string, string>; dispose?: () => void }>)()
    const home = Object.entries(built.env).find(([k]) => k.toUpperCase() === 'CODEX' + '_HOME')?.[1] ?? ''
    expect(basename(home)).toMatch(/^ccc-codex-version-/)
    expect(existsSync(home)).toBe(true)
    expect(JSON.stringify(built.env)).not.toContain('sk-never-0000')
    built.dispose?.()
    expect(existsSync(home)).toBe(false)
  })
})
