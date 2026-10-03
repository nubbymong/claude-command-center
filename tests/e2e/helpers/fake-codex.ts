/**
 * A fake Codex CLI for an e2e app instance, so which Codex the app sees never
 * depends on the machine the spec runs on. A real `codex` older than the
 * app's minimum made codex-session-creation.spec.ts fail ("Update Codex to
 * launch this config"); one missing, or newer than tested, changes what the
 * dialog says. The instance gets this fake, at the release the app's
 * conformance evidence pins (CODEX_PINNED_CLI_VERSION: supported), first on
 * its PATH, with every folder holding a real Codex taken off that PATH.
 *
 * The script is the observable contract of the repo's fake Codex CLI
 * (tests/wp1/fake-cli.test.ts, `FAKE`), cut to what an app instance asks it
 * without a real sign-in: `--version`, and `login status` (signed in when the
 * account's folder holds the fake credential, `auth.fake`), the usage
 * helper (`app-server`), and a Cloud Agent's `exec --json` run (WP2 PR 4,
 * P4.5; see readFakeExecRecords). The same guard refuses an ambient
 * credential or NODE_OPTIONS, and anything else exits 64.
 * On Windows it sits behind the same npm-style `.cmd` shim (npm's cmd-shim
 * template), with node's absolute path where the template runs a bare `node`,
 * so it needs no node on the PATH it is given. That fake is a constant inside
 * a vitest suite quarantined from the owner's workstation, so it cannot be
 * imported here.
 */
import fs from 'fs'
import path from 'path'
import { CODEX_PINNED_CLI_VERSION } from '../../../src/main/providers/codex/cli-contract'

const IS_WIN = process.platform === 'win32'
/** What a real Codex install puts on PATH, by platform. */
const CODEX_NAMES = ['codex', 'codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1']

export const FAKE_CODEX_VERSION = CODEX_PINNED_CLI_VERSION

function fakeScript(version: string): string {
  return [
    "const fs = require('fs'), path = require('path')",
    'const NL = String.fromCharCode(10)',
    "const a = process.argv.slice(2).join(' ')",
    "if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.NODE_OPTIONS) { process.stderr.write('LEAK' + NL); process.exit(9) }",
    `if (a === '--version') { process.stdout.write('codex-cli ${version}' + NL); process.exit(0) }`,
    'const home = process.env.CODEX_HOME',
    "if (!home) { process.stderr.write('no CODEX_HOME' + NL); process.exit(8) }",
    "const auth = path.join(home, 'auth.fake')",
    "if (a === 'login status') {",
    "  if (fs.existsSync(auth)) { process.stderr.write(fs.readFileSync(auth, 'utf8')); process.exit(0) }",
    "  process.stderr.write('Not logged in' + NL); process.exit(1)",
    '}',
    // Usage track MP7 (ADR-022): the app-server helper for a usage read.
    "if (a === 'app-server') {",
    "  let buf = ''",
    "  process.stdin.setEncoding('utf8')",
    "  process.stdin.on('data', (c) => {",
    '    buf += c',
    '    let i',
    '    while ((i = buf.indexOf(NL)) >= 0) {',
    '      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)',
    // The helper names its own version in its user agent (MP7 round 1, C-F1).
    `      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: { codexHome: home, platformFamily: 'x', platformOs: 'x', userAgent: 'codex_cli_rs/${version} (fake)' } }) + NL)`,
    "      if (m.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({ id: m.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, planType: 'plus' } } }) + NL)",
    '    }',
    '  })',
    "  process.stdin.on('end', () => process.exit(0))",
    '  setInterval(() => {}, 1000)',
    '  return',
    '}',
    // WP2 PR 4, P4.5 (row 57): a Cloud Agent's headless run, `exec --json`
    // with the task on stdin. It refuses any argv the app must never send (a
    // working-folder flag, a sandbox bypass, danger-full-access, --ephemeral,
    // --ignore-user-config), records what it was given in the account folder
    // (argv, working folder, sandbox, the task's length and SHA-256, never the
    // task), and answers with the events the real CLI writes.
    "if (process.argv[2] === 'exec') {",
    '  const args = process.argv.slice(3)',
    "  const never = ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--ephemeral', '--ignore-user-config', '-C', '--cd', 'danger-full-access']",
    "  if (args[0] !== '--json' || args[args.length - 1] !== '-' || !args.includes('--skip-git-repo-check') || args.some((x) => never.includes(x))) { process.stderr.write('refused exec ' + args.join(' ') + NL); process.exit(65) }",
    "  const at = args.indexOf('-s')",
    "  const sandbox = at >= 0 ? args[at + 1] : ''",
    "  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') { process.stderr.write('refused sandbox ' + sandbox + NL); process.exit(65) }",
    "  let task = ''",
    "  process.stdin.setEncoding('utf8')",
    '  process.stdin.on(\'data\', (c) => { task += c })',
    "  process.stdin.on('end', () => {",
    "    const sha = require('crypto').createHash('sha256').update(task).digest('hex')",
    "    fs.writeFileSync(path.join(home, 'fake-exec-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify({ args, cwd: process.cwd(), sandbox, taskLength: task.length, taskSha256: sha }))",
    '    const ev = (o) => process.stdout.write(JSON.stringify(o) + NL)',
    "    ev({ type: 'thread.started', thread_id: '00000000-0000-7000-8000-0000000000e2' })",
    "    ev({ type: 'turn.started' })",
    "    ev({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'fake agent: ' + task.length + ' characters, ' + sandbox } })",
    "    ev({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 34, reasoning_output_tokens: 0 } })",
    '    process.exit(0)',
    '  })',
    '  return',
    '}',
    "process.stderr.write('unknown ' + a + NL); process.exit(64)",
    '',
  ].join('\n')
}

/** Write the fake into `dir` (created). Returns the folder to put on PATH. */
export function installFakeCodex(dir: string, version: string = FAKE_CODEX_VERSION): string {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'fake-codex.js'), fakeScript(version))
  if (IS_WIN) {
    // npm's cmd-shim template (as the wp1 fake uses), `_prog` pinned to this
    // node. %~dp0 ends in a backslash already.
    fs.writeFileSync(path.join(dir, 'codex.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      `SET "_prog=${process.execPath}"`,
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%fake-codex.js" %*', '',
    ].join('\r\n'))
  } else {
    fs.writeFileSync(path.join(dir, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(path.join(dir, 'fake-codex.js'))})\n`, { mode: 0o755 })
    // The app finds Codex through a LOGIN shell (`$SHELL -l -c 'which
    // codex'`), whose profile may put a real one back on PATH. This stand-in
    // drops -l, so the PATH given here is the one searched.
    fs.writeFileSync(path.join(dir, 'login-shell'), '#!/bin/sh\n[ "$1" = "-l" ] && shift\nexec /bin/sh "$@"\n', { mode: 0o755 })
  }
  return dir
}

/** Sign an account folder in, as far as the fake can tell (`login status`). */
export function signInFakeRealm(realmDir: string, how = 'Logged in using an API key - sk-***'): void {
  fs.mkdirSync(realmDir, { recursive: true })
  fs.writeFileSync(path.join(realmDir, 'auth.fake'), `${how}\n`)
}

/** What the fake's `exec --json` mode recorded in an account folder, one
 *  record per run, oldest first (P4.5). Never the task itself. */
export interface FakeExecRecord {
  args: string[]
  cwd: string
  sandbox: 'read-only' | 'workspace-write'
  taskLength: number
  taskSha256: string
}

export function readFakeExecRecords(realmDir: string): FakeExecRecord[] {
  let names: string[] = []
  try { names = fs.readdirSync(realmDir).filter((n) => /^fake-exec-\d+-\d+\.json$/.test(n)) } catch { return [] }
  const stamp = (n: string) => Number(n.split('-')[2])
  return names.sort((x, y) => stamp(x) - stamp(y)).map((n) => JSON.parse(fs.readFileSync(path.join(realmDir, n), 'utf8')) as FakeExecRecord)
}

/** The folders on `pathValue` minus every one that holds a Codex. */
export function pathWithoutCodex(pathValue: string): string[] {
  return pathValue.split(path.delimiter).filter((d) => {
    if (!d) return false
    return !CODEX_NAMES.some((n) => {
      try { return fs.existsSync(path.join(d, n)) } catch { return false }
    })
  })
}

/**
 * The app instance's environment for the fake: PATH with the fake first and
 * no real Codex on it, and CODEX_HOME (the "sign-in already on this computer"
 * the app checks) an empty folder of the spec's own, never the machine's
 * ~/.codex. For launchIsolatedApp's `env`.
 */
export function fakeCodexEnv(fakeDir: string, codexHome: string): Record<string, string | undefined> {
  fs.mkdirSync(codexHome, { recursive: true })
  const inherited = process.env.PATH ?? ''
  return {
    PATH: [fakeDir, ...pathWithoutCodex(inherited)].join(path.delimiter),
    CODEX_HOME: codexHome,
    ...(IS_WIN ? {} : { SHELL: path.join(fakeDir, 'login-shell') }),
  }
}
