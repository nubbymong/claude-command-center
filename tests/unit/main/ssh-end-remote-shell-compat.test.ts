// WP2 T24 fix round: the End remote line, run LITERALLY through real shells.
//
// endSshRemoteDetailed (pty-manager.ts) sends one line over a separate ssh
// exec, and sshd runs it with the remote account's login shell
// (`<shell> -c '<line>'`). For a container session that line is the container
// segment (buildContainerKillCommand) followed by the host tmux kill and the
// sidecar cleanup (buildRemoteTmuxKillCommand). A container session's host
// shell can be any of bash, sh, dash, zsh or fish (the entry line is proven
// under all five, container-entry-shell-compat.test.ts), so the End line must
// parse under all five too: an `if ...; then ...; fi` probe is not fish
// syntax, and on a fish login shell it failed the WHOLE line (no container
// kill, no tmux kill, no cleanup). tcsh/csh too, at parity with the line
// before the probe: `>/dev/null 2>&1` outside quotes is a parse error there
// ("Ambiguous output redirect"), so the probe's redirections run inside
// `sh -c`. csh reads `2>/dev/null` as an argument plus a stdout redirect, as it
// always has for this line, so under csh only the parse, the exit status, the
// sentinel and the sidecar cleanup are checked.
//
// Here, with a fake `sudo` (one that refuses `-n`, one that runs its command),
// fake `podman`/`docker`/`tmux`/`pkill` that only print their argv, and HOME in
// a scratch folder:
//   - the line parses and exits 0 under each installed host shell;
//   - the sudo sentinel line appears exactly when sudo refuses;
//   - the in-container kill is attempted with the same argv either way;
//   - the host tmux kill and the sidecar cleanup run either way;
//   - the stop command the End notice shows hands the engine exactly the argv
//     End's own segment does;
//   - the in-container script itself runs under a real `sh -c`: the files go,
//     then pkill gets the anchored pattern.
//
// Shells that are not installed are skipped BY NAME, never silently. POSIX
// runners only: the line runs on the SSH host, never on Windows, and a Windows
// runner's Git Bash cannot stand in for that host's environment (HOME, PATH).
import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  mcpSessionToken: () => 'tok',
  issueMcpSessionToken: () => 'tok',
}))

import { buildContainerKillCommand, buildRemoteTmuxKillCommand, parseEndSudoSentinel, END_SUDO_SENTINEL_PREFIX } from '../../../src/main/providers/claude/ssh-shim'
import { manualContainerStopCommand, containerSessionStopScript, containerSessionKillPattern } from '../../../src/shared/container-command'

const POSIX = process.platform !== 'win32'
const NONCE = 'a1b2c3d4e5f60718a1b2c3d4'
const SID = 'lv24shellcompat'
const RUNTIME = { type: 'container', engine: 'podman', container: 'ccc-test', sudo: true } as const
const HOST_SHELLS = ['bash', 'sh', 'dash', 'zsh', 'fish'] as const
const CSH_SHELLS = ['tcsh', 'csh'] as const
const SENTINEL = `${END_SUDO_SENTINEL_PREFIX}_${NONCE}`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-end-shell-'))
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
/** The HOME the availability probe runs with: fish writes its config into
 *  HOME on a first run, and that must land in the scratch folder. */
const HAVE_HOME = path.join(tmp, 'home-have')
fs.mkdirSync(HAVE_HOME, { recursive: true })

/** The environment every shell here runs with: no shell may read or write the
 *  developer's real config. The XDG folders (fish keeps its config and
 *  history there) point into the scratch folder, and the variables that name
 *  a startup file (zsh's ZDOTDIR, BASH_ENV, sh's ENV) are removed. Each shell
 *  also runs with the scratch folder as its working directory, never the
 *  repo root. */
function shellEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(tmp, 'xdg-config'),
    XDG_DATA_HOME: path.join(tmp, 'xdg-data'),
    XDG_CACHE_HOME: path.join(tmp, 'xdg-cache'),
    ...extra,
  }
  delete env.ZDOTDIR
  delete env.BASH_ENV
  delete env.ENV
  return env
}

function have(shell: string): boolean {
  if (!POSIX) return false
  const r = spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore', timeout: 10000, cwd: tmp, env: shellEnv(HAVE_HOME) })
  return !r.error && r.status === 0
}

/** The line endSshRemoteDetailed sends for a rootful container with no saved
 *  sudo password (ssh-end-remote-password.test.ts pins that the real one is
 *  exactly this composition). */
const endLine = `${buildContainerKillCommand(SID, RUNTIME, { sudoProbeNonce: NONCE })}; ${buildRemoteTmuxKillCommand(SID)}`

/** A bin folder with a fake sudo of the given kind and argv-printing fakes. */
function fakeBin(name: string, sudo: 'refuses-n' | 'runs'): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  const write = (file: string, body: string) => {
    const f = path.join(dir, file)
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(f, 0o755)
  }
  const printArgs = (tag: string) => `for a in "$@"; do printf '${tag}<%s>\\n' "$a"; done`
  write('sudo', sudo === 'refuses-n'
    ? `${printArgs('SUDO')}\nif [ "$1" = "-n" ]; then echo "sudo: a password is required" >&2; exit 1; fi\nexec "$@"`
    : `${printArgs('SUDO')}\nif [ "$1" = "-n" ]; then shift; fi\nexec "$@"`)
  for (const engine of ['podman', 'docker']) write(engine, printArgs('ENGINE'))
  write('tmux', printArgs('TMUX'))
  write('pkill', printArgs('PKILL'))
  return dir
}
const BIN_REFUSES = POSIX ? fakeBin('bin-refuses', 'refuses-n') : ''
const BIN_RUNS = POSIX ? fakeBin('bin-runs', 'runs') : ''

/** A scratch HOME holding this session's three host sidecars. */
function freshHome(name: string): string {
  const home = path.join(tmp, name)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  for (const f of [`settings-${SID}.json`, `mcp-${SID}.json`, `ccc-status-${SID}.url`]) {
    fs.writeFileSync(path.join(home, '.claude', f), '{}')
  }
  return home
}
const sidecarsLeft = (home: string) => fs.readdirSync(path.join(home, '.claude')).filter((f) => f.includes(SID))

function run(shell: string, line: string, bin: string, home: string) {
  const r = spawnSync(shell, ['-c', line], {
    encoding: 'utf8',
    timeout: 20000,
    // TMUX cleared and TMUX_TMPDIR in the scratch folder: a real tmux on the
    // runner (the End line tries several fixed tmux paths) can then reach no
    // server but a missing one, even when the test itself runs inside tmux.
    cwd: tmp,
    env: shellEnv(home, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMUX: '', TMUX_TMPDIR: tmp }),
  })
  if (r.error) throw r.error
  return { out: r.stdout, err: r.stderr, status: r.status }
}
const argvOf = (out: string, tag: string) => [...out.matchAll(new RegExp(`${tag}<([^\\n]*)>\\n`, 'g'))].map((m) => m[1])

describe.skipIf(!POSIX)('the End line under every host login shell', () => {
  const killArgv = ['exec', 'ccc-test', 'sh', '-c', containerSessionStopScript(SID)]

  for (const shell of HOST_SHELLS) {
    it.skipIf(!have(shell))(`${shell}: sudo refuses -n -> exits 0, prints the sentinel on its own line, still tries the kill, still kills tmux and cleans up`, () => {
      const home = freshHome(`home-${shell}-refuses`)
      const { out, status } = run(shell, endLine, BIN_REFUSES, home)
      expect(status).toBe(0)
      expect(out.split('\n')).toContain(SENTINEL)
      expect(parseEndSudoSentinel(out, NONCE)).toBe(true)
      // The kill was attempted (sudo saw it) and refused before the engine ran.
      expect(argvOf(out, 'SUDO')).toEqual(['-n', 'podman', ...killArgv])
      expect(argvOf(out, 'ENGINE')).toEqual([])
      expect(argvOf(out, 'TMUX')).toEqual(['kill-session', '-t', `=ccc-${SID}`])
      expect(sidecarsLeft(home)).toEqual([])
    })

    it.skipIf(!have(shell))(`${shell}: sudo runs it -> exits 0, no sentinel, the kill reaches the engine, tmux killed, cleaned up`, () => {
      const home = freshHome(`home-${shell}-runs`)
      const { out, status } = run(shell, endLine, BIN_RUNS, home)
      expect(status).toBe(0)
      expect(out).not.toContain(END_SUDO_SENTINEL_PREFIX)
      expect(argvOf(out, 'SUDO')).toEqual(['-n', 'podman', ...killArgv])
      expect(argvOf(out, 'ENGINE')).toEqual(killArgv)
      expect(argvOf(out, 'TMUX')).toEqual(['kill-session', '-t', `=ccc-${SID}`])
      expect(sidecarsLeft(home)).toEqual([])
    })
  }

  // Parity with the line before the probe: it parses, exits 0, prints the
  // sentinel exactly when sudo refuses, and still removes the sidecars. csh
  // turns each `2>/dev/null` into an extra argument plus a stdout redirect,
  // so the argv the fakes print is not visible here.
  for (const shell of CSH_SHELLS) {
    it.skipIf(!have(shell))(`${shell}: the line parses and exits 0, the sentinel appears exactly when sudo refuses, and the sidecars are removed`, () => {
      const refusedHome = freshHome(`home-${shell}-refuses`)
      const refused = run(shell, endLine, BIN_REFUSES, refusedHome)
      expect(refused.err).not.toMatch(/Ambiguous|Syntax|syntax error/)
      expect(refused.status).toBe(0)
      expect(refused.out.split('\n')).toContain(SENTINEL)
      expect(sidecarsLeft(refusedHome)).toEqual([])
      const ranHome = freshHome(`home-${shell}-runs`)
      const ran = run(shell, endLine, BIN_RUNS, ranHome)
      expect(ran.status).toBe(0)
      expect(ran.out).not.toContain(END_SUDO_SENTINEL_PREFIX)
      expect(sidecarsLeft(ranHome)).toEqual([])
    })
  }
})

describe.skipIf(!POSIX)('the stop command the End notice shows', () => {
  const shown = manualContainerStopCommand(SID, 'podman', 'ccc-test')!
  // What End's own segment hands the engine, measured by running it.
  const endEngineArgv = () => argvOf(run('sh', endLine, BIN_RUNS, freshHome('home-end-argv')).out, 'ENGINE')

  for (const shell of HOST_SHELLS) {
    it.skipIf(!have(shell))(`${shell}: pasted as shown, it hands the engine exactly the argv End's segment does`, () => {
      const { out, status } = run(shell, shown, BIN_RUNS, freshHome(`home-${shell}-shown`))
      expect(status).toBe(0)
      // A plain sudo (it asks for the password), not `-n`.
      expect(argvOf(out, 'SUDO')[0]).toBe('podman')
      expect(argvOf(out, 'ENGINE')).toEqual(endEngineArgv())
    })
  }
})

describe.skipIf(!POSIX)('the in-container script under a real sh -c', () => {
  it.skipIf(!have('sh'))('removes the session files, then execs pkill with the anchored pattern', () => {
    const home = freshHome('home-container')
    const { out, status } = run('sh', containerSessionStopScript(SID), BIN_RUNS, home)
    expect(status).toBe(0)
    expect(sidecarsLeft(home)).toEqual([])
    expect(argvOf(out, 'PKILL')).toEqual(['-f', containerSessionKillPattern(SID)])
  })
})
