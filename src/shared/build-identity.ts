/**
 * Build identity — the one line that names an installed build (#384).
 *
 *   v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22
 *
 * Shown on the boot splash (before the app is even up) and in Settings → About,
 * so a screenshot or a glance at either is enough to say exactly which build
 * someone is running. Both surfaces go through formatBuildIdentity so the two
 * strings cannot drift apart — the acceptance for #384 is "identical to About".
 *
 * The inputs are the build-time defines from electron.vite.config.ts:
 *   __APP_VERSION__  package.json version, full prerelease suffix included
 *   __BUILD_SHA__    short git sha of the built commit, or "dev" outside git
 *   __BUILD_TIME__   ISO timestamp of the build
 *
 * Pure and dependency-free: main (splash query) and renderer (About) both
 * import it, and it is the unit the tests pin.
 */

export type ReleaseChannel = 'beta' | 'stable'

export const DEV_BUILD_SHA = 'dev'

/**
 * The release channel a BUILD belongs to, derived from its version the same
 * way the updater classifies release tags (github-update.ts classifyTag):
 * `-beta.N` and `-rc.N` both ride the beta channel; a plain x.y.z is stable.
 * Any other prerelease suffix is also treated as beta — it is certainly not a
 * stable release — and an unparseable/empty version degrades to stable, the
 * conservative default, rather than throwing at first paint.
 *
 * This is a property of the build, not the user's `updateChannel` setting:
 * the splash has to name the build before any config is read, and "what am I
 * running" must not change when someone flips the update preference.
 */
export function channelForVersion(version: string): ReleaseChannel {
  const m = /^v?\d+\.\d+\.\d+(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?/.exec(String(version ?? '').trim())
  return m && m[1] ? 'beta' : 'stable'
}

/**
 * Normalise a sha for display: the first 7 hex chars of whatever was baked in
 * (a full 40-char GITHUB_SHA or an already-short local one). Anything that is
 * not hex — empty, undefined, the literal "dev" — collapses to DEV_BUILD_SHA so
 * a dev build says so plainly instead of showing "undefined".
 */
export function shortSha(sha: string | undefined | null): string {
  const s = String(sha ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(s)) return DEV_BUILD_SHA
  return s.slice(0, 7)
}

/**
 * The calendar day of a build as YYYY-MM-DD (UTC — a build stamp should not
 * move with the viewer's timezone). An unparseable/missing time yields "" so
 * the formatter can simply omit the segment.
 */
export function buildDate(isoTime: string | undefined | null): string {
  const s = String(isoTime ?? '').trim()
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

export interface BuildIdentityInput {
  version: string
  sha?: string | null
  buildTime?: string | null
}

/**
 * "v<version> · <channel> · build <sha> · <date>" — segments joined by a
 * middle dot; the date segment is dropped when the build time is unknown. The
 * version keeps its full prerelease suffix (the whole point: `-beta.17` vs
 * `-beta.16` is what the owner needs to read off a screenshot).
 */
export function formatBuildIdentity(input: BuildIdentityInput): string {
  const version = String(input.version ?? '').trim().replace(/^v/, '') || '0.0.0'
  const parts = [`v${version}`, channelForVersion(version), `build ${shortSha(input.sha)}`]
  const date = buildDate(input.buildTime)
  if (date) parts.push(date)
  return parts.join(' · ')
}
