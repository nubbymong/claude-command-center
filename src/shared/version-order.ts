/**
 * Version ordering, to the precision this app's release model actually needs.
 *
 * Two comparators already existed and neither can do this job. The Sentinel one
 * (`src/main/sentinel/sentinel-version.ts`) deliberately IGNORES prerelease
 * suffixes, which is right for a "minimum Claude Code version" floor and wrong
 * here — `2.1.0-beta.13` and `2.1.0-beta.14` would compare equal. The one in
 * `training-steps.ts` splits on '.' and maps Number, so `2.1.0-beta.14` parses
 * as `[2, 1, NaN]`. Both also sit where the other process cannot reach them.
 *
 * The ordering rules come from docs/versioning.md: `-beta.N` and `-rc.N` both
 * ride the beta channel, rc outranks beta, and a final release outranks both.
 * Those fall out of standard semver precedence rather than needing special
 * cases — "beta" sorts before "rc" alphabetically, and a version WITH a
 * prerelease is lower than the same version without one.
 *
 * Pure, no dependencies, shared so main and renderer compare the same way.
 */

interface Parsed {
  release: number[]
  /** Dot-separated prerelease identifiers; empty means a final release. */
  pre: string[]
}

function parse(version: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!m) return null
  return {
    release: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** Numeric identifiers compare numerically; anything else compares as text. */
function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  // Semver: a numeric identifier always has lower precedence than a
  // non-numeric one. This is what keeps `rc.1` above `beta.14`.
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * `< 0` when a is older, `0` when equal, `> 0` when a is newer.
 *
 * An unparseable version is treated as the OLDEST thing there is, so a garbled
 * or hand-edited stored version makes the app show more than it needs to rather
 * than silently showing nothing. Two unparseable versions compare equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1

  for (let i = 0; i < 3; i++) {
    if (pa.release[i] !== pb.release[i]) return pa.release[i] - pb.release[i]
  }

  // 2.1.0 is NEWER than 2.1.0-rc.1: having no prerelease wins.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1

  const len = Math.min(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const d = compareIdentifier(pa.pre[i], pb.pre[i])
    if (d !== 0) return d
  }
  // A longer identifier list wins when everything shared is equal:
  // `beta.1.1` is newer than `beta.1`.
  return pa.pre.length - pb.pre.length
}

/** The `major.minor` line a version belongs to — "2.1" for any 2.1.x. */
export function releaseLine(version: string): string | null {
  const p = parse(version)
  return p ? `${p.release[0]}.${p.release[1]}` : null
}

/**
 * True for a build with a prerelease suffix — `2.1.0-beta.17`, `2.1.0-rc.5` —
 * and false for a final release or anything unparseable. Unparseable errs
 * toward false: a garbled version must not claim tester-only behaviour.
 */
export function isPrerelease(version: string): boolean {
  const p = parse(version)
  return p != null && p.pre.length > 0
}

/**
 * Did the user cross into a different release line?
 *
 * This is the question the first-run tour turns on: 2.0.x → 2.1.0 is a new line
 * and worth walking someone through again; 2.1.0-beta.13 → 2.1.0-beta.14 is
 * not. An unparseable "from" counts as a crossing, because we cannot show that
 * it was not one and the tour is the safer thing to get wrong.
 */
export function crossedReleaseLine(from: string, to: string): boolean {
  const a = releaseLine(from)
  const b = releaseLine(to)
  if (!a || !b) return true
  return a !== b
}
