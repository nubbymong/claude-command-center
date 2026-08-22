// Build-time identity for the app (#384): the short git sha and the build
// timestamp that electron.vite.config.ts bakes into main + renderer as
// __BUILD_SHA__ / __BUILD_TIME__. Shown on the boot splash and in Settings →
// About (src/shared/build-identity.ts formats the line).
//
// Resolution order for the sha:
//   1. GITHUB_SHA — the release workflow builds the exact commit it later tags
//      with `--target "$GITHUB_SHA"`, so this is the authoritative value in CI.
//   2. `git rev-parse HEAD` in the repo — local packaging and dev builds.
//   3. "dev" — not in git at all (a source tarball), git not installed, or any
//      other failure. A build must never fail for want of a sha.
//
// Pure given its inputs (env + an exec function) so tests can drive every
// branch without touching git.

import { execFileSync } from 'child_process'

export const DEV_BUILD_SHA = 'dev'

/**
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.env] defaults to process.env
 * @param {(file: string, args: string[], options: object) => string | Buffer} [opts.exec]
 *   defaults to execFileSync; injected by tests
 * @param {string} [opts.cwd] repo dir for the git call; defaults to process.cwd()
 * @returns {string} a 7-char lower-case sha, or "dev"
 */
export function resolveBuildSha(opts = {}) {
  const env = opts.env ?? process.env
  const exec = opts.exec ?? execFileSync
  const cwd = opts.cwd ?? process.cwd()

  const fromEnv = normalise(env.GITHUB_SHA)
  if (fromEnv) return fromEnv

  try {
    const out = exec('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const fromGit = normalise(String(out))
    if (fromGit) return fromGit
  } catch {
    /* not a git checkout / git missing — fall through */
  }
  return DEV_BUILD_SHA
}

/** 7-char lower-case prefix of a hex sha, or null when it is not one. */
function normalise(value) {
  const s = String(value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{7,40}$/.test(s) ? s.slice(0, 7) : null
}

/** The build timestamp, ISO 8601 UTC. One call per build so main and renderer agree. */
export function resolveBuildTime(now = new Date()) {
  return now.toISOString()
}
