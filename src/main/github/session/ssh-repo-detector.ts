import { parseRepoUrl } from '../security/repo-url-parser'

const START = '__CC_GIT_START__'
const END = '__CC_GIT_END__'

/**
 * Sends a one-shot command to an SSH pty and returns its captured stdout.
 *
 * IMPORTANT: This type does NOT take a `cwd` argument. The detector builds its
 * own `git -C <escaped cwd>` command and hands the fully-shell-escaped string
 * to `sendOneShot`. If a helper variant ever accepts a `cwd` and interpolates
 * it into a shell string (e.g. `cd ${cwd} && ${cmd}`), that interpolation MUST
 * use a POSIX single-quote escape — reuse posixShellEscape below. Never pass
 * a raw user-influenced `cwd` into any shell fragment without escaping.
 */
export type SendOneShotSSH = (
  sessionId: string,
  command: string,
  timeoutMs?: number,
) => Promise<string>

/**
 * POSIX single-quote shell escape. Safer than `JSON.stringify(arg)` because
 * double-quoted shell strings still expand `$(...)`, backticks, and `$VAR`,
 * leaving an injection path if the argument contains `$(rm -rf ~)` etc.
 * Single-quote wrapping disables all expansion; embedded `'` are escaped
 * as the standard `'\''` sequence.
 */
export function posixShellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export async function detectRepoFromSshSession(
  sessionId: string,
  cwd: string,
  sendOneShot: SendOneShotSSH,
): Promise<string | null> {
  // Sentinels are module-local constants — safe to inline unquoted. `cwd` is
  // attacker-influenceable (remote host path chosen by the user) so it MUST
  // pass through posixShellEscape. JSON.stringify is not safe here: double
  // quotes still permit $()/`` expansion on POSIX shells.
  const cmd = `echo ${START}; git -C ${posixShellEscape(cwd)} remote get-url origin 2>/dev/null; echo ${END}`
  let output: string
  try {
    // cwd is not passed separately — it's baked into cmd via escaping. This
    // keeps the injection surface to a single, audited interpolation site.
    output = await sendOneShot(sessionId, cmd, 5000)
  } catch {
    return null
  }
  const startIdx = output.indexOf(START)
  const endIdx = output.indexOf(END)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null
  const between = output.slice(startIdx + START.length, endIdx).trim()
  return parseRepoUrl(between)
}
