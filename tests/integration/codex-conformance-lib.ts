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
