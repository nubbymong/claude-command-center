// The parts of the Codex CLI's observable contract this app relies on (WP2,
// plan A7, A8; design 5.6, 9.2). PURE: text in, classification out. Nothing
// here spawns the CLI, reads a file or keeps the text it was given -- the
// runner hands over output, gets a verdict back, and the output is dropped.
import { compareVersions } from '../../../shared/version-order'
import type { Compatibility, KnownAuthState } from '../../../shared/providers'

/** The oldest release the managed flows were proven on. */
export const CODEX_MIN_SUPPORTED_VERSION = '0.153.4'
/** The release the D7 conformance evidence pins. */
export const CODEX_PINNED_CLI_VERSION = '0.155.1'
/** The newest release the managed flows were tested on. Newer is `too-new`:
 *  warned and allowed, never silently called compatible (design 8.4). */
export const CODEX_MAX_TESTED_VERSION = '0.156.1'

/** `codex --version` prints `codex-cli <semver>`. Anything else -- or two
 *  banners that disagree -- is not a version this app can reason about, so it
 *  is null, never a guess. Callers treat null (`unknown`) as unproven. */
export function parseCodexVersion(output: string): string | null {
  if (typeof output !== 'string' || output.length > 4096) return null
  const found = new Set<string>()
  for (const m of output.replace(/\r/g, '').matchAll(/^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\s*$/gm)) found.add(m[1])
  return found.size === 1 ? [...found][0] : null
}

/** Too old is blocked; too new is warned and allowed; unknown is unproven. */
export function classifyCodexVersion(version: string | null): Compatibility {
  if (!version) return 'unknown'
  if (compareVersions(version, CODEX_MIN_SUPPORTED_VERSION) < 0) return 'too-old'
  if (compareVersions(version, CODEX_MAX_TESTED_VERSION) > 0) return 'too-new'
  return 'supported'
}

export type CodexLoginVia = 'chatgpt' | 'api-key' | 'unknown'

export interface CodexLoginStatus {
  state: Extract<KnownAuthState, 'signed-in' | 'signed-out' | 'error'>
  /** How the realm is signed in, when the CLI says; never the credential. */
  via?: CodexLoginVia
}

// Control sequences a terminal-aware CLI may still emit on a pipe.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** Classify `codex login status` from its exit code and output alone (A7).
 *  The pinned CLI prints one line: `Logged in using ChatGPT`, `Logged in using
 *  an API key - <redacted key>`, or `Not logged in` with exit 1. Only the
 *  leading words are matched, so no part of a printed key is ever retained.
 *  Anything else -- a crash, a changed format, an unexpected exit code -- is
 *  `error`, never "signed out". */
export function parseCodexLoginStatus(exitCode: number | null, stdout: string, stderr: string): CodexLoginStatus {
  const lines = `${stdout ?? ''}\n${stderr ?? ''}`.replace(ANSI, '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
  // Exactly one status line. Other lines (a warning) may be present, but two
  // status lines that could disagree are not a verdict.
  const status = lines.filter((l) => /^(Logged in|Not logged in)\b/.test(l))
  if (status.length !== 1) return { state: 'error' }
  const line = status[0]
  if (exitCode === 0) {
    if (/^Logged in using ChatGPT\b/.test(line)) return { state: 'signed-in', via: 'chatgpt' }
    if (/^Logged in using an API key\b/.test(line)) return { state: 'signed-in', via: 'api-key' }
    if (/^Logged in\b/.test(line)) return { state: 'signed-in', via: 'unknown' }
    return { state: 'error' }
  }
  if (exitCode === 1 && /^Not logged in\b/.test(line)) return { state: 'signed-out' }
  return { state: 'error' }
}
