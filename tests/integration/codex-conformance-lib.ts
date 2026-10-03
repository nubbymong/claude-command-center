/**
 * P4.8 (rows 59, 60; OD20 D7, WP1.71): the pure pieces of the real-CLI
 * conformance run (tests/integration/codex-real-cli-conformance.test.ts).
 * PURE: text in, verdict out. Nothing here starts a process or touches a
 * file; the CI job's runs feed it, and codex-conformance-lib.test.ts proves
 * each comparison fails on a deliberately wrong fixture.
 *
 * The fixtures are P3.1's, captured on the Windows test VM from Codex 0.153.4
 * and 0.155.1 (tests/fixtures/codex/cli/<version>/help/*.txt): each file is
 * `exit=<code>`, `--- stdout`, the output, `--- stderr`, the output, and the
 * capture was normalised (a byte-order mark and CRLF line endings removed, one
 * non-breaking hyphen written as `-`; docs/wp2/evidence/
 * codex-cli-capabilities-2026-09-27.md, "Fixtures and anonymisation").
 */

/** What P3.1 captured into help/, by fixture name, and the argv it ran. On
 *  0.155.1 `mcp-server --help` prints the top-level help (the subcommand is
 *  gone), and its fixture holds that. */
export const HELP_CAPTURES: ReadonlyArray<{ name: string; args: readonly string[] }> = [
  { name: 'version', args: ['--version'] },
  { name: 'help', args: ['--help'] },
  { name: 'apply-help', args: ['apply', '--help'] },
  { name: 'cloud-help', args: ['cloud', '--help'] },
  { name: 'completion-help', args: ['completion', '--help'] },
  { name: 'debug-help', args: ['debug', '--help'] },
  { name: 'exec-help', args: ['exec', '--help'] },
  { name: 'exec-resume-help', args: ['exec', 'resume', '--help'] },
  { name: 'features-help', args: ['features', '--help'] },
  { name: 'features-list', args: ['features', 'list'] },
  { name: 'login-help', args: ['login', '--help'] },
  { name: 'mcp-help', args: ['mcp', '--help'] },
  { name: 'mcp-server-help', args: ['mcp-server', '--help'] },
  { name: 'resume-help', args: ['resume', '--help'] },
  { name: 'sandbox-help', args: ['sandbox', '--help'] },
]

/** P3.1's normalisation: no byte-order mark, LF line endings, and the
 *  non-breaking hyphen (U+2011) written as `-`. */
export function normaliseCapture(text: string): string {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u2011/g, '-')
}

export interface Capture { exit: number | null; stdout: string; stderr: string }

/** A run in the fixtures' file form. */
export function formatCapture(c: Capture): string {
  return `exit=${c.exit === null ? 'null' : c.exit}\n--- stdout\n${normaliseCapture(c.stdout)}\n--- stderr\n${normaliseCapture(c.stderr)}\n`
}

/** A fixture file read back, or null when it is not in that form. */
export function parseCapture(text: string): Capture | null {
  const t = normaliseCapture(text)
  const m = /^exit=(null|-?\d+)\n--- stdout\n([\s\S]*)\n--- stderr\n([\s\S]*)\n$/.exec(t)
  if (!m) return null
  // The stdout section may itself hold a `--- stderr` line only if a CLI
  // printed one; the greedy stdout match takes the LAST marker, so a help
  // text that quotes the marker is still split where the file did.
  return { exit: m[1] === 'null' ? null : Number(m[1]), stdout: m[2], stderr: m[3] }
}

export interface CaptureComparison {
  same: boolean
  /** Why not, in a line: the exit code, or the first line that differs. */
  why: string | null
  /** Lines only in the run, and only in the fixture (a summary, unordered). */
  onlyInRun: string[]
  onlyInFixture: string[]
}

/** The run against the fixture, both normalised: the same exit code, stdout
 *  and stderr, byte for byte. A fixture that does not parse never matches. */
export function compareCapture(run: Capture, fixtureText: string): CaptureComparison {
  const fixture = parseCapture(fixtureText)
  if (!fixture) return { same: false, why: 'the fixture is not in the capture form', onlyInRun: [], onlyInFixture: [] }
  const got = parseCapture(formatCapture(run))!
  const lines = (c: Capture) => [...c.stdout.split('\n').map((l) => `stdout| ${l}`), ...c.stderr.split('\n').map((l) => `stderr| ${l}`)]
  const a = lines(got)
  const b = lines(fixture)
  const setA = new Set(a)
  const setB = new Set(b)
  const onlyInRun = a.filter((l) => !setB.has(l))
  const onlyInFixture = b.filter((l) => !setA.has(l))
  if (got.exit !== fixture.exit) return { same: false, why: `exit ${got.exit} where the fixture has exit ${fixture.exit}`, onlyInRun, onlyInFixture }
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return { same: false, why: `line ${i + 1}: ${JSON.stringify(a[i] ?? '<none>')} where the fixture has ${JSON.stringify(b[i] ?? '<none>')}`, onlyInRun, onlyInFixture }
    }
  }
  return { same: true, why: null, onlyInRun: [], onlyInFixture: [] }
}

/** The prove-red run's help fixture: its last non-empty stdout line dropped,
 *  everything else kept. */
export function withoutLastStdoutLine(fixtureText: string): string {
  const p = parseCapture(fixtureText)
  if (!p) return fixtureText
  const lines = p.stdout.split('\n')
  const last = lines.map((l) => l.trim() !== '').lastIndexOf(true)
  return formatCapture({ ...p, stdout: lines.filter((_, i) => i !== last).join('\n') })
}

/** A difference between one OS's help and the fixtures, which were captured
 *  on Windows, reviewed and accepted by name (P4.10: CI run 37134624406 at
 *  fcfd2ae6, every capture read line by line; docs/wp1/evidence/
 *  ci-matrix.md, "Help captures reviewed"). On `platform`, for the listed
 *  versions and captures, the fixture's line `line` in `stream`, which must
 *  be there exactly once, reads as `becomes` (several lines, or none). */
export interface ReviewedHelpDifference {
  platform: 'darwin' | 'linux'
  versions: readonly string[]
  captures: readonly string[]
  stream: 'stdout' | 'stderr'
  line: string
  becomes: readonly string[]
  why: string
}

/** What a capture says about the run's own folders, as names: the fresh
 *  Codex home and the temporary folder it was made in. */
export const RUN_PATH_NAMES = { home: '<RUN_HOME>', tmp: '<RUN_TMPDIR>' } as const

/** The run's own folders in a capture replaced by their names, the home
 *  first (it lies inside the temporary folder), so a line that names them
 *  compares the same on every run. */
export function withRunPaths(c: Capture, paths: { home: string; tmp: string }): Capture {
  const name = (s: string) => {
    let out = s
    if (paths.home) out = out.split(paths.home).join(RUN_PATH_NAMES.home)
    if (paths.tmp) out = out.split(paths.tmp).join(RUN_PATH_NAMES.tmp)
    return out
  }
  return { exit: c.exit, stdout: name(c.stdout), stderr: name(c.stderr) }
}

const REVIEWED_VERSIONS = ['0.153.4', '0.155.1'] as const
const DESKTOP_APP_LINE = '  app               Launch the Desktop app (opens the app installer if missing)'
const SANDBOX_ARG_ON_WINDOWS = '          Full command args to run under Windows restricted token sandbox'
const SECRET_AUTH_STORAGE_ON_WINDOWS = 'secret_auth_storage                      stable             true'
const SECRET_AUTH_STORAGE_OFF = 'secret_auth_storage                      stable             false'
const LAST_SHARED_SANDBOX_OPTION = '          Include managed requirements while resolving an explicit permissions profile'

/** Every difference the review accepted, and nothing else: once asserted, any
 *  other difference fails, and so does a reviewed one whose line the fixture
 *  no longer holds exactly once. Windows has none. */
export const REVIEWED_HELP_DIFFERENCES: readonly ReviewedHelpDifference[] = [
  {
    platform: 'darwin', versions: REVIEWED_VERSIONS, captures: ['features-list'], stream: 'stdout',
    line: SECRET_AUTH_STORAGE_ON_WINDOWS, becomes: [SECRET_AUTH_STORAGE_OFF],
    why: 'the secret_auth_storage feature is off by default on macOS',
  },
  {
    platform: 'darwin', versions: REVIEWED_VERSIONS, captures: ['sandbox-help'], stream: 'stdout',
    line: SANDBOX_ARG_ON_WINDOWS, becomes: ['          Full command args to run under seatbelt'],
    why: 'the sandbox command runs under the macOS sandbox',
  },
  {
    platform: 'darwin', versions: REVIEWED_VERSIONS, captures: ['sandbox-help'], stream: 'stdout',
    line: LAST_SHARED_SANDBOX_OPTION,
    becomes: [
      LAST_SHARED_SANDBOX_OPTION,
      '',
      '      --allow-unix-socket <ALLOW_UNIX_SOCKETS>',
      '          Allow the sandboxed command to bind/connect AF_UNIX sockets rooted at this path. Relative',
      '          paths are resolved against the current directory. Repeat to allow multiple paths',
      '',
      '      --log-denials',
      '          While the command runs, capture macOS sandbox denials via `log stream` and print them',
      '          after exit',
    ],
    why: 'two macOS-only sandbox options follow --include-managed-config',
  },
  {
    platform: 'linux', versions: REVIEWED_VERSIONS, captures: ['help'], stream: 'stdout',
    line: DESKTOP_APP_LINE, becomes: [],
    why: 'Codex offers no Desktop app on Linux',
  },
  {
    platform: 'linux', versions: ['0.155.1'], captures: ['mcp-server-help'], stream: 'stdout',
    line: DESKTOP_APP_LINE, becomes: [],
    why: 'on 0.155.1 `mcp-server --help` prints the top-level help, which has no Desktop app on Linux',
  },
  {
    platform: 'linux', versions: REVIEWED_VERSIONS, captures: ['features-list'], stream: 'stdout',
    line: SECRET_AUTH_STORAGE_ON_WINDOWS, becomes: [SECRET_AUTH_STORAGE_OFF],
    why: 'the secret_auth_storage feature is off by default on Linux',
  },
  {
    platform: 'linux', versions: REVIEWED_VERSIONS, captures: ['sandbox-help'], stream: 'stdout',
    line: SANDBOX_ARG_ON_WINDOWS, becomes: ['          Full command args to run under the Linux sandbox'],
    why: 'the sandbox command runs under the Linux sandbox',
  },
  {
    platform: 'linux', versions: REVIEWED_VERSIONS, captures: HELP_CAPTURES.map((c) => c.name), stream: 'stderr',
    line: '',
    becomes: [
      `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "${RUN_PATH_NAMES.tmp}" (codex_home: AbsolutePathBuf("${RUN_PATH_NAMES.home}"))`,
      '',
    ],
    // codex-rs/arg0/src/lib.rs:345-350 (rust-v0.155.1, rust-v0.153.4) refuses
    // on every OS when the canonical home starts with std::env::temp_dir();
    // only Linux spells the two alike (macOS canonicalises to /private/var,
    // Windows adds the verbatim \\?\ prefix), so only Linux prints the
    // warning (:189).
    why: 'Codex makes no PATH helper binaries when its canonical home starts with the temporary folder, where the run makes its fresh homes; only on Linux do the two spellings agree',
  },
]

/** The fixture as this OS's run should read: each reviewed difference for
 *  this platform, version and capture applied in turn. An error when one no
 *  longer applies (its line is not in the fixture exactly once), so a
 *  reviewed difference never passes silently against a fixture it was not
 *  made for. */
export function expectedOnPlatform(
  fixtureText: string, platform: string, version: string, name: string,
  reviewed: readonly ReviewedHelpDifference[] = REVIEWED_HELP_DIFFERENCES,
): { text: string; applied: number } | { error: string } {
  const fixture = parseCapture(fixtureText)
  if (!fixture) return { error: 'the fixture is not in the capture form' }
  const streams = { stdout: fixture.stdout.split('\n'), stderr: fixture.stderr.split('\n') }
  let applied = 0
  for (const d of reviewed) {
    if (d.platform !== platform || !d.versions.includes(version) || !d.captures.includes(name)) continue
    const lines = streams[d.stream]
    const at = lines.flatMap((l, i) => (l === d.line ? [i] : []))
    if (at.length !== 1) {
      return { error: `the reviewed ${platform} difference "${d.why}" needs ${JSON.stringify(d.line)} exactly once in the fixture's ${d.stream}; it is there ${at.length} times` }
    }
    lines.splice(at[0], 1, ...d.becomes)
    applied++
  }
  return { text: formatCapture({ exit: fixture.exit, stdout: streams.stdout.join('\n'), stderr: streams.stderr.join('\n') }), applied }
}

/** `codex features list`: name, stage, on. Lines that are not a feature row
 *  are skipped (the same reading as analysis-features.test.ts). */
export function parseFeaturesList(text: string): Map<string, { stage: string; on: boolean }> {
  const out = new Map<string, { stage: string; on: boolean }>()
  for (const line of normaliseCapture(text).split('\n')) {
    const m = /^([a-z0-9_]+)\s+(.+?)\s+(true|false)\s*$/.exec(line)
    if (m) out.set(m[1], { stage: m[2], on: m[3] === 'true' })
  }
  return out
}

/** A constant argv the app runs, split into the subcommand path it names
 *  (`debug models`, `login`, none for `--version`) and the flags it passes
 *  (`-` alone is stdin, not a flag; a flag's value is not a flag). */
export function argvShape(argv: readonly string[]): { path: string[]; flags: string[] } {
  const path: string[] = []
  let i = 0
  while (i < argv.length && /^[a-z][a-z0-9-]*$/.test(argv[i])) path.push(argv[i++])
  const flags = argv.slice(i).filter((a) => /^--?[A-Za-z]/.test(a))
  return { path, flags: [...new Set(flags)] }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The flags of `argv` that `help` does not define. A flag counts as defined
 *  only on an option line of its own (`  -m, --model <MODEL>`,
 *  `      --json`, `  -V, --version`), never when a line only mentions it in
 *  prose (exec help's "pick the most recent with --last"), and never as a
 *  piece of a longer one (`--json` inside `--json-schema`). */
export function flagsMissingFromHelp(flags: readonly string[], help: string): string[] {
  const text = normaliseCapture(help)
  return flags.filter((f) => {
    const option = f.startsWith('--')
      ? `^[ \\t]+(?:-[A-Za-z0-9], )?${esc(f)}(?![A-Za-z0-9_-])`
      : `^[ \\t]+${esc(f)}(?:,|[ \\t]|$)`
    return !new RegExp(option, 'm').test(text)
  })
}

/** Whether `help` is the help of the subcommand `path`: its Usage line names
 *  that path after the program (`Usage: codex app-server [OPTIONS]`). A
 *  subcommand a release dropped can still exit 0 with the TOP-LEVEL help
 *  (0.155.1's `mcp-server --help` does), which names no path; an operation
 *  that passes no flag (logout, app-server) would otherwise pass on exit 0
 *  alone. The top level (an empty path) needs nothing. */
export function helpNamesSubcommand(path: readonly string[], help: string): boolean {
  if (path.length === 0) return true
  return new RegExp(`^Usage: \\S+ ${path.map(esc).join(' ')}(?= |$)`, 'm').test(normaliseCapture(help))
}

/** The features the analysis argv turns off (`--disable <name>`). */
export function disabledFeatures(argv: readonly string[]): string[] {
  return argv.flatMap((a, i) => (argv[i - 1] === '--disable' ? [a] : []))
}

/** Which version class a CI run is for, and the version it must be. The
 *  minimum and pinned versions come from the app's own contract
 *  (cli-contract.ts), never from the workflow, so the two cannot drift; the
 *  release candidate is the one dispatched. Null: the run is misconfigured. */
export function expectedVersion(kind: string | undefined, given: string | undefined, contract: { minimum: string; pinned: string }): { kind: 'minimum' | 'pinned' | 'rc'; version: string } | { error: string } {
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  if (kind === 'minimum' || kind === 'pinned') {
    const version = kind === 'minimum' ? contract.minimum : contract.pinned
    if (given !== undefined && given !== '' && given !== version) return { error: `the run installed ${given}, but the ${kind} version is ${version} (cli-contract.ts)` }
    return { kind, version }
  }
  if (kind === 'rc') {
    if (!given || !semver.test(given)) return { error: 'a release-candidate run needs its version (a semver) dispatched' }
    return { kind, version: given }
  }
  return { error: `unknown version class ${JSON.stringify(kind)} (minimum, pinned or rc)` }
}
