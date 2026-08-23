import { describe, it, expect, vi } from 'vitest'

// scripts/build-identity.mjs is what electron.vite.config.ts calls at build
// time to bake __BUILD_SHA__ / __BUILD_TIME__ (#384). Pure given env + exec,
// so every branch is driven here without touching git.
const mod = await import('../../../scripts/build-identity.mjs') as {
  resolveBuildSha: (opts?: { env?: Record<string, string | undefined>; exec?: (...a: unknown[]) => string; cwd?: string }) => string
  resolveBuildTime: (now?: Date) => string
  DEV_BUILD_SHA: string
}

describe('resolveBuildSha (#384)', () => {
  it('prefers GITHUB_SHA (the commit the release workflow tags) and shortens it', () => {
    const exec = vi.fn(() => 'ffffffffffffffffffffffffffffffffffffffff\n')
    expect(mod.resolveBuildSha({ env: { GITHUB_SHA: '3A1B2E2C4D5E6F708192A3B4C5D6E7F8091A2B3C' }, exec })).toBe('3a1b2e2')
    expect(exec).not.toHaveBeenCalled()
  })

  it('falls back to `git rev-parse HEAD` in the given cwd', () => {
    const exec = vi.fn((file: unknown, args: unknown, options: unknown) => {
      expect(file).toBe('git')
      expect(args).toEqual(['rev-parse', 'HEAD'])
      expect((options as { cwd: string }).cwd).toBe('/repo')
      return 'abcdef0123456789abcdef0123456789abcdef01\n'
    })
    expect(mod.resolveBuildSha({ env: {}, exec, cwd: '/repo' })).toBe('abcdef0')
  })

  it('ignores a malformed GITHUB_SHA and still asks git', () => {
    const exec = vi.fn(() => 'abcdef0123456789abcdef0123456789abcdef01')
    expect(mod.resolveBuildSha({ env: { GITHUB_SHA: 'not-a-sha' }, exec })).toBe('abcdef0')
  })

  it('is "dev" when git throws (no checkout / git missing)', () => {
    const exec = vi.fn(() => { throw new Error('fatal: not a git repository') })
    expect(mod.resolveBuildSha({ env: {}, exec })).toBe(mod.DEV_BUILD_SHA)
    expect(mod.DEV_BUILD_SHA).toBe('dev')
  })

  it('is "dev" when git prints something that is not a sha', () => {
    const exec = vi.fn(() => 'HEAD\n')
    expect(mod.resolveBuildSha({ env: {}, exec })).toBe('dev')
  })

  it('resolves the real sha of this checkout (smoke: we are in git here)', () => {
    const sha = mod.resolveBuildSha({ env: {} })
    expect(sha).toMatch(/^[0-9a-f]{7}$/)
  })
})

describe('resolveBuildTime (#384)', () => {
  it('is ISO 8601 UTC for the given instant', () => {
    expect(mod.resolveBuildTime(new Date(Date.UTC(2026, 7, 22, 14, 3, 0)))).toBe('2026-08-22T14:03:00.000Z')
  })
})
