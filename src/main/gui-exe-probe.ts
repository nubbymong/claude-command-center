/**
 * "Would this command line bleed?" — the read-only half of #379.
 *
 * Parses the program out of a typed command line, finds the file it would run,
 * and reads that file's PE subsystem. Nothing is executed and nothing is
 * written. Every unknown answers `unresolved`, because the only consumer is a
 * UX decision whose fallback is the behaviour that already existed.
 */
import { resolveCwd } from './path-utils'
import { firstToken, resolveExecutable } from './resolve-executable'
import { sniffExecutableSubsystem } from './pe-subsystem'
import { type ExeProbeResult, type ExeSubsystem } from '../shared/gui-exe'

export interface ProbeDeps {
  platform?: NodeJS.Platform
  sniff?: (p: string) => Promise<ExeSubsystem>
  resolve?: (token: string, cwd: string) => string | null
  resolveWorkingDir?: (cwd: string | undefined) => string
}

/**
 * Classify the program a command line would start.
 *
 * Off Windows the answer is always `not-windows`: the whole mechanism is
 * `AttachConsole` + `CONOUT$`, which do not exist elsewhere, and a POSIX child
 * writing to an inherited tty is ordinary terminal behaviour that the pty
 * already captures.
 */
export async function probeCommandExe(
  command: string,
  cwd: string | undefined,
  deps: ProbeDeps = {},
): Promise<ExeProbeResult> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return { status: 'not-windows', token: null, exePath: null }

  const parsed = firstToken(command)
  if (!parsed) return { status: 'unresolved', token: null, exePath: null }

  const resolveWorkingDir = deps.resolveWorkingDir ?? resolveCwd
  const workingDir = resolveWorkingDir(cwd)
  const resolve =
    deps.resolve ??
    ((token: string, dir: string) =>
      resolveExecutable(token, { cwd: dir, pathEnv: process.env.PATH, pathExt: process.env.PATHEXT, platform }))

  const exePath = resolve(parsed.token, workingDir)
  if (!exePath) return { status: 'unresolved', token: parsed.token, exePath: null }

  const sniff = deps.sniff ?? sniffExecutableSubsystem
  const status = await sniff(exePath)
  return { status, token: parsed.token, exePath }
}
