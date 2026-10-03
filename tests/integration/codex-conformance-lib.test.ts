// [host] P4.8 (rows 59, 60; WP1.71): the real-CLI conformance run's pure
// comparisons, proven to fail on a deliberately wrong fixture before the CI
// job relies on them (verify the verifier). PURE: reads the committed P3.1
// fixtures only; no process, no temp folder, no real Codex.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  HELP_CAPTURES, normaliseCapture, formatCapture, parseCapture, compareCapture, parseFeaturesList,
  argvShape, flagsMissingFromHelp, helpNamesSubcommand, disabledFeatures, expectedVersion,
  REVIEWED_HELP_DIFFERENCES, RUN_PATH_NAMES, withRunPaths, expectedOnPlatform, withoutLastStdoutLine,
  type Capture,
} from './codex-conformance-lib'
import { codexCommandLine, CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION } from '../../src/main/providers/codex'

const FIXTURES = join(__dirname, '../fixtures/codex/cli')
const fixture = (version: string, name: string) => readFileSync(join(FIXTURES, version, 'help', `${name}.txt`), 'utf8')
const argvOf = (op: Parameters<typeof codexCommandLine>[1]) => {
  const cmd = codexCommandLine('/opt/codex/codex', op, 'linux', {})
  if ('refused' in cmd) throw new Error(cmd.refused)
  return cmd.args
}

describe('the help captures P3.1 recorded', () => {
  for (const version of [CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION]) {
    it(`Codex ${version}: every capture the run makes has its fixture, and each reads back to itself`, () => {
      for (const c of HELP_CAPTURES) {
        const file = join(FIXTURES, version, 'help', `${c.name}.txt`)
        expect(existsSync(file), file).toBe(true)
        const parsed = parseCapture(fixture(version, c.name))
        expect(parsed, c.name).not.toBeNull()
        // Formatting what was read gives the fixture back, byte for byte.
        expect(formatCapture(parsed!), c.name).toBe(normaliseCapture(fixture(version, c.name)))
        expect(compareCapture(parsed!, fixture(version, c.name))).toEqual({ same: true, why: null, onlyInRun: [], onlyInFixture: [] })
      }
    })
  }

  it('reads the version capture as the version line and an empty stderr', () => {
    expect(parseCapture(fixture(CODEX_PINNED_CLI_VERSION, 'version'))).toEqual({ exit: 0, stdout: `codex-cli ${CODEX_PINNED_CLI_VERSION}\n`, stderr: '' })
  })

  it("a run is normalised as P3.1's capture was: no byte-order mark, LF, the non-breaking hyphen as -", () => {
    const run = { exit: 0, stdout: `\uFEFFcodex-cli ${CODEX_PINNED_CLI_VERSION}\r\n`, stderr: '' }
    expect(compareCapture(run, fixture(CODEX_PINNED_CLI_VERSION, 'version')).same).toBe(true)
    expect(normaliseCapture('read\u2011only')).toBe('read-only')
  })
})

describe('each comparison fails on a deliberately wrong fixture (verify the verifier)', () => {
  const v = CODEX_PINNED_CLI_VERSION
  const good = parseCapture(fixture(v, 'exec-help'))!

  it('help: a line dropped, a line changed, another exit code, another stream, a fixture not in the form', () => {
    const lines = good.stdout.split('\n')
    const dropped = { ...good, stdout: lines.slice(0, -2).join('\n') + '\n' }
    const r1 = compareCapture(dropped, fixture(v, 'exec-help'))
    expect(r1.same).toBe(false)
    expect(r1.onlyInFixture.length).toBeGreaterThan(0)
    const changed = { ...good, stdout: good.stdout.replace('--sandbox', '--sandbax') }
    const r2 = compareCapture(changed, fixture(v, 'exec-help'))
    expect(r2).toMatchObject({ same: false })
    expect(r2.why).toMatch(/^line \d+: .*--sandbax/)
    expect(compareCapture({ ...good, exit: 2 }, fixture(v, 'exec-help')).why).toBe('exit 2 where the fixture has exit 0')
    expect(compareCapture({ ...good, stderr: 'a warning\n' }, fixture(v, 'exec-help')).same).toBe(false)
    expect(compareCapture(good, 'not a capture').why).toBe('the fixture is not in the capture form')
    // The other version's text is not this version's.
    expect(compareCapture(parseCapture(fixture(CODEX_MIN_SUPPORTED_VERSION, 'help'))!, fixture(v, 'help')).same).toBe(false)
  })

  it("flags: every flag the reviewer and the analysis pass is in that version's exec help; one that is not is named", () => {
    for (const op of ['review', 'analysis'] as const) {
      const { path, flags } = argvShape(argvOf(op))
      expect(path).toEqual(['exec'])
      expect(flags.length).toBeGreaterThan(3)
      for (const version of [CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION]) {
        expect(flagsMissingFromHelp(flags, parseCapture(fixture(version, 'exec-help'))!.stdout), `${op} on ${version}`).toEqual([])
      }
    }
    const help = parseCapture(fixture(v, 'exec-help'))!.stdout
    expect(flagsMissingFromHelp(['--json', '--no-such-flag-ccc'], help)).toEqual(['--no-such-flag-ccc'])
    // A flag inside a longer one is not listed by it.
    expect(flagsMissingFromHelp(['--sand'], help)).toEqual(['--sand'])
    expect(flagsMissingFromHelp(['--json'], 'Options:\n      --json-schema <FILE>\n')).toEqual(['--json'])
    // A flag only mentioned in prose is not defined there: exec help names
    // `--last` in its resume line; exec resume's help defines it.
    expect(help).toMatch(/most recent with --last/)
    expect(flagsMissingFromHelp(['--last'], help)).toEqual(['--last'])
    expect(flagsMissingFromHelp(['--last'], parseCapture(fixture(v, 'exec-resume-help'))!.stdout)).toEqual([])
    expect(flagsMissingFromHelp(['--model'], 'Options:\n      --other  pass --model to change it\n')).toEqual(['--model'])
    // Short and long forms on one option line are both defined.
    expect(flagsMissingFromHelp(['-m', '--model', '-c'], help)).toEqual([])
    expect(flagsMissingFromHelp(['-x'], 'Options:\n      --max  see -x\n')).toEqual(['-x'])
  })

  it('flags: every operation the app runs, on each version that has its help captured', () => {
    // The P3.1 captures hold the top-level, exec and login help; the rest
    // (app-server, debug models, login status, logout) are read in CI only.
    const captured: Record<string, string> = { '': 'help', exec: 'exec-help', login: 'login-help' }
    for (const op of ['version', 'login-browser', 'login-device', 'login-api-key', 'review', 'analysis'] as const) {
      const { path, flags } = argvShape(argvOf(op))
      for (const version of [CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION]) {
        const text = parseCapture(fixture(version, captured[path.join(' ')]))!.stdout
        expect(flagsMissingFromHelp(flags, text), `${op} on ${version}`).toEqual([])
        expect(helpNamesSubcommand(path, text), `${op} on ${version}`).toBe(true)
      }
    }
  })

  it("subcommands: the help's Usage line names the subcommand; a dropped one that falls back to the top-level help is caught", () => {
    expect(helpNamesSubcommand(['exec'], parseCapture(fixture(v, 'exec-help'))!.stdout)).toBe(true)
    expect(helpNamesSubcommand(['exec', 'resume'], parseCapture(fixture(v, 'exec-resume-help'))!.stdout)).toBe(true)
    expect(helpNamesSubcommand(['login'], parseCapture(fixture(v, 'login-help'))!.stdout)).toBe(true)
    // 0.155.1 dropped `mcp-server`: its `--help` exits 0 with the top-level
    // help, which a flags-only check would pass (the app's logout and
    // app-server pass no flags).
    expect(parseCapture(fixture(CODEX_PINNED_CLI_VERSION, 'mcp-server-help'))!.exit).toBe(0)
    expect(helpNamesSubcommand(['mcp-server'], parseCapture(fixture(CODEX_PINNED_CLI_VERSION, 'mcp-server-help'))!.stdout)).toBe(false)
    expect(helpNamesSubcommand(['mcp-server'], parseCapture(fixture(CODEX_MIN_SUPPORTED_VERSION, 'mcp-server-help'))!.stdout)).toBe(true)
    // A nested subcommand missing from its parent's help: login's help is
    // not `login status`'s.
    expect(helpNamesSubcommand(['login', 'status'], parseCapture(fixture(v, 'login-help'))!.stdout)).toBe(false)
    // A name that only starts the path's word is not it; the top level
    // names no subcommand and matches only an empty path.
    expect(helpNamesSubcommand(['exe'], parseCapture(fixture(v, 'exec-help'))!.stdout)).toBe(false)
    expect(helpNamesSubcommand([], parseCapture(fixture(v, 'help'))!.stdout)).toBe(true)
    expect(helpNamesSubcommand(['app-server'], 'no usage line at all\n')).toBe(false)
    expect(helpNamesSubcommand(['app-server'], '\uFEFFUsage: codex.exe app-server [OPTIONS] [COMMAND]\r\n')).toBe(true)
  })

  it('argv shapes: the subcommand path and the flags, never the stdin marker or a value', () => {
    expect(argvShape(argvOf('models'))).toEqual({ path: ['debug', 'models'], flags: ['--bundled'] })
    expect(argvShape(argvOf('status'))).toEqual({ path: ['login', 'status'], flags: [] })
    expect(argvShape(argvOf('login-device'))).toEqual({ path: ['login'], flags: ['--device-auth'] })
    expect(argvShape(argvOf('version'))).toEqual({ path: [], flags: ['--version'] })
    expect(argvShape(argvOf('review')).flags).not.toContain('-')
    expect(argvShape(argvOf('review')).flags).not.toContain('read-only')
  })

  it("features: every feature the analysis disables is in that version's list; one that is not is caught", () => {
    const disabled = disabledFeatures(argvOf('analysis'))
    expect(disabled).toEqual(expect.arrayContaining(['code_mode', 'code_mode_host', 'hooks']))
    for (const version of [CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION]) {
      const list = parseFeaturesList(parseCapture(fixture(version, 'features-list'))!.stdout)
      expect(list.size).toBeGreaterThan(20)
      expect(disabled.filter((f) => !list.has(f)), version).toEqual([])
      expect([...disabled, 'no_such_feature_ccc'].filter((f) => !list.has(f))).toEqual(['no_such_feature_ccc'])
    }
  })

  it('prove-red: the help fixture with its last non-empty stdout line dropped, everything else kept', () => {
    const text = fixture(v, 'version')
    expect(parseCapture(withoutLastStdoutLine(text))).toEqual({ exit: 0, stdout: '', stderr: '' })
    expect(compareCapture(parseCapture(text)!, withoutLastStdoutLine(text)).same).toBe(false)
    const lines = good.stdout.split('\n')
    const last = lines.map((l) => l.trim() !== '').lastIndexOf(true)
    expect(last).toBeGreaterThan(10)
    expect(parseCapture(withoutLastStdoutLine(fixture(v, 'exec-help')))).toEqual({ ...good, stdout: [...lines.slice(0, last), ...lines.slice(last + 1)].join('\n') })
  })

  it('versions: the minimum and pinned come from the contract; a mismatch, a bad class or an rc without its version is refused', () => {
    const contract = { minimum: CODEX_MIN_SUPPORTED_VERSION, pinned: CODEX_PINNED_CLI_VERSION }
    expect(expectedVersion('minimum', undefined, contract)).toEqual({ kind: 'minimum', version: CODEX_MIN_SUPPORTED_VERSION })
    expect(expectedVersion('pinned', CODEX_PINNED_CLI_VERSION, contract)).toEqual({ kind: 'pinned', version: CODEX_PINNED_CLI_VERSION })
    expect(expectedVersion('pinned', '0.1.0', contract)).toHaveProperty('error')
    expect(expectedVersion('rc', '0.160.0', contract)).toEqual({ kind: 'rc', version: '0.160.0' })
    expect(expectedVersion('rc', '', contract)).toHaveProperty('error')
    expect(expectedVersion('rc', 'latest', contract)).toHaveProperty('error')
    expect(expectedVersion('newest', '0.160.0', contract)).toHaveProperty('error')
    expect(expectedVersion(undefined, undefined, contract)).toHaveProperty('error')
  })
})

// [host] P4.10: the help captures of CI run 37134624406 (fcfd2ae6) were
// reviewed per OS (docs/wp1/evidence/ci-matrix.md, "Help captures
// reviewed"). The fixtures were captured on Windows; macOS and Linux differ
// in reviewed ways only, which the comparison accepts by name before the help
// is asserted. The runs below are made from the fixtures by hand, as that run
// captured them on each OS, independently of the lib's list.
describe('the help differences reviewed per OS (P4.10)', () => {
  const VERSIONS = [CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION]
  const TMP = '/tmp/ccc-vitest-yZDdXV'
  const HOME = `${TMP}/ccc-conformance-home-cftQeL`
  const linuxWarning = (tmp: string, home: string) =>
    `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "${tmp}" (codex_home: AbsolutePathBuf("${home}"))\n`
  const APP = '  app               Launch the Desktop app (opens the app installer if missing)\n'
  const MAC_SANDBOX_OPTIONS = [
    '', '      --allow-unix-socket <ALLOW_UNIX_SOCKETS>',
    '          Allow the sandboxed command to bind/connect AF_UNIX sockets rooted at this path. Relative',
    '          paths are resolved against the current directory. Repeat to allow multiple paths',
    '', '      --log-denials',
    '          While the command runs, capture macOS sandbox denials via `log stream` and print them',
    '          after exit', '',
  ].join('\n')
  /** A capture as the reviewed run made it on that OS (real temp paths in it). */
  function observed(platform: 'darwin' | 'linux', version: string, name: string): Capture {
    const f = parseCapture(fixture(version, name))!
    let stdout = f.stdout
    if (name === 'features-list') stdout = stdout.replace(/^(secret_auth_storage +stable +)true$/m, '$1false')
    if (name === 'sandbox-help') {
      stdout = stdout.replace('under Windows restricted token sandbox', platform === 'darwin' ? 'under seatbelt' : 'under the Linux sandbox')
      if (platform === 'darwin') stdout = stdout.replace('explicit permissions profile\n', `explicit permissions profile\n${MAC_SANDBOX_OPTIONS}`)
    }
    if (platform === 'linux') stdout = stdout.replace(APP, '')
    return { exit: f.exit, stdout, stderr: platform === 'linux' ? linuxWarning(TMP, HOME) : f.stderr }
  }
  const named = (c: Capture) => withRunPaths(c, { home: HOME, tmp: TMP })
  const expected = (platform: string, version: string, name: string, text = fixture(version, name)) => {
    const e = expectedOnPlatform(text, platform, version, name)
    if ('error' in e) throw new Error(e.error)
    return e
  }

  it('every reviewed difference applies to its fixture exactly once, each is used, and Windows has none', () => {
    for (const version of VERSIONS) {
      for (const c of HELP_CAPTURES) {
        const win = expected('win32', version, c.name)
        expect(win.applied, c.name).toBe(0)
        expect(win.text).toBe(normaliseCapture(fixture(version, c.name)))
      }
    }
    for (const d of REVIEWED_HELP_DIFFERENCES) {
      for (const version of d.versions) {
        expect(VERSIONS, d.why).toContain(version)
        for (const name of d.captures) {
          const e = expectedOnPlatform(fixture(version, name), d.platform, version, name, [d])
          expect(e, `${d.platform} ${version} ${name}: ${d.why}`).toMatchObject({ applied: 1 })
        }
      }
    }
  })

  it('the run as captured on each OS compares the same once its reviewed differences are applied, and differs from the bare fixture', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const version of VERSIONS) {
        const differ: string[] = []
        for (const c of HELP_CAPTURES) {
          const run = named(observed(platform, version, c.name))
          expect(compareCapture(run, expected(platform, version, c.name).text), `${platform} ${version} ${c.name}`).toMatchObject({ same: true })
          if (!compareCapture(run, fixture(version, c.name)).same) differ.push(c.name)
        }
        expect(differ, `${platform} ${version}`).toEqual(platform === 'darwin' ? ['features-list', 'sandbox-help'] : HELP_CAPTURES.map((c) => c.name))
      }
    }
  })

  it('anything else still fails: a difference not reviewed, one on another OS, a reviewed one missing, another home in the warning', () => {
    const v = CODEX_PINNED_CLI_VERSION
    // Another OS's difference.
    expect(compareCapture(named(observed('linux', v, 'sandbox-help')), expected('darwin', v, 'sandbox-help').text).same).toBe(false)
    expect(compareCapture(named(observed('linux', v, 'help')), expected('win32', v, 'help').text).same).toBe(false)
    expect(compareCapture(named(observed('darwin', v, 'features-list')), expected('linux', v, 'features-list').text).same).toBe(false)
    // A reviewed difference that does not show: the Windows text on macOS, Linux without the stderr line.
    expect(compareCapture(parseCapture(fixture(v, 'features-list'))!, expected('darwin', v, 'features-list').text).same).toBe(false)
    expect(compareCapture({ ...named(observed('linux', v, 'help')), stderr: '' }, expected('linux', v, 'help').text).same).toBe(false)
    // The warning names a home that is not this run's own.
    expect(compareCapture(named({ ...observed('linux', v, 'version'), stderr: linuxWarning(TMP, '/home/runner/another-home') }), expected('linux', v, 'version').text).same).toBe(false)
    // A difference no one reviewed, on top of the reviewed ones.
    const extra = observed('darwin', v, 'exec-help')
    expect(compareCapture(named({ ...extra, stdout: extra.stdout.replace('--sandbox', '--sandbax') }), expected('darwin', v, 'exec-help').text).same).toBe(false)
    const more = observed('linux', v, 'help')
    expect(compareCapture(named({ ...more, stdout: `${more.stdout}  a new line\n` }), expected('linux', v, 'help').text).same).toBe(false)
    expect(compareCapture(named({ ...more, stderr: `${more.stderr}another warning\n` }), expected('linux', v, 'help').text).same).toBe(false)
  })

  it('a reviewed difference whose line the fixture does not hold exactly once is an error, never a silent pass', () => {
    const v = CODEX_PINNED_CLI_VERSION
    const help = normaliseCapture(fixture(v, 'help'))
    expect(expectedOnPlatform(help.replace(APP, ''), 'linux', v, 'help')).toEqual({ error: expect.stringMatching(/Desktop app on Linux.*exactly once in the fixture's stdout; it is there 0 times/) })
    expect(expectedOnPlatform(help.replace(APP, APP + APP), 'linux', v, 'help')).toEqual({ error: expect.stringMatching(/it is there 2 times/) })
    expect(expectedOnPlatform(help, 'linux', v, 'help', [{ ...REVIEWED_HELP_DIFFERENCES[0], platform: 'linux', captures: ['help'] }])).toHaveProperty('error')
    expect(expectedOnPlatform('not a capture', 'linux', v, 'help')).toEqual({ error: 'the fixture is not in the capture form' })
  })

  it('prove-red: with the last stdout line dropped, every capture on every OS is still red', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const version of VERSIONS) {
        for (const c of HELP_CAPTURES) {
          const run = platform === 'win32' ? parseCapture(fixture(version, c.name))! : named(observed(platform, version, c.name))
          const red = expectedOnPlatform(withoutLastStdoutLine(fixture(version, c.name)), platform, version, c.name)
          if ('error' in red) continue
          expect(compareCapture(run, red.text).same, `${platform} ${version} ${c.name}`).toBe(false)
        }
      }
    }
  })

  it("the run's own folders become names, the home first since it lies inside the temporary folder", () => {
    const c = { exit: 0, stdout: `x ${TMP}\n`, stderr: `${HOME} and ${TMP}/other\n` }
    expect(withRunPaths(c, { home: HOME, tmp: TMP })).toEqual({
      exit: 0, stdout: `x ${RUN_PATH_NAMES.tmp}\n`, stderr: `${RUN_PATH_NAMES.home} and ${RUN_PATH_NAMES.tmp}/other\n`,
    })
    expect(withRunPaths(c, { home: '', tmp: '' })).toEqual(c)
  })
})
