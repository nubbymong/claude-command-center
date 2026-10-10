// HOST QUARANTINE: starts real processes (Windows PowerShell 5.1, PowerShell 7 when present, cmd.exe, node, csc.exe and the program it builds). [CI] [VM] only -- never run on the owner's machine.
// A Windows Claude session's agent templates reach Claude Code as JSON that
// parses to exactly the object keyed by name that its --agents takes, through
// the real shells. The app's own value (agentsEnvValue of claudeAgentsObject,
// for the program its line starts) goes in the environment and the app's own
// launch line (buildClaudeLaunchCommand) is run by Windows PowerShell 5.1, the
// session shell, and by PowerShell 7 when it is installed (or named by
// CCC_TEST_PWSH, for a portable copy). Claude Code is present only as a
// stand-in that writes the arguments it got to a file: npm's own claude.cmd
// launcher (the body npm writes, starting node on Claude Code's script path)
// or a claude.bat running node, in a folder with a space and parentheses, or a
// claude.exe built here with csc.exe that writes them as the .NET runtime
// split them AND as CommandLineToArgvW splits the same command line. Directly,
// and through the tree's own resume picker; and the longest templates the
// line lets through npm's launcher arrive whole. No Claude Code, no app, no
// network; every process gets a fresh environment (isolatedProbeEnv). Windows
// only. Pure models of the same readers: agents-env-launch.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENTS_ENV, agentsEnvValue } from '../../../src/main/terminal-launch-line'
import { buildClaudeLaunchCommand, claudeAgentsObject, claudeLaunchProgram, quoteArgForShell, type BuildClaudeLaunchCommandOptions } from '../../../src/main/spawn-claude-command'
import { isolatedProbeEnv } from '../../helpers/home-guard-core.mjs'

const BS = String.fromCharCode(92)
const SYSROOT = process.env.SystemRoot || process.env.SYSTEMROOT || `C:${BS}Windows`
const POWERSHELL = path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const CSC = path.join(SYSROOT, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const PWSH = [process.env.CCC_TEST_PWSH, path.join(process.env.ProgramFiles || `C:${BS}Program Files`, 'PowerShell', '7', 'pwsh.exe')]
  .find((p): p is string => typeof p === 'string' && p !== '' && fs.existsSync(p))
const onWindows = process.platform === 'win32' && fs.existsSync(POWERSHELL)
const SHELLS: Array<[string, string]> = [['Windows PowerShell 5.1', POWERSHELL], ...(PWSH ? [['PowerShell 7', PWSH] as [string, string]] : [])]
const NODE = process.execPath
const PICKER = path.resolve(__dirname, '..', '..', '..', 'scripts', 'resume-picker.js')

const TEMPLATES = [
  { name: 'reviewer', description: 'checks (a) & (b) | c > d < e ^ f', prompt: 'review it, then say done' },
  { name: 'quotes', description: 'say "hi", then "bye"', prompt: `paths C:${BS}temp${BS} and ${BS}${BS}server${BS}share${BS} and a ${BS}"quoted${BS}" word` },
  { name: 'signs', description: '100% of %PATH% and !USERNAME! and ^^ and %%', prompt: 'caf\u00e9 \u4e2d\u6587 \u{1F600} tab\there\nnew line\u007f', model: 'opus[1m]', tools: ['Bash', 'Read'] },
]
/** What Claude Code must get: one object keyed by name, each holding the rest
 *  of its template. */
const AGENTS = Object.fromEntries(TEMPLATES.map(({ name, ...rest }) => [name, rest]))

/** The body npm writes for claude.cmd (cmd-shim): it starts node, found beside
 *  it or by name, on Claude Code's script under its own folder. */
const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n') + '\r\n'

/** The .exe stand-in: its arguments as the .NET runtime split them, and the
 *  same command line as CommandLineToArgvW splits it, as JSON. No backslash in
 *  the source: (char)92 stands for one. */
const CS_SOURCE = [
  'using System; using System.IO; using System.Text; using System.Runtime.InteropServices;',
  'static class P {',
  '  [DllImport("kernel32.dll")] static extern IntPtr GetCommandLineW();',
  '  [DllImport("shell32.dll")] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string line, out int n);',
  '  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);',
  '  static string Q(string s) { char q = (char)34, b = (char)92; var o = new StringBuilder(); o.Append(q); foreach (char c in s) { if (c == q || c == b) { o.Append(b); o.Append(c); } else if (c < (char)32) { o.Append(b); o.Append((char)117); o.Append(((int)c).ToString("x4")); } else o.Append(c); } o.Append(q); return o.ToString(); }',
  '  static string A(string[] a, int from) { var o = new StringBuilder("["); for (int i = from; i < a.Length; i++) { if (i > from) o.Append(","); o.Append(Q(a[i])); } return o.Append("]").ToString(); }',
  '  static int Main(string[] args) {',
  '    string line = Marshal.PtrToStringUni(GetCommandLineW()); int n; IntPtr p = CommandLineToArgvW(line, out n); var w = new string[n];',
  '    for (int i = 0; i < n; i++) w[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, i * IntPtr.Size)); LocalFree(p);',
  '    string q = ((char)34).ToString();',
  '    File.WriteAllText(Environment.GetEnvironmentVariable("CCC_TEST_MARK"), "{" + q + "clr" + q + ":" + A(args, 0) + "," + q + "cltaw" + q + ":" + A(w, 1) + "}", new UTF8Encoding(false));',
  '    return 0;',
  '  }',
  '}',
].join('\r\n')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-agents-ps-'))
const EXE_STANDIN = path.join(ROOT, 'cs', 'claude.exe')
const MARKER = path.join(ROOT, 'marker.cjs')
const REC = path.join(ROOT, 'rec.mjs')
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }) })

beforeAll(() => {
  if (!onWindows) return
  fs.writeFileSync(MARKER, "require('fs').writeFileSync(process.env.CCC_TEST_MARK, JSON.stringify({ argv: process.argv.slice(2) }))\n")
  fs.writeFileSync(REC, "import { appendFileSync } from 'fs'\nappendFileSync(process.env.CCC_TEST_REC, JSON.stringify({ script: process.argv[1] ?? null, argv: process.argv.slice(2) }) + '\\n')\n")
  fs.mkdirSync(path.dirname(EXE_STANDIN))
  fs.writeFileSync(path.join(ROOT, 'cs', 'dump.cs'), CS_SOURCE)
  const r = spawnSync(CSC, ['-nologo', `-out:${EXE_STANDIN}`, path.join(ROOT, 'cs', 'dump.cs')], { env: isolatedProbeEnv(path.join(ROOT, 'csc-home')), encoding: 'utf8', timeout: 120_000, windowsHide: true })
  if (!fs.existsSync(EXE_STANDIN)) throw new Error(`csc.exe built no stand-in (${CSC}): ${r.stdout}${r.stderr}`)
}, 180_000)

type Launcher = 'claude.exe' | 'claude.cmd' | 'claude.bat'
type Result = { line: string; stderr: string; mark: Record<string, string[]> | null; picker: string[] | null; settings: string }

/** The app's launch for these options: the value in the environment, written
 *  for the program the line starts, and the line naming it. */
function appLaunch(opts: BuildClaudeLaunchCommandOptions): { line: string; env: Record<string, string> } {
  const value = agentsEnvValue(claudeAgentsObject(TEMPLATES), claudeLaunchProgram(opts))
  return {
    line: buildClaudeLaunchCommand({ ...opts, agentsFlag: '', agentsFromEnv: true, agentsValueLength: value.length }),
    env: { [AGENTS_ENV]: value },
  }
}

/** The app's launch for the longest templates it lets this line start: one
 *  template whose prompt (text that grows when written for the line) is as
 *  long as the builder takes, one character more being refused. */
function longestLaunch(opts: BuildClaudeLaunchCommandOptions): { line: string; env: Record<string, string>; agents: unknown } {
  const piece = `a"b%c!d${BS}e & f | g < h > i ^ j `
  const make = (n: number): { agents: unknown; value: string } => {
    const agents = claudeAgentsObject([{ name: 'big', description: 'd', prompt: piece.repeat(Math.ceil(n / piece.length) + 1).slice(0, n) }])
    return { agents, value: agentsEnvValue(agents, claudeLaunchProgram(opts)) }
  }
  const line = (n: number): string | null => {
    try { return buildClaudeLaunchCommand({ ...opts, agentsFlag: '', agentsFromEnv: true, agentsValueLength: make(n).value.length }) } catch { return null }
  }
  let lo = 0
  let hi = 20_000
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (line(mid) !== null) lo = mid; else hi = mid - 1 }
  expect(lo).toBeGreaterThan(1_000)
  expect(line(lo + 1)).toBeNull()
  const { agents, value } = make(lo)
  return { line: line(lo)!, env: { [AGENTS_ENV]: value }, agents }
}

let seq = 0
async function run(shell: string, launcher: Launcher, route: 'direct' | 'picker', launch: (o: BuildClaudeLaunchCommandOptions) => { line: string; env: Record<string, string> } = appLaunch): Promise<Result> {
  const dir = path.join(ROOT, `run-${++seq}`)
  const stub = path.join(dir, 'stub (x)')
  const proj = path.join(dir, 'proj')
  const cfg = path.join(dir, 'cfg dir')
  for (const d of [stub, proj, cfg]) fs.mkdirSync(d, { recursive: true })
  const bin = path.join(stub, launcher)
  if (launcher === 'claude.exe') fs.copyFileSync(EXE_STANDIN, bin)
  else if (launcher === 'claude.bat') fs.writeFileSync(bin, `@"${NODE}" "${MARKER}" %*\r\n`)
  else {
    fs.writeFileSync(bin, NPM_SHIM)
    const script = path.join(stub, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.copyFileSync(MARKER, script)
  }
  const settings = path.join(cfg, 'settings (1).json')
  fs.writeFileSync(settings, '{}\n')
  const mark = path.join(dir, 'mark.json')
  const rec = path.join(dir, 'rec.jsonl')
  const opts: BuildClaudeLaunchCommandOptions = {
    platform: 'win32', cwd: proj, claudeBin: bin, extraFlags: ` --settings ${quoteArgForShell(settings, true)}`, agentsFlag: '',
    userArgs: '--verbose', useResumePicker: route === 'picker', pickerScript: route === 'picker' ? PICKER : null,
  }
  const { line, env: add } = launch(opts)
  const env = isolatedProbeEnv(path.join(dir, 'home')) as Record<string, string>
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k]
  env.Path = [stub, path.dirname(NODE), path.join(SYSROOT, 'System32'), SYSROOT, path.dirname(POWERSHELL)].join(';')
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(REC).href}`.trim()
  Object.assign(env, { CCC_TEST_MARK: mark, CCC_TEST_REC: rec }, add)
  const r = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(line, 'utf16le').toString('base64')],
    { cwd: dir, env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
  // A child can finish writing a moment after the shell returns.
  for (let i = 0; i < 100 && !fs.existsSync(mark); i++) await new Promise((res) => setTimeout(res, 100))
  const recs = fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { script: string | null; argv: string[] }) : []
  const p = recs.find((x) => typeof x.script === 'string' && /resume-picker\.js$/i.test(x.script))
  return { line, stderr: `${r.stdout ?? ''}${r.stderr ?? ''}`, mark: fs.existsSync(mark) ? JSON.parse(fs.readFileSync(mark, 'utf8')) : null, picker: p ? p.argv : null, settings }
}

/** The arguments the program got, each split it reports: the templates' JSON
 *  after --agents parses to exactly the templates, and every other argument is
 *  as the line wrote it. */
function expectTemplates(res: Result, launcher: Launcher): string[] {
  expect(res.mark, `${res.line}\n${res.stderr}`).not.toBeNull()
  const splits = launcher === 'claude.exe' ? [res.mark!.clr, res.mark!.cltaw] : [res.mark!.argv]
  for (const argv of splits) {
    expect(argv, res.line).toHaveLength(5)
    expect(argv[0]).toBe('--agents')
    expect(JSON.parse(argv[1]), argv[1]).toEqual(AGENTS)
    expect(argv.slice(2)).toEqual(['--settings', res.settings, '--verbose'])
  }
  return splits[0]
}

describe.runIf(onWindows)('Windows: a Claude session hands Claude Code its agent templates exactly as written', () => {
  for (const [name, shell] of SHELLS) {
    for (const launcher of ['claude.exe', 'claude.cmd', 'claude.bat'] as const) {
      it(`${name}, ${launcher} started by the line`, async () => {
        const res = await run(shell, launcher, 'direct')
        expectTemplates(res, launcher)
        expect(res.line).not.toContain('reviewer')
      }, 180_000)
    }
    for (const launcher of ['claude.exe', 'claude.cmd', 'claude.bat'] as const) {
      it(`${name}, the resume picker starting ${launcher}: it passes the templates on unchanged`, async () => {
        const res = await run(shell, launcher, 'picker')
        expect(res.picker, `${res.line}\n${res.stderr}`).not.toBeNull()
        expect(res.picker![0]).toBe('--agents')
        expect(JSON.parse(res.picker![1])).toEqual(AGENTS)
        const got = expectTemplates(res, launcher)
        expect(got).toEqual(res.picker)
      }, 180_000)
    }
    for (const route of ['direct', 'picker'] as const) {
      it(`${name}, npm's claude.cmd ${route === 'picker' ? 'through the resume picker' : 'started by the line'}: the longest templates the line lets through arrive whole`, async () => {
        let agents: unknown
        const res = await run(shell, 'claude.cmd', route, (o) => {
          const l = longestLaunch(o)
          agents = l.agents
          return { line: l.line, env: l.env }
        })
        expect(res.mark, res.stderr).not.toBeNull()
        expect(res.mark!.argv).toHaveLength(5)
        expect(res.mark!.argv[0]).toBe('--agents')
        expect(JSON.parse(res.mark!.argv[1])).toEqual(agents)
        expect(res.mark!.argv.slice(2)).toEqual(['--settings', res.settings, '--verbose'])
      }, 180_000)
    }
  }

  it('control: Windows PowerShell 5.1 hands claude.cmd JSON written on the line itself without its double quotes', async () => {
    // The harness above tells the two apart: JSON as text on the line, one template.
    const res = await run(POWERSHELL, 'claude.cmd', 'direct', (o) => ({
      line: buildClaudeLaunchCommand({ ...o, agentsFlag: ` --agents ${quoteArgForShell(JSON.stringify([TEMPLATES[0]]), true)}` }), env: {},
    }))
    expect(res.mark).not.toBeNull()
    expect(res.mark!.argv[1]).toBe('[{name:reviewer,description:checks (a) & (b) | c > d < e ^ f,prompt:review it, then say done}]')
  }, 180_000)
})
