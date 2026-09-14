import { describe, it, expect } from 'vitest'
import {
  channelForVersion,
  shortSha,
  buildDate,
  formatBuildIdentity,
  DEV_BUILD_SHA,
} from '../../../src/shared/build-identity'

/**
 * #384 — the build identity line shown on the splash and in Settings → About.
 * These pin the derivation helpers; the rendered surfaces have their own tests
 * (splash-build-info.test.ts, build-identity-line.test.tsx) and all of them
 * go through formatBuildIdentity, so the string cannot drift between the two.
 */
describe('channelForVersion (#384)', () => {
  it('numbered betas ride the beta channel', () => {
    expect(channelForVersion('2.1.0-beta.17')).toBe('beta')
    expect(channelForVersion('v2.1.0-beta.1')).toBe('beta')
  })
  it('release candidates ride the beta channel (docs/versioning.md)', () => {
    expect(channelForVersion('2.2.0-rc.1')).toBe('beta')
    expect(channelForVersion('2.2.0-rc.3')).toBe('beta')
  })
  it('a plain x.y.z is stable', () => {
    expect(channelForVersion('2.1.0')).toBe('stable')
    expect(channelForVersion('v10.0.3')).toBe('stable')
  })
  it('any other prerelease suffix is still not stable', () => {
    expect(channelForVersion('2.1.0-alpha.2')).toBe('beta')
  })
  it('garbage/empty degrades to stable rather than throwing', () => {
    expect(channelForVersion('')).toBe('stable')
    expect(channelForVersion(undefined as unknown as string)).toBe('stable')
    expect(channelForVersion('not-a-version')).toBe('stable')
  })
})

describe('shortSha (#384)', () => {
  it('shortens a full GITHUB_SHA to 7 chars', () => {
    expect(shortSha('3a1b2e2c4d5e6f708192a3b4c5d6e7f8091a2b3c')).toBe('3a1b2e2')
  })
  it('keeps an already-short sha and lower-cases it', () => {
    expect(shortSha('3A1B2E2')).toBe('3a1b2e2')
    expect(shortSha(' 3a1b2e2 \n')).toBe('3a1b2e2')
  })
  it('collapses anything that is not a sha to "dev"', () => {
    expect(shortSha(undefined)).toBe(DEV_BUILD_SHA)
    expect(shortSha(null)).toBe(DEV_BUILD_SHA)
    expect(shortSha('')).toBe(DEV_BUILD_SHA)
    expect(shortSha('dev')).toBe(DEV_BUILD_SHA)
    expect(shortSha('not hex!')).toBe(DEV_BUILD_SHA)
    expect(shortSha('abc')).toBe(DEV_BUILD_SHA) // too short to be a sha
  })
})

describe('buildDate (#384)', () => {
  it('is the UTC calendar day of the ISO build time', () => {
    expect(buildDate('2026-08-22T23:59:30.000Z')).toBe('2026-08-22')
    expect(buildDate('2026-08-22T03:04:05.678Z')).toBe('2026-08-22')
  })
  it('is empty when the time is missing or unparseable', () => {
    expect(buildDate(undefined)).toBe('')
    expect(buildDate('')).toBe('')
    expect(buildDate('yesterday')).toBe('')
  })
})

describe('formatBuildIdentity (#384)', () => {
  it('renders the owner-requested shape for a numbered beta', () => {
    expect(formatBuildIdentity({ version: '2.1.0-beta.17', sha: '3a1b2e2', buildTime: '2026-08-22T14:03:00Z' }))
      .toBe('v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22')
  })
  it('names a stable build stable', () => {
    expect(formatBuildIdentity({ version: '2.1.0', sha: '0123abc', buildTime: '2026-09-01T00:00:00Z' }))
      .toBe('v2.1.0 · stable · build 0123abc · 2026-09-01')
  })
  it('an rc is shown as beta channel with its suffix intact', () => {
    expect(formatBuildIdentity({ version: '2.2.0-rc.1', sha: 'abcdef0123', buildTime: '2026-09-01T00:00:00Z' }))
      .toBe('v2.2.0-rc.1 · beta · build abcdef0 · 2026-09-01')
  })
  it('does not double the v prefix', () => {
    expect(formatBuildIdentity({ version: 'v2.1.0', sha: '0123abc', buildTime: '2026-09-01T00:00:00Z' }))
      .toMatch(/^v2\.1\.0 /)
  })
  it('a dev build (no git, no build time) says so and drops the date segment', () => {
    expect(formatBuildIdentity({ version: '2.1.0-beta.17' }))
      .toBe('v2.1.0-beta.17 · beta · build dev')
  })
})
