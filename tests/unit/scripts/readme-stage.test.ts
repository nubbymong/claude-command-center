/**
 * [host] P4.11 review C-1, C-2, C-5, C-6: the README staging scripts work
 * only in one throwaway staging root of their own, and the seed's project
 * folders under C:\dev are made, marked and removed by the tool alone.
 *
 * Behaviour, not source text: seed.js is spawned (node, this process's own
 * binary) against DECOYS only. Every folder it is given, including the
 * "real" home it must refuse (USERPROFILE/HOME/LOCALAPPDATA/APPDATA of the
 * child), the project folder (CCC_STAGE_DEV) and the child's working folder,
 * is inside one mkdtemp folder of this file, so even a broken guard could only
 * write there; the child's PATH holds only node's folder and System32, so the
 * seed's later steps (python) cannot run. The refusals happen before the seed
 * writes anything: each case snapshots the decoy tree and compares it after.
 * launch.js and shoot.js are never run (they would start or drive an app):
 * launch.js's plan and the shared guard are checked as functions.
 *
 * Writes only inside folders this file makes (its own prefix, directly in the
 * temp folder), removed by that prefix and parent alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, statSync } from 'fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { captureLaunchEnv, captureHomeDir, captureFakeBinDir } from '../../../scripts/capture-env'

const STAGE_DIR = resolve(__dirname, '..', '..', '..', 'scripts', 'readme-shots', 'stage')
const SEED = join(STAGE_DIR, 'seed.js')
const req = createRequire(join(STAGE_DIR, 'seed.js'))
const S = req('./stage-root.js') as {
  MARKER: string; DEV_MARKER: string; DEV_TOPS: string[]; StageRefusal: new (m: string) => Error
  resolveStage: (env: Record<string, string | undefined>, platform?: string, deps?: Record<string, unknown>) => Record<string, string>
  ensureMarker: (root: string, o: { create: boolean }) => string
  validDevEntry: (e: unknown, dev: string) => boolean
  readLaunchRecord: (stage: Record<string, string>) => unknown
  shootPaths: (stage: Record<string, string>, env: Record<string, string | undefined>) => { OUT: string; LOG: string }
  processIdentity: (pid: number, platform: string, exec: FakeExec) => { command: string; startedAt: number } | null
  isRecordedProcess: (rec: Record<string, unknown>, ident: { command: string; startedAt: number } | null, platform: string) => boolean
  checkLaunchedApp: (rec: Record<string, unknown>, deps: { platform: string; exec: FakeExec }) => void
  checkDevTargets: (dev: string, deps?: Record<string, unknown>) => void
  noLinkBelow: (root: string, p: string, platform: string, deps: Record<string, unknown>) => boolean
}
type FakeExec = (cmd: string, args: string[]) => string
const L = req('./launch.js') as {
  planLaunch: (env: Record<string, string | undefined>, cle: typeof captureLaunchEnv, o?: Record<string, unknown>) => { exe: string; args: string[]; env: Record<string, string>; cwd: string; stage: Record<string, string> }
}

const PREFIX = 'ccc-test-readme-stage-'
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) if (dirname(d) === tmpdir() && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true })
})
// The temp folder's real path (macOS: /var is a link to /private/var; a
// Windows runner's temp folder is an 8.3 spelling): the guard works on real
// paths, so the paths these tests compare are real too.
const base = (): string => {
  const d = mkdtempSync(join(tmpdir(), PREFIX))
  made.push(d)
  return realpathSync.native(d)
}
const write = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s) }

/** Every entry under `dir`: relative path, size, mtime. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const st = statSync(p)
      out.push(`${p.slice(dir.length)}|${st.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.sort()
}

/** A decoy "real" machine inside `b`: a home with .claude/.codex content, its
 *  app data folders (the installed app's data folder and npm's shims among
 *  them), and a working folder for the child. */
function decoyMachine(b: string) {
  const home = join(b, 'realhome')
  write(join(home, '.claude', 'projects', 'p', 'conv.jsonl'), '{}\n')
  write(join(home, '.codex', 'config.toml'), 'model = "x"\n')
  write(join(home, 'AppData', 'Local', 'AI Code Conductor', 'resources', 'CONFIG', 'settings.json'), '{}\n')
  write(join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'), '@echo real\n')
  const cwd = join(b, 'work', 'inner')
  mkdirSync(cwd, { recursive: true })
  return { home, cwd, appData: join(home, 'AppData', 'Local', 'AI Code Conductor') }
}

/** The child's environment: only decoys, and a PATH with node and System32 only. */
function childEnv(home: string, extra: Record<string, string>): Record<string, string> {
  const sys = process.env.SystemRoot || 'C:\\Windows'
  return {
    PATH: [dirname(process.execPath), join(sys, 'System32')].join(delimiter),
    SystemRoot: sys,
    USERPROFILE: home, HOME: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
    ...extra,
  }
}
function runSeed(cwd: string, env: Record<string, string>, args: string[] = ['--app-version', '2.1.1-beta.2']) {
  return spawnSync(process.execPath, [SEED, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
}

describe('seed.js refuses anything but a staging root of its own, before writing (C-1, C-3)', () => {
  // [case, setup, the reason it must be refused for]: each case's project folder
  // is inside its root, so the refusal is the case's own rule and no other.
  const refusals: Array<[string, (b: string, m: ReturnType<typeof decoyMachine>) => Record<string, string>, RegExp]> = [
    ['no CCC_STAGE_ROOT', () => ({}), /CCC_STAGE_ROOT must name/],
    ['--over-real-state with no root (the mode is gone)', () => ({ OVER: '1' }), /CCC_STAGE_ROOT must name/],
    ['the root is the real home', (_b, m) => ({ CCC_STAGE_ROOT: m.home }), /is or holds the home folder/],
    ['the root holds the real home', (b) => ({ CCC_STAGE_ROOT: b }), /is or holds the home folder/],
    ['the root is inside the real ~/.claude', (_b, m) => ({ CCC_STAGE_ROOT: join(m.home, '.claude', 'stage') }), /overlaps .*\.claude/],
    ["the root is inside the installed app's data folder", (_b, m) => ({ CCC_STAGE_ROOT: join(m.appData, 'stage') }), /overlaps .*AI Code Conductor/],
    ['CCC_STAGE_HOME points at the real home', (b, m) => ({ CCC_STAGE_ROOT: join(b, 'stage'), CCC_STAGE_HOME: m.home }), /CCC_STAGE_HOME .* is not inside the staging root/],
    ["CCC_STAGE_DATA points at the installed app's data folder", (b, m) => ({ CCC_STAGE_ROOT: join(b, 'stage'), CCC_STAGE_DATA: m.appData }), /CCC_STAGE_DATA .* is not inside the staging root/],
    ['CCC_STAGE_NPM_BIN points at the real npm folder', (b, m) => ({ CCC_STAGE_ROOT: join(b, 'stage'), CCC_STAGE_NPM_BIN: join(m.home, 'AppData', 'Roaming', 'npm') }), /CCC_STAGE_NPM_BIN .* is not inside the staging root/],
    ['CCC_STAGE_DEV outside the root', (b) => ({ CCC_STAGE_ROOT: join(b, 'stage'), CCC_STAGE_DEV: join(b, 'dev') }), /CCC_STAGE_DEV .* is not inside the staging root/],
    ['the root exists with other content and no marker', (b) => { write(join(b, 'notstage', 'keep.txt'), 'x'); return { CCC_STAGE_ROOT: join(b, 'notstage') } }, /not empty and has no staging marker/],
    ['a relative root', () => ({ CCC_STAGE_ROOT: 'stage' }), /CCC_STAGE_ROOT must name/],
  ]
  for (const [name, setup, why] of refusals) {
    it(`[host] ${name}: exit 2, nothing touched`, () => {
      const b = base()
      const m = decoyMachine(b)
      const extra = setup(b, m)
      const args = extra.OVER ? ['--over-real-state'] : undefined
      delete extra.OVER
      // The project folder inside the case's root (or the decoy tree), so a
      // broken guard could only ever write in the decoy tree.
      const root = extra.CCC_STAGE_ROOT && isAbsolute(extra.CCC_STAGE_ROOT) ? extra.CCC_STAGE_ROOT : join(b, 'stage')
      const env = childEnv(m.home, { CCC_STAGE_DEV: join(root, 'dev'), ...extra })
      const before = snapshot(b)
      const r = runSeed(m.cwd, env, args)
      expect(r.status, r.stderr + r.stdout).toBe(2)
      expect(r.stderr).toMatch(/^refusing: /m)
      expect(r.stderr).toMatch(why)
      expect(snapshot(b)).toEqual(before)
    })
  }

  it('[host] a project folder under the projects root that the tool did not make: exit 2, its file untouched (C-2)', () => {
    const b = base()
    const m = decoyMachine(b)
    const root = join(b, 'stage')
    write(join(root, S.MARKER), 'ccc-readme-stage v1: earlier run\n')
    const pkg = join(root, 'dev', 'web', 'storefront', 'package.json')
    write(pkg, '{ "name": "the user\'s own" }\n')
    const before = snapshot(b)
    const r = runSeed(m.cwd, childEnv(m.home, { CCC_STAGE_ROOT: root, CCC_STAGE_DEV: join(root, 'dev') }))
    expect(r.status, r.stderr + r.stdout).toBe(2)
    expect(r.stderr).toMatch(/was not made by this tool/)
    expect(readFileSync(pkg, 'utf8')).toBe('{ "name": "the user\'s own" }\n')
    expect(snapshot(b)).toEqual(before)
  })

  it('[host] --restore without the marker: exit 2, nothing touched', () => {
    const b = base()
    const m = decoyMachine(b)
    const root = join(b, 'stage')
    write(join(root, 'runner', 'backup', '.done'), 'x')
    const before = snapshot(b)
    const r = runSeed(m.cwd, childEnv(m.home, { CCC_STAGE_ROOT: root, CCC_STAGE_DEV: join(root, 'dev') }), ['--restore'])
    expect(r.status, r.stderr + r.stdout).toBe(2)
    expect(snapshot(b)).toEqual(before)
  })
})

describe('--restore removes only the marked project folders it recorded (C-2, C-6)', () => {
  it('[host] keeps every recorded entry that is not exactly one of its marked folders under the projects root', () => {
    const b = base()
    const m = decoyMachine(b)
    const root = join(b, 'stage')
    const dev = join(root, 'dev')
    write(join(root, S.MARKER), 'ccc-readme-stage v1: test\n')
    write(join(root, 'runner', 'backup', '.done'), 'x')
    const marked = (p: string) => { write(join(p, S.DEV_MARKER), 'm'); write(join(p, 'f.txt'), 'f'); return p }
    const web = marked(join(dev, 'web'))
    const platform = marked(join(dev, 'platform'))            // recorded only as a relative name
    const dataUnmarked = join(dev, 'data'); write(join(dataUnmarked, 'mine.txt'), 'user')
    const notTop = marked(join(dev, 'other'))                 // marked but not one of its names
    const outside = marked(join(b, 'elsewhere', 'web'))       // marked, outside the projects root
    const relDecoy = marked(join(m.cwd, 'platform'))          // where a relative entry would resolve
    const parentDecoy = join(m.cwd, '..'); write(join(parentDecoy, 'keep.txt'), 'k')
    write(join(root, 'runner', 'dev-created.json'), JSON.stringify([web, 'platform', '', '..', dataUnmarked, notTop, outside, dev, `${dev}${'\\'}..`, 42, null]))
    const r = runSeed(m.cwd, childEnv(m.home, { CCC_STAGE_ROOT: root, CCC_STAGE_DEV: dev }), ['--restore'])
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(existsSync(web)).toBe(false)
    for (const kept of [platform, dataUnmarked, notTop, outside, relDecoy, dev, join(parentDecoy, 'keep.txt'), m.cwd]) expect(existsSync(kept), kept).toBe(true)
    expect(r.stdout).toMatch(/removed project folder/)
    expect((r.stdout.match(/not removing recorded entry/g) || []).length).toBe(10)
  })
})

describe('the staging guard (stage-root.js)', () => {
  const noReg = { registryFolders: () => [] as string[] }

  it('[host] the default layout is the training tool\'s launch layout, all inside the root', () => {
    const b = base()
    const root = join(b, 'stage')
    const st = S.resolveStage({ CCC_STAGE_ROOT: root, CCC_STAGE_DEV: join(root, 'dev'), USERPROFILE: join(b, 'h') }, process.platform, noReg)
    expect(st.DATA).toBe(join(root, 'data'))
    expect(st.HOME).toBe(captureHomeDir(st.DATA))
    expect(st.NPM_BIN).toBe(captureFakeBinDir(st.DATA))
    expect(st.RES).toBe(join(st.DATA, 'resources'))
    expect(st.RUNNER).toBe(join(root, 'runner'))
  })

  it('[host] refuses a root inside the folder the installer recorded as the app\'s data folder', () => {
    const b = base()
    const recorded = join(b, 'InstalledData')
    expect(() => S.resolveStage({ CCC_STAGE_ROOT: join(recorded, 'stage'), CCC_STAGE_DEV: join(recorded, 'stage', 'dev') }, process.platform, { registryFolders: () => [recorded] })).toThrow(/overlaps/)
    expect(() => S.resolveStage({ CCC_STAGE_ROOT: b, CCC_STAGE_DEV: join(b, 'dev') }, process.platform, { registryFolders: () => [recorded] })).toThrow(/overlaps/)
  })

  it('[host] the marker is made only in an absent or empty folder, and required after', () => {
    const b = base()
    const fresh = join(b, 'fresh')
    expect(S.ensureMarker(fresh, { create: true })).toBe('made')
    expect(S.ensureMarker(fresh, { create: false })).toBe('present')
    const full = join(b, 'full'); write(join(full, 'x.txt'), 'x')
    expect(() => S.ensureMarker(full, { create: true })).toThrow(/not empty/)
    const forged = join(b, 'forged'); write(join(forged, S.MARKER), 'something else')
    expect(() => S.ensureMarker(forged, { create: true })).toThrow(/not this tool's marker/)
    expect(() => S.ensureMarker(join(b, 'absent'), { create: false })).toThrow(/does not exist/)
  })

  it('[host] validDevEntry: only an absolute, marked DEV\\<name> folder', () => {
    const b = base()
    const dev = join(b, 'dev')
    write(join(dev, 'web', S.DEV_MARKER), 'm')
    write(join(dev, 'notes', 'x'), 'unmarked')
    expect(S.validDevEntry(join(dev, 'web'), dev)).toBe(true)
    for (const bad of ['', 'web', '..', '.', dev, join(dev, 'notes'), join(dev, 'web', '..', 'web', 'sub'), join(dev, 'nope'), process.platform === 'win32' ? 'C:\\' : '/', 7, null, undefined]) {
      expect(S.validDevEntry(bad, dev), String(bad)).toBe(false)
    }
  })

  it('[host] shoot.js attaches only by launch.js\'s record for this root\'s data folder', () => {
    const b = base()
    const root = join(b, 'stage')
    const st = S.resolveStage({ CCC_STAGE_ROOT: root, CCC_STAGE_DEV: join(root, 'dev') }, process.platform, noReg)
    expect(() => S.readLaunchRecord(st)).toThrow(/no launch record/)
    write(join(st.RUNNER, 'launch.json'), JSON.stringify({ pid: 1, port: 9335, dataDir: join(b, 'other') }))
    expect(() => S.readLaunchRecord(st)).toThrow(/another data folder/)
    write(join(st.RUNNER, 'launch.json'), JSON.stringify({ pid: 1, port: 9335, dataDir: st.DATA }))
    expect(S.readLaunchRecord(st)).toMatchObject({ port: 9335 })
    const shoot = readFileSync(resolve(STAGE_DIR, '..', 'shoot.js'), 'utf8')
    expect(shoot).not.toMatch(/\bspawn\b/)
    expect(shoot).toMatch(/S\.readLaunchRecord\(STAGE\)/)
  })
})

describe('launch.js starts the installed app only isolated (C-4)', () => {
  it('[host] refuses a root without the marker, and its plan keeps every folder inside the root', () => {
    const b = base()
    const root = join(b, 'stage')
    const home = join(b, 'realhome')
    const npm = join(home, 'npm'); write(join(npm, 'claude.cmd'), 'x')
    const env = { CCC_STAGE_ROOT: root, CCC_STAGE_DEV: join(root, 'dev'), USERPROFILE: home, HOME: home, PATH: [npm, dirname(process.execPath)].join(delimiter), CODEX_HOME: join(home, '.codex'), CCC_STAGE_APP_EXE: join(b, 'app.exe') }
    expect(() => L.planLaunch(env, captureLaunchEnv)).toThrow(/does not exist/)
    S.ensureMarker(root, { create: true })
    const plan = L.planLaunch(env, captureLaunchEnv)
    const inRoot = (p: string) => resolve(p).toLowerCase().startsWith(resolve(root).toLowerCase() + (process.platform === 'win32' ? '\\' : '/'))
    for (const k of ['USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'CCC_E2E_DATA_DIR']) expect(inRoot(plan.env[k]), k).toBe(true)
    expect(plan.env.PATH.split(delimiter)[0]).toBe(captureFakeBinDir(plan.stage.DATA))
    expect(plan.env.PATH.split(delimiter)).not.toContain(npm)
    expect(Object.keys(plan.env).some((k) => k.toUpperCase() === 'CODEX_HOME')).toBe(false)
    expect(plan.env.HTTPS_PROXY).toBe('http://127.0.0.1:9')
    expect(plan.args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length)).toBe(join(plan.stage.DATA, 'electron-userdata'))
    expect(plan.args).toContain('--remote-debugging-port=9335')
    expect(inRoot(plan.cwd)).toBe(true)
    expect(plan.exe).toBe(join(b, 'app.exe'))
  })

  it('[host] the seed and the launcher use the checkout\'s pinned esbuild, never a run-time download (C-7)', () => {
    for (const f of ['seed.js', 'launch.js']) {
      const src = readFileSync(join(STAGE_DIR, f), 'utf8')
      expect(src, f).not.toMatch(/\bnpx\b/)
      expect(src, f).not.toMatch(/--yes/)
      expect(src, f).toMatch(/require\(path\.join\(REPO, 'node_modules', 'esbuild'\)\)/)
    }
    expect(readFileSync(SEED, 'utf8')).not.toMatch(/over-real-state/)
  })
})

describe('the staging root is compared by its real path, and UNC and device roots are refused (V-1)', () => {
  const HOME = 'C:\\Users\\examplename'
  // Stand-ins for spellings the file system resolves to another folder: a subst
  // drive, an 8.3 short name and a drive mapped to a share, as realpath sees them.
  const realMap: Array<[string, string]> = [
    ['S:\\', `${HOME}\\`],
    ['C:\\Users\\EXAMPL~1', HOME],
    [`${HOME}\\AppData\\Roaming\\ANTHRO~1`, `${HOME}\\AppData\\Roaming\\Anthropic`],
    ['K:\\', '\\\\localhost\\C$\\'],
  ]
  const deps = (extra: Record<string, unknown> = {}) => ({
    registryFolders: () => [] as string[],
    userHome: () => HOME,
    osHome: () => HOME,
    isLink: () => false,
    exists: () => true,
    realpath: (p: string) => {
      for (const [from, to] of realMap) if (p.toLowerCase().startsWith(from.toLowerCase())) return to + p.slice(from.length)
      return p
    },
    ...extra,
  })
  const env = (root: string, more: Record<string, string> = {}) => ({ CCC_STAGE_ROOT: root, CCC_STAGE_DEV: `${root}\\dev`, USERPROFILE: HOME, HOME, ...more })
  const cases: Array<[string, string, RegExp]> = [
    ['a subst drive onto ~/.codex', 'S:\\.codex\\stage', /overlaps .*\.codex/],
    ['an 8.3 spelling of ~/.claude', 'C:\\Users\\EXAMPL~1\\.claude\\stage', /overlaps .*\.claude/],
    ["an 8.3 spelling of Anthropic's app data folder", `${HOME}\\AppData\\Roaming\\ANTHRO~1\\stage`, /overlaps .*Anthropic/],
    ['a drive mapped to a share', 'K:\\stage', /UNC or device path/],
    ['a device path (\\\\?\\)', `\\\\?\\${HOME}\\.codex\\stage`, /UNC or device path/],
    ['a device path (\\\\.\\)', '\\\\.\\C:\\stage', /UNC or device path/],
    ['a UNC root', '\\\\localhost\\C$\\Users\\examplename\\.codex\\stage', /UNC or device path/],
  ]
  for (const [name, root, why] of cases) {
    it.runIf(process.platform === 'win32')(`[host] refuses ${name}`, () => {
      expect(() => S.resolveStage(env(root), 'win32', deps())).toThrow(why)
    })
  }

  it.runIf(process.platform === 'win32')('[host] a protected folder named by another spelling is compared by its real path too', () => {
    // The home given only through USERPROFILE, in its short spelling; the root under the long one.
    const d = deps({ userHome: () => 'D:\\elsewhere', osHome: () => 'D:\\elsewhere' })
    expect(() => S.resolveStage(env(`${HOME}\\.codex\\stage`, { USERPROFILE: 'C:\\Users\\EXAMPL~1', HOME: 'C:\\Users\\EXAMPL~1' }), 'win32', d)).toThrow(/overlaps .*\.codex/)
  })

  it.runIf(process.platform === 'win32')('[host] a plain staging root elsewhere still passes', () => {
    expect(S.resolveStage(env('D:\\stage'), 'win32', deps()).ROOT).toBe('D:\\stage')
  })

  it.runIf(process.platform === 'win32')('[host] a real 8.3 spelling of a decoy home on disk is refused (when the volume makes short names)', (ctx) => {
    const b = base()
    const home = join(b, 'decoyhomelongname')
    mkdirSync(join(home, '.codex'), { recursive: true })
    const short = join(b, 'DECOYH~1')
    let real = ''
    try { real = realpathSync.native(short) } catch { /* no short names on this volume */ }
    if (!real || real.toLowerCase() !== home.toLowerCase()) { ctx.skip(); return }
    expect(() => S.resolveStage({ CCC_STAGE_ROOT: join(short, '.codex', 'stage'), CCC_STAGE_DEV: join(short, '.codex', 'stage', 'dev'), USERPROFILE: home, HOME: home }, 'win32', { registryFolders: () => [] })).toThrow(/overlaps .*\.codex/)
  })
})

describe('shoot.js keeps its output in the root and attaches only to the recorded app (V NITs)', () => {
  it('[host] CCC_SHOOT_OUT and CCC_SHOOT_LOG must be inside the root', () => {
    const b = base()
    const root = join(b, 'stage')
    const st = S.resolveStage({ CCC_STAGE_ROOT: root, CCC_STAGE_DEV: join(root, 'dev') }, process.platform, { registryFolders: () => [] })
    expect(S.shootPaths(st, {})).toEqual({ OUT: join(root, 'out'), LOG: join(root, 'shoot.log') })
    expect(S.shootPaths(st, { CCC_SHOOT_OUT: join(root, 'pngs') }).OUT).toBe(join(root, 'pngs'))
    expect(() => S.shootPaths(st, { CCC_SHOOT_OUT: join(b, 'elsewhere') })).toThrow(/CCC_SHOOT_OUT .* not inside the staging root/)
    expect(() => S.shootPaths(st, { CCC_SHOOT_LOG: join(b, 'shoot.log') })).toThrow(/CCC_SHOOT_LOG .* not inside the staging root/)
    expect(() => S.shootPaths(st, { CCC_SHOOT_OUT: 'out' })).toThrow(/absolute/)
  })

  const rec = { pid: 4242, port: 9335, exe: 'C:\\Apps\\AI Code Conductor\\AI Code Conductor.exe', startedAt: '2026-10-03T18:00:00.000Z', dataDir: 'C:\\x' }
  const winExec = (row: string, owner: string): FakeExec => (cmd, args) => {
    const script = args.join(' ')
    if (/Get-NetTCPConnection/.test(script)) return owner
    if (/Win32_Process/.test(script)) return row
    throw new Error('unexpected ' + cmd)
  }
  it('[host] the recorded process on Windows: same exe, started at or after the record', () => {
    const ident = S.processIdentity(4242, 'win32', winExec(`${rec.exe}|2026-10-03T18:00:00.500Z`, '4242'))
    expect(ident).toEqual({ command: rec.exe, startedAt: Date.parse('2026-10-03T18:00:00.500Z') })
    expect(S.isRecordedProcess(rec, ident, 'win32')).toBe(true)
    expect(S.isRecordedProcess(rec, { command: 'C:\\Windows\\notepad.exe', startedAt: ident!.startedAt }, 'win32')).toBe(false)
    expect(S.isRecordedProcess(rec, { command: rec.exe, startedAt: Date.parse('2026-10-03T17:00:00Z') }, 'win32')).toBe(false)
    expect(S.isRecordedProcess(rec, null, 'win32')).toBe(false)
    expect(S.processIdentity(4242, 'win32', winExec('', '4242'))).toBeNull()
  })
  it('[host] the recorded process on macOS and Linux: ps start time and command', () => {
    // ps -o lstart prints the local start time as "Sat Oct  3 11:00:03 2026".
    const d = new Date(Date.parse(rec.startedAt) + 3000)
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
    const two = (n: number) => String(n).padStart(2, '0')
    const lstart = `${day} ${mon} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`
    const exe = '/Applications/AI Code Conductor.app/Contents/MacOS/AI Code Conductor'
    const r2 = { ...rec, exe }
    const exec: FakeExec = (cmd) => { if (cmd === 'ps') return `${lstart} ${exe} --remote-debugging-port=9335\n`; throw new Error(cmd) }
    const ident = S.processIdentity(4242, 'darwin', exec)
    expect(ident && ident.command).toContain(exe)
    expect(S.isRecordedProcess(r2, ident, 'darwin')).toBe(true)
    expect(S.isRecordedProcess(r2, ident ? { ...ident, command: '/bin/sleep 100' } : null, 'darwin')).toBe(false)
    expect(S.isRecordedProcess(r2, ident ? { ...ident, startedAt: Date.parse('2026-10-03T17:00:00Z') } : null, 'darwin')).toBe(false)
  })
  it('[host] attaching refuses when the port is not held by the recorded app', () => {
    const live = `${rec.exe}|2026-10-03T18:00:01.000Z`
    expect(() => S.checkLaunchedApp(rec, { platform: 'win32', exec: winExec(live, '4242') })).not.toThrow()
    expect(() => S.checkLaunchedApp(rec, { platform: 'win32', exec: winExec(live, '9999') })).toThrow(/not held by the recorded app/)
    expect(() => S.checkLaunchedApp(rec, { platform: 'win32', exec: winExec(live, '') })).toThrow(/not held by the recorded app/)
    expect(() => S.checkLaunchedApp(rec, { platform: 'win32', exec: winExec('', '4242') })).toThrow(/not running any more/)
  })
  it('[host] shoot.js and launch.js use those checks', () => {
    const shoot = readFileSync(resolve(STAGE_DIR, '..', 'shoot.js'), 'utf8')
    expect(shoot).toMatch(/S\.shootPaths\(STAGE, process\.env\)/)
    expect(shoot).toMatch(/S\.checkLaunchedApp\(LAUNCH\)/)
    const launch = readFileSync(join(STAGE_DIR, 'launch.js'), 'utf8')
    expect(launch).toMatch(/S\.isRecordedProcess\(rec, S\.processIdentity\(rec\.pid\)\)/)
    expect(launch).not.toMatch(/process\.kill\(-rec\.pid, 'SIGTERM'\) \} catch/)
  })
})

describe('the guard works on the real path of the root; links at or below it are refused, links above it are not (CI, macOS)', () => {
  // Host-safe stand-ins for what the quarantined links test plants for real:
  // `realpath` and `isLink` say which folders are links, nothing is made.
  const posix = (links: Record<string, string>) => ({
    registryFolders: () => [] as string[],
    userHome: () => '/Users/me',
    osHome: () => '/Users/me',
    exists: () => true,
    isLink: (p: string) => Object.keys(links).some((l) => p === l),
    realpath: (p: string) => {
      for (const [l, to] of Object.entries(links)) if (p === l || p.startsWith(l + '/')) return to + p.slice(l.length)
      return p
    },
  })
  const env = (root: string, more: Record<string, string> = {}) => ({ CCC_STAGE_ROOT: root, CCC_STAGE_DEV: `${root}/dev`, HOME: '/Users/me', ...more })

  it('[host] a system link ABOVE the root (macOS /var -> /private/var) is resolved, and the layout is on the real path', () => {
    const st = S.resolveStage(env('/var/folders/x/T/stage'), 'darwin', posix({ '/var': '/private/var' }))
    expect(st.ROOT).toBe('/private/var/folders/x/T/stage')
    expect(st.DATA).toBe('/private/var/folders/x/T/stage/data')
    expect(st.DEV).toBe('/private/var/folders/x/T/stage/dev')
  })

  it('[host] a staging folder given in the other spelling of the root is the same folder', () => {
    const st = S.resolveStage(env('/var/folders/x/T/stage', { CCC_STAGE_HOME: '/var/folders/x/T/stage/data/home' }), 'darwin', posix({ '/var': '/private/var' }))
    expect(st.HOME).toBe('/private/var/folders/x/T/stage/data/home')
  })

  it('[host] noLinkBelow: the root itself and every folder down to the target, never above the root', () => {
    const d = (links: string[]) => ({ exists: () => true, isLink: (p: string) => links.includes(p) })
    expect(S.noLinkBelow('/srv/stage', '/srv/stage/data/home', 'darwin', d([]))).toBe(true)
    expect(S.noLinkBelow('/srv/stage', '/srv/stage/data/home', 'darwin', d(['/srv']))).toBe(true)
    expect(S.noLinkBelow('/srv/stage', '/srv/stage/data/home', 'darwin', d(['/srv/stage']))).toBe(false)
    expect(S.noLinkBelow('/srv/stage', '/srv/stage/data/home', 'darwin', d(['/srv/stage/data']))).toBe(false)
    expect(S.noLinkBelow('/srv/stage', '/srv/other', 'darwin', d([]))).toBe(false)
  })

  it('[host] the root itself a link: refused, even when it resolves somewhere harmless', () => {
    expect(() => S.resolveStage(env('/srv/stage'), 'darwin', posix({ '/srv/stage': '/srv/elsewhere' }))).toThrow(/the staging root \/srv\/stage is a link/)
  })

  it('[host] a staging folder that is a link below the root: refused as a link', () => {
    expect(() => S.resolveStage(env('/srv/stage'), 'darwin', posix({ '/srv/stage/data': '/Users/me/.codex' }))).toThrow(/CCC_STAGE_DATA .* has a link on its path/)
    expect(() => S.resolveStage(env('/srv/stage', { CCC_STAGE_RUNNER: '/srv/stage/run/inner' }), 'darwin', posix({ '/srv/stage/run': '/tmp/other' }))).toThrow(/CCC_STAGE_RUNNER .* has a link on its path/)
  })

  it('[host] a root that resolves into a protected folder through a link above it: refused by its real path', () => {
    expect(() => S.resolveStage(env('/srv/x/stage'), 'darwin', posix({ '/srv/x': '/Users/me/.codex' }))).toThrow(/overlaps .*\.codex/)
  })

  it('[host] the projects folder: resolved to its real path, a link at it or a project folder that is a link refused', () => {
    const b = base()
    const dev = join(b, 'dev')
    write(join(dev, 'web', S.DEV_MARKER), 'm')
    const linkAt = (p: string) => (q: string) => resolve(q) === resolve(p)
    // A link above the projects folder is resolved, not refused.
    expect(() => S.checkDevTargets(dev, { isLink: linkAt(b) })).not.toThrow()
    expect(() => S.checkDevTargets(dev, { isLink: linkAt(join(dev, 'web')) })).toThrow(/was not made by this tool/)
    expect(() => S.checkDevTargets(dev, { isLink: linkAt(dev) })).toThrow(/projects folder .* is a link/)
  })
})
