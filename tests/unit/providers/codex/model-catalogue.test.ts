// P3.9 (row 39): the model list the installed Codex CLI offers in its own
// picker, read from the CLI (`codex debug models --bundled`) for Sentinel's
// live model check. PURE: every port is faked; no process is started, no
// folder is made and no network is touched. The real-process run through an
// npm-style shim is tests/wp1/fake-cli.test.ts (CI and the VM).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseCodexModelCatalogue, readCodexModelCatalogue, codexCommandLine, codexShellEnv,
  CODEX_CATALOGUE_TIMEOUT_MS, CODEX_CATALOGUE_MAX_CHARS, CODEX_CATALOGUE_MAX_MODELS, CODEX_CATALOGUE_LABEL_MAX,
} from '../../../../src/main/providers/codex'
import type { CodexCatalogueDeps, CodexDiscovery, CodexCommand, CodexRunOptions, CodexRunResult, CodexFileStat } from '../../../../src/main/providers/codex'
import { harness, EXE } from '../../../wp1/accounts-harness'
import shipped from '../../../../resources/codex-model-catalogue.json'

const FIXTURE = join(__dirname, '../../../fixtures/codex/cli/0.153.4/debug-models-bundled.trimmed.json')
const REAL_0153 = readFileSync(FIXTURE, 'utf8')

describe('parseCodexModelCatalogue: what the picker lists, in its order', () => {
  it('reads the 0.153.4 catalogue as the list shipped with this build (same ids, same order)', () => {
    const models = parseCodexModelCatalogue(REAL_0153)!
    expect(models.map((m) => m.id)).toEqual(shipped.models.map((m) => m.id))
    expect(models.map((m) => m.label)).toEqual(shipped.models.map((m) => m.label))
    // Hidden entries (migrated, internal, review-only) are not offered.
    for (const hidden of ['gpt-5.4', 'gpt-5.4-mini', 'codex-auto-review', 'gpt-daybreak-blue-latest']) expect(models.some((m) => m.id === hidden)).toBe(false)
  })

  it("0.155.1's list, as the VM read it (addendum 13: the same five, no gpt-5.2)", () => {
    const doc = JSON.parse(REAL_0153) as { models: Array<{ slug: string }> }
    const v155 = JSON.stringify({ models: doc.models.filter((m) => m.slug !== 'gpt-5.2') })
    expect(parseCodexModelCatalogue(v155)!.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])
  })

  it('orders by priority, then by place; a model with no priority goes last', () => {
    const out = parseCodexModelCatalogue(JSON.stringify({ models: [
      { slug: 'b', visibility: 'list', priority: 5 },
      { slug: 'c', visibility: 'list' },
      { slug: 'a', visibility: 'list', priority: 1 },
      { slug: 'd', visibility: 'list', priority: 5 },
    ] }))!
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'd', 'c'])
    // No display name: the slug is the label.
    expect(out[0]).toEqual({ id: 'a', label: 'a' })
  })

  it('a display name is made prose-safe and cut; an empty one falls back to the slug', () => {
    const esc = String.fromCharCode(27)
    const out = parseCodexModelCatalogue(JSON.stringify({ models: [
      { slug: 'x-1', visibility: 'list', display_name: `GPT${esc}]8;;https://evil.example${esc}\\X` },
      { slug: 'x-2', visibility: 'list', display_name: 'L'.repeat(500) },
      { slug: 'x-3', visibility: 'list', display_name: '   ' },
    ] }))!
    expect(out[0].label).not.toContain(esc)
    expect(out[1].label.length).toBe(CODEX_CATALOGUE_LABEL_MAX)
    expect(out[2].label).toBe('x-3')
  })

  it('anything that is not a catalogue this app reads is no list (fail closed), never an empty one', () => {
    const bad: unknown[] = [
      '', 'not json', '[]', 'null', '42', '"models"',
      JSON.stringify({}), JSON.stringify({ models: [] }), JSON.stringify({ models: {} }),
      // Only hidden models: nothing the picker offers.
      JSON.stringify({ models: [{ slug: 'a', visibility: 'hide' }] }),
      // A broken entry breaks the list.
      JSON.stringify({ models: [{ slug: 'a', visibility: 'list' }, 'x'] }),
      JSON.stringify({ models: [{ slug: 'a', visibility: 'list' }, null] }),
      JSON.stringify({ models: [{ slug: 'a' }] }),
      // A listed model the app could not launch by id.
      JSON.stringify({ models: [{ slug: 'a b', visibility: 'list' }] }),
      JSON.stringify({ models: [{ slug: '-rm', visibility: 'list' }] }),
      JSON.stringify({ models: [{ slug: 'x'.repeat(65), visibility: 'list' }] }),
      JSON.stringify({ models: [{ slug: 7, visibility: 'list' }] }),
      // The same listed model twice.
      JSON.stringify({ models: [{ slug: 'a', visibility: 'list' }, { slug: 'a', visibility: 'list' }] }),
      // Too many entries.
      JSON.stringify({ models: Array.from({ length: CODEX_CATALOGUE_MAX_MODELS + 1 }, (_, i) => ({ slug: `m${i}`, visibility: 'list' })) }),
      // An inherited `models` is not the document's own.
      JSON.stringify({ ['__proto__']: { models: [{ slug: 'a', visibility: 'list' }] } }),
      'x'.repeat(CODEX_CATALOGUE_MAX_CHARS + 1),
    ]
    for (const b of bad) expect(parseCodexModelCatalogue(b as string), String(b).slice(0, 60)).toBeNull()
    expect(parseCodexModelCatalogue(undefined as unknown as string)).toBeNull()
  })

  it("a polluted Object.prototype adds nothing: only the document's own fields are read", () => {
    const proto = Object.prototype as Record<string, unknown>
    try {
      proto.models = [{ slug: 'evil', visibility: 'list' }]
      proto.visibility = 'list'
      expect(parseCodexModelCatalogue('{}')).toBeNull()
      expect(parseCodexModelCatalogue(JSON.stringify({ models: [{ slug: 'a' }] }))).toBeNull()
    } finally {
      delete proto.models
      delete proto.visibility
    }
  })

  it('exactly the maximum number of entries is still read', () => {
    const doc = JSON.stringify({ models: Array.from({ length: CODEX_CATALOGUE_MAX_MODELS }, (_, i) => ({ slug: `m${i}`, visibility: 'list', priority: i })) })
    expect(parseCodexModelCatalogue(doc)).toHaveLength(CODEX_CATALOGUE_MAX_MODELS)
  })
})

// ---------------------------------------------------------------------------

const STAT: CodexFileStat = { size: 10, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2', isFile: true }
const WIN_EXE = 'C:\\Tools\\codex.exe'
const proven = (over: Partial<CodexDiscovery> = {}): CodexDiscovery => ({
  state: 'found', executable: WIN_EXE, version: '0.155.1', compatibility: 'supported', checkedAt: 1,
  identity: { path: WIN_EXE, size: 10, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2' }, ...over,
})

interface Rig {
  deps: CodexCatalogueDeps
  runs: Array<{ cmd: CodexCommand; opts: CodexRunOptions }>
  homes: string[]
  disposed: string[]
  stat: { now: CodexFileStat }
}

function rig(o: { proven?: CodexDiscovery | null; result?: Partial<CodexRunResult>; exe?: string; platform?: NodeJS.Platform; baseEnv?: () => Promise<Record<string, string>>; afterRun?: (r: Rig) => void } = {}): Rig {
  const r: Rig = { deps: null as unknown as CodexCatalogueDeps, runs: [], homes: [], disposed: [], stat: { now: STAT } }
  const exe = o.exe ?? WIN_EXE
  r.deps = {
    proven: () => (o.proven === undefined ? proven({ executable: exe, identity: { ...proven().identity!, path: exe } }) : o.proven),
    executablePorts: { resolve: () => exe, realpath: (p) => p, stat: () => r.stat.now, platform: o.platform ?? 'win32' },
    baseEnv: o.baseEnv ?? (async () => ({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-ambient', CODEX_HOME: 'C:\\Users\\u\\.codex', NODE_OPTIONS: '--require evil' })),
    run: async (cmd, opts) => {
      r.runs.push({ cmd, opts })
      o.afterRun?.(r)
      return { exitCode: 0, stdout: REAL_0153, stderr: '', timedOut: false, truncated: false, ...o.result }
    },
    scratchHome: () => {
      const home = `C:\\tmp\\ccc-codex-models-${r.homes.length + 1}`
      r.homes.push(home)
      return { home, dispose: () => { r.disposed.push(home) } }
    },
  }
  return r
}

describe('readCodexModelCatalogue: the proven CLI, a fixed command, an empty home', () => {
  it('runs exactly `debug models --bundled` on the proven executable, with no shell, and returns its list with the version', async () => {
    const r = rig()
    const out = await readCodexModelCatalogue(r.deps)
    expect(out).toEqual({ ok: true, version: '0.155.1', models: parseCodexModelCatalogue(REAL_0153) })
    expect(r.runs).toHaveLength(1)
    expect(r.runs[0].cmd).toEqual({ file: WIN_EXE, args: ['debug', 'models', '--bundled'], verbatim: false, cwd: 'C:\\Tools' })
    expect(r.runs[0].opts.timeoutMs).toBe(CODEX_CATALOGUE_TIMEOUT_MS)
    expect(r.runs[0].opts.maxOutput).toBe(CODEX_CATALOGUE_MAX_CHARS)
    expect(r.runs[0].opts.stdin).toBeUndefined()
    expect(r.runs[0].opts.openStdin).toBeUndefined()
  })

  it("the home is a fresh empty folder made for the read (never ~/.codex or an account's), removed after it", async () => {
    const r = rig()
    await readCodexModelCatalogue(r.deps)
    const env = r.runs[0].opts.env
    expect(env.CODEX_HOME).toBe(r.homes[0])
    expect(env.CODEX_HOME).not.toBe('C:\\Users\\u\\.codex')
    expect(r.disposed).toEqual(r.homes)
  })

  it('the environment is the allowlist: no ambient credential, no NODE_OPTIONS, and cmd.exe never searches the current folder', async () => {
    const r = rig()
    await readCodexModelCatalogue(r.deps)
    const env = r.runs[0].opts.env
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('an npm shim runs through the absolute cmd.exe exactly as every other Codex operation does', async () => {
    const shim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd'
    const r = rig({ exe: shim })
    await readCodexModelCatalogue(r.deps)
    const expected = codexCommandLine(shim, 'models', 'win32', codexShellEnv({ SystemRoot: 'C:\\Windows' }, 'win32'))
    expect(r.runs[0].cmd).toEqual(expected)
    expect(r.runs[0].cmd).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe', verbatim: true, cwd: 'C:\\Users\\u\\AppData\\Roaming\\npm' })
    expect(r.runs[0].cmd.args.at(-1)).toBe(`""${shim}" debug models --bundled"`)
  })

  it('nothing runs, and no folder is made, without a proven CLI of a version this app can use', async () => {
    for (const p of [null, proven({ state: 'missing' }), proven({ identity: undefined }), proven({ version: undefined }), proven({ compatibility: 'too-old' }), proven({ compatibility: 'unknown' })]) {
      const r = rig({ proven: p })
      const out = await readCodexModelCatalogue(r.deps)
      expect(out.ok).toBe(false)
      expect(r.runs).toHaveLength(0)
      expect(r.homes).toHaveLength(0)
    }
    expect(await readCodexModelCatalogue(rig({ proven: null }).deps)).toMatchObject({ ok: false, code: 'not-proven' })
    expect(await readCodexModelCatalogue(rig({ proven: proven({ compatibility: 'too-old' }) }).deps)).toMatchObject({ ok: false, code: 'unsupported-version' })
    // A newer-than-tested CLI is used (warned and allowed, as every Codex operation).
    expect((await readCodexModelCatalogue(rig({ proven: proven({ compatibility: 'too-new' }) }).deps)).ok).toBe(true)
  })

  it('an executable replaced since setup proved it runs nothing', async () => {
    const r = rig()
    r.stat.now = { ...STAT, ctimeMs: 99 }
    expect(await readCodexModelCatalogue(r.deps)).toMatchObject({ ok: false, code: 'executable-changed' })
    expect(r.runs).toHaveLength(0)
    expect(r.homes).toHaveLength(0)
  })

  it('a file replaced while it ran gives no list: the list would not be the proven version\'s', async () => {
    const r = rig({ afterRun: (x) => { x.stat.now = { ...STAT, size: 11 } } })
    expect(await readCodexModelCatalogue(r.deps)).toMatchObject({ ok: false, code: 'executable-changed' })
    expect(r.disposed).toEqual(r.homes)
  })

  it('a failed, timed-out, stopped, truncated or unreadable run is no list, and the home still goes', async () => {
    const cases: Array<[Partial<CodexRunResult>, string]> = [
      [{ exitCode: 2, stdout: '', stderr: "error: unexpected argument '--bundled' found" }, 'failed'],
      [{ exitCode: null, timedOut: true, stopped: 'deadline' }, 'failed'],
      [{ exitCode: null, stopped: 'cancel', spawnError: 'cancelled' }, 'failed'],
      [{ exitCode: null, spawnError: 'ENOENT' }, 'not-started'],
      [{ truncated: true }, 'unreadable'],
      [{ stdout: 'Error: something\n' }, 'unreadable'],
    ]
    for (const [result, code] of cases) {
      const r = rig({ result })
      expect(await readCodexModelCatalogue(r.deps), JSON.stringify(result)).toMatchObject({ ok: false, code })
      expect(r.disposed).toEqual(r.homes)
    }
  })

  it('a stopped run whose kill is still under way keeps its home until that kill has finished', async () => {
    let finishKill!: () => void
    const killSettled = new Promise<void>((res) => { finishKill = res })
    const r = rig({ result: { exitCode: null, timedOut: true, stopped: 'deadline', killSettled } })
    expect((await readCodexModelCatalogue(r.deps)).ok).toBe(false)
    expect(r.disposed).toEqual([])
    finishKill()
    await killSettled
    await Promise.resolve()
    expect(r.disposed).toEqual(r.homes)
  })

  it('a cancelled read starts nothing; ports that throw are a failure, never a throw', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = rig()
    expect(await readCodexModelCatalogue(r.deps, { signal: ac.signal })).toMatchObject({ ok: false })
    expect(r.runs).toHaveLength(0)
    expect(await readCodexModelCatalogue(rig({ baseEnv: async () => { throw new Error('no shell') } }).deps)).toMatchObject({ ok: false, code: 'not-started' })
    const broken = rig()
    broken.deps.scratchHome = () => { throw new Error('EACCES') }
    expect(await readCodexModelCatalogue(broken.deps)).toMatchObject({ ok: false, code: 'not-started' })
    broken.deps.run = async () => { throw new Error('spawn threw') }
    broken.deps.scratchHome = () => ({ home: 'C:\\tmp\\h', dispose: () => { throw new Error('busy') } })
    expect(await readCodexModelCatalogue(broken.deps)).toMatchObject({ ok: false, code: 'not-started' })
  })

  it('the signal reaches the run', async () => {
    const ac = new AbortController()
    const r = rig()
    await readCodexModelCatalogue(r.deps, { signal: ac.signal })
    expect(r.runs[0].opts.signal).toBe(ac.signal)
  })
})

// ---------------------------------------------------------------------------

describe("the accounts service's model catalogue read: the launch rule, then the CLI discovery proved", () => {
  const catalogue = (runs: string[]) => () => ({
    executablePorts: { resolve: () => EXE, realpath: (p: string) => p, stat: () => ({ size: 1, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '2', isFile: true }), platform: 'win32' as const },
    baseEnv: async () => ({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows' }),
    run: async (cmd: CodexCommand, opts: CodexRunOptions): Promise<CodexRunResult> => {
      runs.push(`${cmd.args.join(' ')} @ ${opts.env.CODEX_HOME}`)
      return { exitCode: 0, stdout: REAL_0153, stderr: '', timedOut: false, truncated: false }
    },
    scratchHome: () => ({ home: 'C:\\tmp\\ccc-codex-models-x', dispose: () => {} }),
  })

  it('runs only while Codex is on: off, not set up or unreadable refuse, and nothing runs', async () => {
    for (const [pref, code] of [['off', 'provider-disabled'], ['undecided', 'provider-not-set-up']] as const) {
      const runs: string[] = []
      const h = await harness({ preference: { codex: pref }, catalogueDeps: catalogue(runs) })
      expect(await h.service.readModelCatalogue('codex')).toMatchObject({ ok: false, code })
      expect(runs).toEqual([])
      expect(h.discoveries()).toBe(0)
    }
    const runs: string[] = []
    const h = await harness({ preference: { codex: () => { throw new Error('unreadable') } }, catalogueDeps: catalogue(runs) })
    expect(await h.service.readModelCatalogue('codex')).toMatchObject({ ok: false, code: 'provider-state-unknown' })
    expect(runs).toEqual([])
  })

  it('proves the CLI first when nothing has (one discovery), then runs the read in the empty home, never a realm', async () => {
    const runs: string[] = []
    const h = await harness({ catalogueDeps: catalogue(runs) })
    const r = await h.service.readModelCatalogue('codex')
    expect(r).toMatchObject({ ok: true, catalogue: { ok: true, version: '0.155.1' } })
    expect(r.ok && r.catalogue.ok && r.catalogue.models.map((m) => m.id)).toEqual(shipped.models.map((m) => m.id))
    expect(h.discoveries()).toBe(1)
    expect(runs).toEqual(['debug models --bundled @ C:\\tmp\\ccc-codex-models-x'])
    // A second read reuses the proof.
    await h.service.readModelCatalogue('codex')
    expect(h.discoveries()).toBe(1)
  })

  it('switched off while its proof was awaited: nothing runs', async () => {
    const runs: string[] = []
    let pref: 'on' | 'off' = 'on'
    const h = await harness({ preference: { codex: () => pref }, catalogueDeps: catalogue(runs), beforeDiscovery: () => { pref = 'off' } })
    expect(await h.service.readModelCatalogue('codex')).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(runs).toEqual([])
  })

  it('a provider without the read answers unsupported; a read that throws is a failed read, not a throw', async () => {
    const h = await harness()
    expect(await h.service.readModelCatalogue('claude')).toMatchObject({ ok: false, code: 'unsupported' })
    const setup = h.codex.setup as { modelCatalogue: () => Promise<unknown> }
    setup.modelCatalogue = async () => { throw new Error('boom') }
    expect(await h.service.readModelCatalogue('codex')).toMatchObject({ ok: true, catalogue: { ok: false, code: 'failed' } })
  })

  it('the Codex package states the range its managed flows support', async () => {
    const h = await harness()
    expect(h.codex.setup?.supportedVersions).toEqual({ minimum: '0.153.4', maximumTested: '0.156.1' })
  })
})
