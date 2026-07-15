import { describe, it, expect } from 'vitest'

// release.js is plain Node.js (CommonJS) and guards main() behind
// `require.main === module`, so require()-ing it here imports only the pure
// helpers without dispatching a release.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const release = require('../../../scripts/release.js') as {
  parseVersion: (v: string) => { major: number; minor: number; patch: number; preId: string | null; preNum: number | null } | null
  releaseBranchBase: (branch: string) => string | null
  preIdForBranch: (branch: string) => string | null
  branchAllowsChannel: (branch: string, channel: string) => boolean
  branchHintFor: (channel: string) => string
  nextVersion: (current: string, opts: { branch: string; channel: string; bump?: string | null }) => string
  tagFor: (version: string, channel: string) => string
}

const { parseVersion, releaseBranchBase, preIdForBranch, branchAllowsChannel, nextVersion, tagFor } = release

// ── parseVersion ───────────────────────────────────────────────────
describe('release parseVersion', () => {
  it('parses a bare stable version', () => {
    expect(parseVersion('2.0.0')).toEqual({ major: 2, minor: 0, patch: 0, preId: null, preNum: null })
  })

  it('parses the rc and beta prerelease shapes actually in use', () => {
    expect(parseVersion('2.0.0-rc.2')).toEqual({ major: 2, minor: 0, patch: 0, preId: 'rc', preNum: 2 })
    expect(parseVersion('2.1.0-beta.0')).toEqual({ major: 2, minor: 1, patch: 0, preId: 'beta', preNum: 0 })
  })

  it('rejects the retired v1 TAG shape and other junk', () => {
    // `v1.5.45-beta` was a tag, never a package.json version. A counter-less
    // prerelease has no successor, so refusing it beats guessing.
    expect(parseVersion('1.5.45-beta')).toBeNull()
    expect(parseVersion('v2.0.0')).toBeNull()
    expect(parseVersion('2.0')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
})

// ── releaseBranchBase ──────────────────────────────────────────────
describe('release releaseBranchBase', () => {
  it('accepts both the real branch name and the form CLAUDE.md documents', () => {
    // Reality is `release/2.0.0`; the docs say `release/vX.Y.Z`. Both match the
    // `release/**` ruleset, so both must work.
    expect(releaseBranchBase('release/2.0.0')).toBe('2.0.0')
    expect(releaseBranchBase('release/v2.0.0')).toBe('2.0.0')
  })

  it('is null for non-release branches', () => {
    expect(releaseBranchBase('beta')).toBeNull()
    expect(releaseBranchBase('main')).toBeNull()
    expect(releaseBranchBase('release/notaversion')).toBeNull()
    expect(releaseBranchBase('fix/release/2.0.0')).toBeNull()
  })
})

// ── branch → prerelease identifier ─────────────────────────────────
describe('release preIdForBranch', () => {
  it('derives the identifier from the branch, not the channel', () => {
    expect(preIdForBranch('beta')).toBe('beta')
    expect(preIdForBranch('release/2.0.0')).toBe('rc')
    expect(preIdForBranch('main')).toBeNull()
  })
})

// ── branch ↔ channel ───────────────────────────────────────────────
describe('release branchAllowsChannel', () => {
  it('lets the beta channel run from a release branch', () => {
    // The regression that made `npm run release` unusable for rc.1/rc.2: the old
    // map was a strict beta→beta equality, so every release branch was rejected.
    expect(branchAllowsChannel('release/2.0.0', 'beta')).toBe(true)
    expect(branchAllowsChannel('beta', 'beta')).toBe(true)
  })

  it('pins stable to main', () => {
    expect(branchAllowsChannel('main', 'stable')).toBe(true)
    expect(branchAllowsChannel('beta', 'stable')).toBe(false)
    expect(branchAllowsChannel('release/2.0.0', 'stable')).toBe(false)
  })

  it('keeps dev on beta only', () => {
    expect(branchAllowsChannel('beta', 'dev')).toBe(true)
    expect(branchAllowsChannel('release/2.0.0', 'dev')).toBe(false)
  })

  it('rejects a feature branch on every channel', () => {
    for (const channel of ['stable', 'beta', 'dev']) {
      expect(branchAllowsChannel('fix/whatever', channel)).toBe(false)
    }
  })
})

// ── nextVersion ────────────────────────────────────────────────────
describe('release nextVersion on a release branch', () => {
  it('increments the rc counter', () => {
    // The headline bug: `2.0.0-rc.2`.split('.').map(Number) => [2,0,NaN,2],
    // which produced the four-component "2.0.1.2".
    expect(nextVersion('2.0.0-rc.2', { branch: 'release/2.0.0', channel: 'beta' })).toBe('2.0.0-rc.3')
    expect(nextVersion('2.0.0-rc.1', { branch: 'release/2.0.0', channel: 'beta' })).toBe('2.0.0-rc.2')
  })

  it('starts at rc.1 when a release branch is first cut from a beta', () => {
    expect(nextVersion('2.0.0-beta.6', { branch: 'release/2.0.0', channel: 'beta' })).toBe('2.0.0-rc.1')
  })

  it('takes the base version from the branch NAME, not package.json', () => {
    // Guards against a stray 2.1.0-rc.1 being cut on release/2.0.0 if the branch
    // was cut before beta's version line moved on.
    expect(nextVersion('2.1.0-beta.4', { branch: 'release/2.0.0', channel: 'beta' })).toBe('2.0.0-rc.1')
  })

  it('refuses a base bump — that would be a different release', () => {
    expect(() => nextVersion('2.0.0-rc.2', { branch: 'release/2.0.0', channel: 'beta', bump: 'minor' }))
      .toThrow(/release branch stabilizes exactly 2\.0\.0/)
  })
})

describe('release nextVersion on beta', () => {
  it('increments the beta counter without touching the base', () => {
    // 2.1.0 has not shipped, so a default patch bump (the old behaviour) would
    // have wrongly moved this to 2.1.1.
    expect(nextVersion('2.1.0-beta.0', { branch: 'beta', channel: 'beta' })).toBe('2.1.0-beta.1')
    expect(nextVersion('2.0.0-beta.5', { branch: 'beta', channel: 'beta' })).toBe('2.0.0-beta.6')
  })

  it('resets the counter to .1 when the base moves', () => {
    expect(nextVersion('2.1.0-beta.3', { branch: 'beta', channel: 'beta', bump: 'minor' })).toBe('2.2.0-beta.1')
    expect(nextVersion('2.1.0-beta.3', { branch: 'beta', channel: 'beta', bump: 'major' })).toBe('3.0.0-beta.1')
    expect(nextVersion('2.1.0-beta.3', { branch: 'beta', channel: 'beta', bump: 'patch' })).toBe('2.1.1-beta.1')
  })

  it('keeps the -beta.N line for a dev release rather than forking a -dev.N series', () => {
    expect(nextVersion('2.1.0-beta.2', { branch: 'beta', channel: 'dev' })).toBe('2.1.0-beta.3')
  })
})

describe('release nextVersion for stable', () => {
  it('strips the prerelease suffix', () => {
    // `--no-bump` used to be the promote path, which would have shipped stable
    // under the tag v2.0.0-rc.2.
    expect(nextVersion('2.0.0-rc.2', { branch: 'main', channel: 'stable' })).toBe('2.0.0')
    expect(nextVersion('2.1.0-beta.4', { branch: 'main', channel: 'stable' })).toBe('2.1.0')
  })

  it('is idempotent on an already-stable version', () => {
    expect(nextVersion('2.0.0', { branch: 'main', channel: 'stable' })).toBe('2.0.0')
  })

  it('refuses a bump — stable ships the RC base unchanged', () => {
    expect(() => nextVersion('2.0.0-rc.2', { branch: 'main', channel: 'stable', bump: 'minor' }))
      .toThrow(/not valid for a stable release/)
  })
})

describe('release nextVersion error handling', () => {
  it('throws on an unparseable version instead of emitting NaN', () => {
    expect(() => nextVersion('garbage', { branch: 'beta', channel: 'beta' })).toThrow(/Cannot parse version/)
  })

  it('throws on a branch that is not a release line', () => {
    expect(() => nextVersion('2.1.0-beta.0', { branch: 'fix/whatever', channel: 'beta' }))
      .toThrow(/not a release line/)
  })
})

// ── tagFor ─────────────────────────────────────────────────────────
describe('release tagFor', () => {
  it('does not double-suffix a version that already carries a prerelease', () => {
    // The old code produced `v2.0.0-rc.2-beta`, so the script pre-cleaned and
    // verified a tag the workflow never creates.
    expect(tagFor('2.0.0-rc.2', 'beta')).toBe('v2.0.0-rc.2')
    expect(tagFor('2.1.0-beta.1', 'beta')).toBe('v2.1.0-beta.1')
    expect(tagFor('2.1.0-beta.1', 'dev')).toBe('v2.1.0-beta.1')
  })

  it('tags a stable version bare', () => {
    expect(tagFor('2.0.0', 'stable')).toBe('v2.0.0')
  })

  it('keeps the retired v1 channel-suffix scheme for bare non-stable versions', () => {
    expect(tagFor('1.5.45', 'beta')).toBe('v1.5.45-beta')
    expect(tagFor('1.5.45', 'dev')).toBe('v1.5.45-dev')
  })

  // This is the contract with .github/workflows/release.yml → "Determine
  // version". If that shell logic changes, this test must change with it.
  it('agrees with the workflow for every version/channel pair we ship', () => {
    const workflowTag = (version: string, channel: string) => {
      if (version.includes('-')) return `v${version}`
      if (channel === 'beta') return `v${version}-beta`
      if (channel === 'dev') return `v${version}-dev`
      return `v${version}`
    }
    for (const version of ['2.0.0-rc.2', '2.1.0-beta.1', '2.0.0', '1.5.45']) {
      for (const channel of ['stable', 'beta', 'dev']) {
        expect(tagFor(version, channel)).toBe(workflowTag(version, channel))
      }
    }
  })
})

// ── end-to-end: the real cycles ────────────────────────────────────
describe('release version flow across a full cycle', () => {
  it('walks the 2.0.0 stabilization exactly as it happened', () => {
    let v = '2.0.0-beta.6'
    v = nextVersion(v, { branch: 'release/2.0.0', channel: 'beta' })
    expect(v).toBe('2.0.0-rc.1')
    expect(tagFor(v, 'beta')).toBe('v2.0.0-rc.1')

    v = nextVersion(v, { branch: 'release/2.0.0', channel: 'beta' })
    expect(v).toBe('2.0.0-rc.2')
    expect(tagFor(v, 'beta')).toBe('v2.0.0-rc.2')

    v = nextVersion(v, { branch: 'main', channel: 'stable' })
    expect(v).toBe('2.0.0')
    expect(tagFor(v, 'stable')).toBe('v2.0.0')
  })

  it('keeps beta moving independently while a release branch stabilizes', () => {
    // The whole point of the RC-branch model: beta is never frozen.
    let beta = '2.1.0-beta.0'
    beta = nextVersion(beta, { branch: 'beta', channel: 'beta' })
    expect(beta).toBe('2.1.0-beta.1')
    const rc = nextVersion('2.0.0-rc.2', { branch: 'release/2.0.0', channel: 'beta' })
    expect(rc).toBe('2.0.0-rc.3')
    // The two lines never collide.
    expect(tagFor(beta, 'beta')).not.toBe(tagFor(rc, 'beta'))
  })
})
