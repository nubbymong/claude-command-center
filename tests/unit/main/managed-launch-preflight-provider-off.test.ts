/**
 * WP2: the managed-launch preflight while Claude Code is switched off. Its
 * on-demand version probe does not run then (claude-cli-version.ts), so the
 * version is unknown -- and the report must not raise that as the blocking
 * "Claude Code version not yet verified" fault: it says Claude Code is off.
 * (A shell pinned to an account is the one managed launch left while Claude
 * Code is off.)
 *
 * The REAL recorder and the REAL Claude preflight; the version probe is
 * mocked (its own skip is tested in claude-cli-version-provider-off.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { composeProviders } from '../../../src/main/providers/compose'

const v = vi.hoisted(() => ({ allowed: true, version: null as string | null }))
const ensureClaudeCliVersion = vi.fn()
vi.mock('../../../src/main/claude-cli-version', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/claude-cli-version')>()),
  peekClaudeCliVersion: () => v.version,
  ensureClaudeCliVersion: () => ensureClaudeCliVersion(),
  claudeCliProbeAllowed: () => v.allowed,
}))

const { recordManagedLaunchPreflight } = await import('../../../src/main/managed-launch-diagnostics')

beforeAll(() => { composeProviders() })
beforeEach(() => {
  v.allowed = true
  v.version = null
  ensureClaudeCliVersion.mockClear()
})

const record = () => recordManagedLaunchPreflight('s-1', 'p1', 'C:/profiles/p1', {}, null, 'launch')!
const ids = (p: ReturnType<typeof record>) => p.findings.map((f) => f.id)

describe('the preflight of a launch while Claude Code is off', () => {
  it('says Claude Code is off (info), not the blocking "version not yet verified"', () => {
    v.allowed = false
    const p = record()
    expect(ids(p)).not.toContain('cli-version-unverified')
    const off = p.findings.find((f) => f.id === 'cli-version-not-checked-off')!
    expect(off).toMatchObject({ severity: 'info', title: 'Claude Code is off' })
    expect(off.detail).toBe('Its version is not checked while it is off. Turn it on in Settings, Accounts.')
    expect(p.findings.some((f) => f.severity === 'blocked')).toBe(p.ok === false)
  })

  it('with Claude Code on, an unknown version is still the blocking fault (the control)', () => {
    const p = record()
    expect(ids(p)).toContain('cli-version-unverified')
    expect(ids(p)).not.toContain('cli-version-not-checked-off')
    expect(p.ok).toBe(false)
  })

  it('a known version is reported as ever, off or on', () => {
    v.version = '2.1.281'
    v.allowed = false
    expect(ids(record())).not.toContain('cli-version-not-checked-off')
  })
})
