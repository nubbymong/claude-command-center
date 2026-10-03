// [CI] P4.8 (rows 59, 60; OD20 D7, WP1.71): real-CLI conformance, with no
// sign-in, against each supported Codex version the CI job installs into its
// own prefix (the minimum and pinned versions on every PR run; the release
// candidate when dispatched). It is also row 2's detection evidence per OS
// (P4.10): the app's own discovery proves the installed CLI, its version and
// its class.
//
// HOST QUARANTINE: this suite starts the REAL Codex CLI and makes temp
// folders. It runs only in CI's `codex-conformance` job, which installs the CLI
// and sets CCC_CODEX_CONFORMANCE_BIN; without it every case is skipped. Never
// on the owner's workstation. Every run gets a fresh, empty CODEX_HOME of its
// own: nothing reads or writes a user's ~/.codex, no sign-in, no network
// request is needed (help, `debug models --bundled`, `features list`). The job
// holds no secrets.
//
// What it checks, P3.1's no-sign-in checks run against the real CLI:
//   1. detection: discovery through the app's runner (cmd.exe and the npm
//      shim on Windows), and the app's own PATH resolution;
//   2. every flag of the constant command lines the app runs is defined in
//      the real help of the subcommand it names, and that help is the
//      subcommand's own (its Usage line names it);
//   3. the model list (`codex debug models --bundled`) through the app's own
//      reader, covered by the model registry, and equal to the recorded list
//      for the minimum and pinned versions (its own case, two soft checks);
//   4. `codex features list` names every feature the analysis run turns off;
//   5. help: every P3.1 capture made again and written to the run's artifacts,
//      compared with the normalised fixture as this OS reads it: the
//      fixtures were captured on Windows, and the differences reviewed per
//      OS (P4.10, CI run 37134624406) are accepted by name and nothing else
//      (REVIEWED_HELP_DIFFERENCES in codex-conformance-lib.ts). Asserted
//      when CCC_CODEX_HELP_ASSERT=1.
//
// CCC_CODEX_CONFORMANCE_PROVE_RED=1 (a dispatch input) runs every check above
// against a deliberately wrong expectation, so the job goes red once with
// each check named (P4.8: each new check shown red, then green).
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCodexPackage, discoverCodex, runCodexCli, cliCommandLine, codexCommandLine, codexShellEnv, codexCliEnv,
  parseCodexModelCatalogue, classifyCodexVersion, codexCompatibilityAllowsUse,
  CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION,
} from '../../src/main/providers/codex'
import type { CodexCliOperation, CodexRunResult, CodexFileStat } from '../../src/main/providers/codex'
import { evaluateCodexModelCoverage, type ModelRegistry } from '../../src/shared/model-registry'
import registryJson from '../../resources/model-registry.json'
import {
  HELP_CAPTURES, formatCapture, compareCapture, parseFeaturesList, argvShape, flagsMissingFromHelp,
  helpNamesSubcommand, disabledFeatures, expectedVersion, expectedOnPlatform, withRunPaths, withoutLastStdoutLine,
} from './codex-conformance-lib'

const BIN = process.env.CCC_CODEX_CONFORMANCE_BIN ?? ''
const LIVE = BIN.length > 0
const PROVE_RED = process.env.CCC_CODEX_CONFORMANCE_PROVE_RED === '1'
const HELP_ASSERT = process.env.CCC_CODEX_HELP_ASSERT === '1' || PROVE_RED
const RUN_MS = 60_000
const CASE_MS = 240_000
const FIXTURES = path.join(__dirname, '../fixtures/codex/cli')
const WRONG = 'a deliberately wrong expectation (CCC_CODEX_CONFORMANCE_PROVE_RED)'

const want = expectedVersion(process.env.CCC_CODEX_CONFORMANCE_KIND, process.env.CCC_CODEX_CONFORMANCE_VERSION, {
  minimum: CODEX_MIN_SUPPORTED_VERSION, pinned: CODEX_PINNED_CLI_VERSION,
})
const VERSION = 'version' in want ? want.version : ''
const KIND = 'kind' in want ? want.kind : ''
const OS_TAG = `${process.platform}-${process.arch}`
const OUT = LIVE ? path.resolve(process.env.CCC_CODEX_CONFORMANCE_OUT || path.join(os.tmpdir(), 'ccc-codex-conformance'), `${OS_TAG}-${KIND || 'unknown'}-${VERSION || 'unknown'}`) : ''
const report: string[] = []
const note = (line: string) => { report.push(line); console.log(`[codex-conformance] ${line}`) }

/** A fresh, empty Codex home for one run, removed after it. */
function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-conformance-home-'))
  return fn(home).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* a leftover temp folder is harmless */ } })
}

const realStat = (p: string): CodexFileStat => {
  const s = fs.statSync(p, { bigint: true })
  return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs), dev: String(s.dev), ino: String(s.ino), isFile: s.isFile() }
}

/** One no-sign-in run of the real CLI, through the app's runner and its
 *  command-line rules (on Windows the npm shim goes through an absolute
 *  cmd.exe), with the allowlisted environment and a fresh home, which
 *  `onHome` is told (the help comparison names it). */
async function run(args: readonly string[], onHome?: (home: string) => void): Promise<CodexRunResult> {
  const cmd = cliCommandLine(BIN, args, process.platform, codexShellEnv(process.env, process.platform), 'Codex')
  if ('refused' in cmd) throw new Error(`the app refuses to run ${args.join(' ')}: ${cmd.refused}`)
  return withHome((home) => {
    onHome?.(home)
    return runCodexCli(cmd, { env: codexCliEnv(process.env, home, process.platform), timeoutMs: RUN_MS })
  })
}

const argvOf = (op: CodexCliOperation): string[] => {
  const cmd = codexCommandLine('/opt/codex/codex', op, 'linux', {})
  if ('refused' in cmd) throw new Error(cmd.refused)
  return cmd.args
}

/** The command lines the app runs, with no sign-in needed to read their help. */
const OPERATIONS: readonly CodexCliOperation[] = ['version', 'status', 'logout', 'login-browser', 'login-device', 'login-api-key', 'review', 'app-server', 'models', 'analysis']

/** The model ids each recorded version's own picker lists (P3.1 fixture for
 *  the minimum; P3.8 addendum 13 for the pinned: the same five, no gpt-5.2). */
function recordedModelIds(version: string): string[] | null {
  const recorded = parseCodexModelCatalogue(fs.readFileSync(path.join(FIXTURES, CODEX_MIN_SUPPORTED_VERSION, 'debug-models-bundled.trimmed.json'), 'utf8'))
  if (!recorded) throw new Error('the recorded 0.153.4 model list does not parse')
  if (version === CODEX_MIN_SUPPORTED_VERSION) return recorded.map((m) => m.id)
  if (version === CODEX_PINNED_CLI_VERSION) return recorded.map((m) => m.id).filter((id) => id !== 'gpt-5.2')
  return null
}

describe.skipIf(!LIVE)(`the real Codex CLI, no sign-in (${OS_TAG}, ${KIND || '?'} ${VERSION || '?'})`, () => {
  beforeAll(() => {
    // The install's folder first on PATH, as a user's install puts it, for
    // the app's own resolution (`where` on Windows, a login shell elsewhere).
    process.env.PATH = `${path.dirname(BIN)}${path.delimiter}${process.env.PATH ?? ''}`
    fs.mkdirSync(path.join(OUT, 'help'), { recursive: true })
    note(`Codex ${VERSION} (${KIND}) on ${OS_TAG}; executable ${path.basename(BIN)}${PROVE_RED ? '; PROVE RED: every check runs against a wrong expectation' : ''}`)
  })

  it('the run is configured: a version class, its version from the app contract, and an absolute executable', () => {
    expect('error' in want ? want.error : null).toBeNull()
    expect(path.isAbsolute(BIN), BIN).toBe(true)
    expect(fs.existsSync(BIN), BIN).toBe(true)
  })

  it('detection (row 2): the app discovery proves the installed CLI through its real runner, with its version and class', async () => {
    const r = await discoverCodex({
      resolve: () => BIN,
      realpath: (p) => fs.realpathSync.native(p),
      stat: realStat,
      run: (cmd, env) => runCodexCli(cmd, { env, timeoutMs: RUN_MS }),
      env: process.env,
      platform: process.platform,
      versionHome: () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-conformance-version-'))
        return { home, dispose: () => fs.rmSync(home, { recursive: true, force: true }) }
      },
      now: () => Date.now(),
    })
    note(`discovery: ${r.state}, version ${r.version ?? '-'}, ${r.compatibility}${r.detail ? `, ${r.detail}` : ''}`)
    const version = PROVE_RED ? `${VERSION}-wrong` : VERSION
    expect(r, PROVE_RED ? WRONG : `discovery: ${JSON.stringify(r)}`).toMatchObject({ state: 'found', version, compatibility: classifyCodexVersion(VERSION) })
    // The minimum and pinned versions are supported; a release candidate may
    // be newer than tested, which is warned and allowed, never blocked.
    if (KIND !== 'rc') expect(r.compatibility).toBe('supported')
    expect(codexCompatibilityAllowsUse(r.compatibility)).toBe(true)
  }, CASE_MS)

  it("detection (row 2): the app's own PATH resolution finds the install, and its discovery reads the same version", async () => {
    const r = await createCodexPackage({}).setup!.discover()
    note(`discovery by PATH: ${r.state}, ${r.executable ? path.basename(r.executable) : '-'}, version ${r.version ?? '-'}`)
    const version = PROVE_RED ? `${VERSION}-wrong` : VERSION
    expect(r, PROVE_RED ? WRONG : `discovery by PATH: ${JSON.stringify(r)}`).toMatchObject({ state: 'found', version })
    expect(fs.realpathSync.native(r.executable!)).toBe(fs.realpathSync.native(BIN))
  }, CASE_MS)

  // Its own case, so a red detection never hides it and the prove-red run
  // names it: coverage and the recorded list are two soft checks, both
  // reported in one run.
  it('the model list (`codex debug models --bundled`) through the app reader: covered by the registry, and the recorded list', async () => {
    // The CLI found as the app finds it (PATH); a prerequisite here, never
    // flipped by prove-red, which the detection cases above own.
    const pkg = createCodexPackage({})
    const found = await pkg.setup!.discover()
    expect(found, `discovery by PATH, for the model list: ${JSON.stringify(found)}`).toMatchObject({ state: 'found', version: VERSION })
    // The app's reader runs it in a fresh empty home of its own.
    const cat = await pkg.setup!.modelCatalogue!()
    note(`model list: ${cat.ok ? cat.models.map((m) => m.id).join(', ') : `${cat.code}: ${cat.detail}`}`)
    expect(cat, `model list: ${JSON.stringify(cat)}`).toMatchObject({ ok: true, version: VERSION })
    if (!cat.ok) return
    const registry = registryJson as unknown as ModelRegistry
    const tested = PROVE_RED
      ? { ...registry, models: registry.models.filter((m) => m.id !== cat.models[0].id) }
      : registry
    const coverage = evaluateCodexModelCoverage(tested, { source: `Codex ${VERSION}`, models: cat.models.map((m) => ({ id: m.id, label: m.label })) })
    note(`registry coverage: ${coverage.ok ? 'ok' : coverage.reason}; missing ${coverage.missing.map((m) => m.id).join(', ') || 'none'}; not listed by this CLI ${coverage.extra.map((m) => m.id).join(', ') || 'none'}`)
    expect.soft(coverage.ok, `model list, registry coverage: ${PROVE_RED ? WRONG : `${coverage.reason}: ${coverage.missing.map((m) => m.id).join(', ')}`}`).toBe(true)
    const recorded = recordedModelIds(VERSION)
    note(`recorded list: ${recorded ? (recorded.join(',') === cat.models.map((m) => m.id).join(',') ? 'equal' : 'differs') : `none recorded for ${VERSION}`}`)
    if (recorded) expect.soft(cat.models.map((m) => m.id), `model list, the recorded list for ${VERSION}${PROVE_RED ? `: ${WRONG}` : ''}`).toEqual(PROVE_RED ? [...recorded, 'gpt-wrong'] : recorded)
  }, CASE_MS)

  it('every flag of the command lines the app runs is in the real help of the subcommand it names', async () => {
    const missing: string[] = []
    for (const op of OPERATIONS) {
      const { path: sub, flags } = argvShape(argvOf(op))
      const r = await run([...sub, '--help'])
      const shown = `codex ${sub.join(' ') || '(top level)'} --help`
      if (r.exitCode !== 0) { missing.push(`${op}: ${shown} exited ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`); continue }
      // The help must be the subcommand's own: a dropped subcommand can exit 0
      // with the top-level help.
      const named = PROVE_RED ? [...sub, 'no-such-subcommand-ccc'] : sub
      if (!helpNamesSubcommand(named, r.stdout)) missing.push(`${op}: ${shown} is not the help of codex ${named.join(' ')} (its Usage line names another)`)
      const tested = PROVE_RED ? [...flags, '--no-such-flag-ccc'] : flags
      for (const f of flagsMissingFromHelp(tested, r.stdout)) missing.push(`${op}: ${f} (${shown})`)
    }
    note(`flags: ${missing.length === 0 ? 'every flag defined, each in its subcommand help' : missing.join('; ')}`)
    expect(missing, PROVE_RED ? `${WRONG}\n${missing.join('\n')}` : missing.join('\n')).toEqual([])
  }, CASE_MS)

  it('`codex features list` names every feature the analysis run turns off', async () => {
    const r = await run(['features', 'list'])
    expect(r.exitCode, r.stderr).toBe(0)
    const list = parseFeaturesList(r.stdout)
    expect(list.size).toBeGreaterThan(10)
    const disabled = PROVE_RED ? [...disabledFeatures(argvOf('analysis')), 'no_such_feature_ccc'] : disabledFeatures(argvOf('analysis'))
    const unknown = disabled.filter((f) => !list.has(f))
    note(`features: ${list.size} listed; the analysis turns off ${disabled.length}; unknown ${unknown.join(', ') || 'none'}`)
    expect(unknown, PROVE_RED ? WRONG : unknown.join(', ')).toEqual([])
  }, CASE_MS)

  it('help: every P3.1 capture made again, written to the run artifacts and compared with the normalised fixture as this OS reads it', async () => {
    const rows: string[] = []
    const mismatches: string[] = []
    for (const c of HELP_CAPTURES) {
      let home = ''
      const r = await run(c.args, (h) => { home = h })
      const raw = { exit: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      fs.writeFileSync(path.join(OUT, 'help', `${c.name}.txt`), formatCapture(raw))
      const file = path.join(FIXTURES, VERSION, 'help', `${c.name}.txt`)
      if (!fs.existsSync(file)) { rows.push(`| ${c.name} | no fixture for ${VERSION} | | captured |`); continue }
      // The prove-red run drops the fixture's last non-empty stdout line.
      const text = PROVE_RED ? withoutLastStdoutLine(fs.readFileSync(file, 'utf8')) : fs.readFileSync(file, 'utf8')
      // The run's own home and temporary folder as names (a Linux stderr line
      // names them), against the fixture as this OS reads it.
      const capture = withRunPaths(raw, { home, tmp: os.tmpdir() })
      const expected = expectedOnPlatform(text, process.platform, VERSION, c.name)
      const cmp = 'error' in expected
        ? { same: false, why: expected.error, onlyInRun: [] as string[], onlyInFixture: [] as string[] }
        : compareCapture(capture, expected.text)
      rows.push(`| ${c.name} | ${cmp.same ? 'same' : 'differs'} | ${'error' in expected ? '-' : expected.applied} | ${cmp.why ?? ''} |`)
      if (!cmp.same) {
        mismatches.push(`${c.name}: ${cmp.why}`)
        fs.writeFileSync(path.join(OUT, 'help', `${c.name}.diff.txt`), [
          `# ${c.name}: Codex ${VERSION} on ${OS_TAG} against tests/fixtures/codex/cli/${VERSION}/help/${c.name}.txt, with the differences reviewed for ${process.platform} applied`,
          `# ${cmp.why}`, '', '## only in this run', ...cmp.onlyInRun, '', '## only in the fixture', ...cmp.onlyInFixture, '',
        ].join('\n'))
      }
    }
    fs.writeFileSync(path.join(OUT, 'help-compare.md'), [`# Help against the P3.1 fixtures: Codex ${VERSION} on ${OS_TAG}`, '', '| Capture | Result | Reviewed differences applied | First difference |', '|---|---|---|---|', ...rows, ''].join('\n'))
    note(`help: ${HELP_CAPTURES.length} captured; ${mismatches.length} differ from the fixture${HELP_ASSERT ? '' : ' (reported, not asserted, until reviewed per OS)'}`)
    if (HELP_ASSERT) expect(mismatches, PROVE_RED ? WRONG : mismatches.join('\n')).toEqual([])
  }, CASE_MS)

  it('writes the run report (the artifact and the job summary)', () => {
    const text = [`## Codex ${VERSION} (${KIND}) on ${OS_TAG}`, '', ...report.map((l) => `- ${l}`), ''].join('\n')
    fs.writeFileSync(path.join(OUT, 'report.md'), text)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
    expect(report.length).toBeGreaterThan(0)
  })
})

describe.skipIf(LIVE)('the real Codex CLI, no sign-in', () => {
  it.skip('no CLI given (CCC_CODEX_CONFORMANCE_BIN): this suite runs only in the CI codex-conformance job', () => { /* skipped */ })
})
