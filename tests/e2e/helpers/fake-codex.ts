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
 * account's folder holds the fake credential, `auth.fake`). The same guard
 * refuses an ambient credential or NODE_OPTIONS, and anything else exits 64.
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
