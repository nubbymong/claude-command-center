// rc.15 review R1 (aicc_planning#45), plan 1.2 "shell compatibility": the
// EXACT command the SSH flow types is run LITERALLY through real shells.
//
// Host side: bash / sh / dash / zsh / fish parse the single-quoted wrapper and
// hand it to the engine binary unchanged (a fake `docker` on PATH records its
// argv); no argv ever contains a JOINED sentinel, so the echo cannot forge one.
// Container side: the wrapper body runs under a real POSIX sh with the
// configured shell as its child; IN precedes the shell, the launch guard
// answers with the nonce from INSIDE the child, OUT follows the exit.
// Codex plan-review condition 4 (F13): with BASH_ENV/ENV pointing at a file
// that prints a marker, nothing runs before IN under `sh -c` -- while the
// rejected `bash -c` shape provably runs the file first (negative control).
//
// Shells that are not installed on the runner are skipped by name, never
// silently; the live SSH matrix covers zsh/fish/busybox on the fleet hosts.
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildEntryGuardCommand, composeContainerEntryCommand, entrySentinel } from '../../../src/shared/container-command'

const NONCE = '0123456789abcdef01234567'
const IN = entrySentinel(NONCE, 'IN')
const OUT = entrySentinel(NONCE, 'OUT')
const HERE = entrySentinel(NONCE, 'HERE')

function have(shell: string): boolean {
  const r = spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore', timeout: 10000, windowsHide: true })
  return !r.error && r.status === 0
}
const HOST_SHELLS = ['bash', 'sh', 'dash', 'zsh', 'fish'] as const
const CONTAINER_OUTER = ['sh', 'dash', 'busybox'] as const
const CONTAINER_INNER = ['bash', 'sh'] as const

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-entry-shell-'))
/** A fake engine on PATH that prints each argv word on its own line, bracketed. */
const fakeBin = path.join(tmp, 'bin')
fs.mkdirSync(fakeBin)
for (const name of ['docker', 'podman']) {
  const f = path.join(fakeBin, name)
  fs.writeFileSync(f, '#!/bin/sh\nfor a in "$@"; do printf "ARG<%s>\\n" "$a"; done\n')
  fs.chmodSync(f, 0o755)
}
const startupFile = path.join(tmp, 'startup.sh')
fs.writeFileSync(startupFile, 'echo STARTUP_FILE_RAN\n')
const posix = (p: string) => p.replace(/\\/g, '/')
const withFakeEngine = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` }
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function run(shell: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(shell, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, input: opts.input, env: opts.env ?? process.env })
  if (r.error) throw r.error
  return { out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr, status: r.status }
}

describe('host side: the typed line reaches the engine intact under every host shell', () => {
  const runtime = { type: 'container' as const, engine: 'podman' as const, container: 'review', sudo: false, containerDir: '/work', shell: 'sh' as const }
  const typed = composeContainerEntryCommand(runtime, NONCE)!
  const body = typed.slice(typed.indexOf("sh -c '") + "sh -c '".length, -1)

  for (const shell of HOST_SHELLS) {
    it.skipIf(!have(shell))(`${shell}: argv is [exec -it -w /work review sh -c <body>], body byte-exact, no joined sentinel anywhere`, () => {
      const { out } = run(shell, ['-c', typed], { env: withFakeEngine })
      const argv = [...out.matchAll(/ARG<([\s\S]*?)>\n/g)].map((m) => m[1])
      expect(argv).toEqual(['exec', '-it', '-w', '/work', 'review', 'sh', '-c', body])
      for (const a of argv) for (const token of [IN, OUT, HERE]) expect(a).not.toContain(token)
      // The command's own text (what the host echoes) carries the format string
      // and the arguments as separate words, never the joined token.
      expect(typed).not.toContain(IN)
    })
  }
})

describe('container side: IN before the shell, the guard answered from inside it, OUT after it exits', () => {
  for (const outer of CONTAINER_OUTER) {
    for (const inner of CONTAINER_INNER) {
      const outerArgs = outer === 'busybox' ? ['sh', '-c'] : ['-c']
      it.skipIf(!have(outer))(`${outer} -c <body> with ${inner} as the child`, () => {
        const typed = composeContainerEntryCommand({ type: 'container', container: 'x', shell: inner }, NONCE)!
        const body = typed.slice(typed.indexOf("sh -c '") + "sh -c '".length, -1)
        // The child shell reads its commands from stdin (no tty here): the
        // launch guard, then exit -- exactly what the flow types after IN.
        const { out } = run(outer, [...outerArgs, body], { input: `${buildEntryGuardCommand()}\nexit\n` })
        expect(out).toBe(`${IN}\n${HERE}\n${OUT}\n`)
      })
    }
  }

  it.skipIf(!have('sh'))('a host shell answers the guard with an EMPTY nonce (no CCC_ENTRY): never the current attempt', () => {
    const { out } = run('sh', ['-c', buildEntryGuardCommand()], { env: { ...process.env, CCC_ENTRY: '' } })
    expect(out).toBe('__CCC__HERE__\n')
    expect(out).not.toContain(HERE)
  })

  it.skipIf(!have('sh'))('a child of a DIFFERENT attempt answers with that attempt\'s nonce, not this one\'s', () => {
    const other = 'ffffffffffffffffffffffff'
    const body = composeContainerEntryCommand({ type: 'container', container: 'x', shell: 'sh' }, other)!
    const inner = body.slice(body.indexOf("sh -c '") + "sh -c '".length, -1)
    const { out } = run('sh', ['-c', inner], { input: `${buildEntryGuardCommand()}\nexit\n` })
    expect(out).toContain(entrySentinel(other, 'HERE'))
    expect(out).not.toContain(HERE)
  })
})

describe('Codex plan-review condition 4 (F13): nothing of the container runs before IN', () => {
  const body = composeContainerEntryCommand({ type: 'container', container: 'x' }, NONCE)!.replace(/^.*sh -c '/, '').slice(0, -1)
  const poisoned = { ...process.env, BASH_ENV: posix(startupFile), ENV: posix(startupFile) }

  /** ADR-009 round 3 (Codex finding: Windows CI shell selection): does THIS
   *  runner's `<shell> -c` read $ENV / $BASH_ENV BEFORE its -c body? POSIX says a
   *  non-interactive `-c` does not; some shells on a Windows PATH (a `sh` that is
   *  really bash, a restricted `bash`) do, or don't, differently from the fleet.
   *  That is a property of the chosen binary, not of our wrapper, and it made the
   *  fixtures below non-deterministic across runners. Probe it so each fixture
   *  runs only where its own premise holds and skips loudly otherwise. */
  function preSourcesStartup(shell: string): boolean {
    if (!have(shell)) return false
    const probe = path.join(tmp, `presrc-${shell}.sh`)
    fs.writeFileSync(probe, 'echo PRESOURCE_RAN\n')
    const r = spawnSync(shell, ['-c', 'echo BODY_RAN'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...process.env, ENV: posix(probe), BASH_ENV: posix(probe) },
    })
    const out = typeof r.stdout === 'string' ? r.stdout.replace(/\r\n/g, '\n') : ''
    const pre = out.indexOf('PRESOURCE_RAN'); const bod = out.indexOf('BODY_RAN')
    return pre !== -1 && (bod === -1 || pre < bod)
  }

  for (const outer of ['sh', 'dash'] as const) {
    // The positive fixture proves OUR `sh -c` wrapper body runs nothing before
    // IN. A runner `sh` that itself pre-sources $ENV cannot isolate that (its own
    // startup, not our wrapper, prints first), so skip it there rather than fail.
    it.skipIf(!have(outer) || preSourcesStartup(outer))(`${outer} -c: BASH_ENV/ENV are NOT read before IN`, () => {
      const { out } = run(outer, ['-c', body], { input: 'exit\n', env: poisoned })
      const inAt = out.indexOf(IN)
      expect(inAt).toBeGreaterThanOrEqual(0)
      const ranAt = out.indexOf('STARTUP_FILE_RAN')
      // Either the marker never printed, or it printed AFTER IN (the child bash,
      // non-interactive here, may read BASH_ENV -- by then the flow is inside).
      expect(ranAt === -1 || ranAt > inAt).toBe(true)
    })
  }

  // The negative control's premise is that THIS runner's `bash -c` pre-sources
  // BASH_ENV (the very reason we reject the bash outer). Skip where it does not.
  it.skipIf(!preSourcesStartup('bash'))('negative control: the rejected `bash -c` outer DOES run BASH_ENV before IN', () => {
    const { out } = run('bash', ['-c', body], { input: 'exit\n', env: poisoned })
    const inAt = out.indexOf(IN)
    const ranAt = out.indexOf('STARTUP_FILE_RAN')
    expect(ranAt).toBeGreaterThanOrEqual(0)
    expect(inAt).toBeGreaterThan(ranAt)
  })
})
