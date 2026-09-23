// WP1.17, WP1.44 -- WP2 slice 3a (plan A8; design 5.6, 8.4): the Codex
// version is proven from `codex --version` and classified against the tested
// range. PURE (the discovery runner itself is a later slice).
import { describe, it, expect } from 'vitest'
import {
  parseCodexVersion, classifyCodexVersion,
  CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION, CODEX_MAX_TESTED_VERSION,
} from '../../src/main/providers/codex'

describe('codex --version', () => {
  it('reads the semver from the CLI banner, and nothing else', () => {
    expect(parseCodexVersion('codex-cli 0.155.1\n')).toBe('0.155.1')
    expect(parseCodexVersion('codex-cli 0.156.0-alpha.3\r\n')).toBe('0.156.0-alpha.3')
    expect(parseCodexVersion('WARNING: something\ncodex-cli 0.155.1\n')).toBe('0.155.1')
    for (const bad of ['', '0.155.1', 'codex 0.155.1', 'codex-cli v0.155.1', 'codex-cli 0.155', 'codex-cli 0.155.1 extra', `codex-cli ${'9'.repeat(5000)}.1.1`, 'codex-cli 0.155.1-..']) {
      expect(parseCodexVersion(bad), bad.slice(0, 30)).toBeNull()
    }
  })

  it('two banners that disagree prove nothing; the same banner twice is fine', () => {
    expect(parseCodexVersion('codex-cli 0.100.0\ncodex-cli 0.155.1\n')).toBeNull()
    expect(parseCodexVersion('codex-cli 0.155.1\ncodex-cli 0.155.1\n')).toBe('0.155.1')
  })

  it('a version the parser cannot prove is unknown -- never quietly supported (the runner blocks it)', () => {
    for (const out of ['codex-cli 0.100.0 (abc123)', 'codex-cli 0.155.1+build', '0.1.2504301751']) {
      expect(classifyCodexVersion(parseCodexVersion(out)), out).toBe('unknown')
    }
  })
})

describe('the tested range', () => {
  it('is ordered: minimum <= pinned <= maximum tested', () => {
    expect(classifyCodexVersion(CODEX_MIN_SUPPORTED_VERSION)).toBe('supported')
    expect(classifyCodexVersion(CODEX_PINNED_CLI_VERSION)).toBe('supported')
    expect(classifyCodexVersion(CODEX_MAX_TESTED_VERSION)).toBe('supported')
  })

  it('older is too-old (blocked), newer is too-new (warned), unparseable is unknown', () => {
    expect(classifyCodexVersion('0.153.3')).toBe('too-old')
    expect(classifyCodexVersion('0.153.4-alpha.1')).toBe('too-old')
    expect(classifyCodexVersion('0.156.2')).toBe('too-new')
    expect(classifyCodexVersion('1.0.0')).toBe('too-new')
    expect(classifyCodexVersion(null)).toBe('unknown')
  })
})
