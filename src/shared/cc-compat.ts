// The Claude Code version Command Center has been validated against. This is the
// baseline the first-run Compatibility check compares the user's real version to.
// BUMP THIS as you verify Command Center on newer Claude Code releases.
export const VALIDATED_CC_VERSION = '2.1.196'

/** Compare two semver strings on major.minor.patch (pre-release suffix ignored). */
export function compareCcSemver(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

export type CcCompatStatus = 'behind' | 'current' | 'ahead'

/** Where the user's Claude Code version sits relative to the validated baseline. */
export function ccCompatStatus(version: string, baseline: string = VALIDATED_CC_VERSION): CcCompatStatus {
  const c = compareCcSemver(version, baseline)
  return c < 0 ? 'behind' : c > 0 ? 'ahead' : 'current'
}
