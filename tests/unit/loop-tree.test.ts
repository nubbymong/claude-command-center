// Session-integration ("loop") tree — the pure authority guards (#522, ADR-020).
//
// These pin the one new safety property the aggregation layer adds: loop-tree can
// ONLY ever mutate a `loop/*` integration branch, and can never fold a protected
// or nested branch. The git/gh side effects are exercised by hand + the loop
// skill; the guards are what stop an operator error from folding work into beta or
// opening a self-merging PR against it, so they are unit-pinned.
import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs script, no types; we import its pure exports.
import {
  INTEGRATION_PREFIX,
  isProtectedRef,
  isLoopBranch,
  validateSegment,
  integrationBranchName,
  assertLoopBranch,
  assertMergeableTicketBranch,
} from '../../scripts/loop-tree.mjs'

describe('integrationBranchName', () => {
  it('builds loop/<base>/<slug> from valid segments', () => {
    expect(integrationBranchName('beta', 'daily-2026-08-25')).toBe('loop/beta/daily-2026-08-25')
    expect(INTEGRATION_PREFIX).toBe('loop/')
  })

  it('rejects a slug/base with shell- or ref-hostile characters', () => {
    for (const bad of ['../evil', 'a b', 'A', 'a;rm', 'a/b', 'a$b', '', '-lead', 'a'.repeat(65)]) {
      expect(() => integrationBranchName('beta', bad)).toThrow()
      expect(() => integrationBranchName(bad, 'ok')).toThrow()
    }
  })

  it('accepts ordinary dashed segments', () => {
    expect(() => validateSegment('slug', 'fix-209-and-242')).not.toThrow()
    expect(() => validateSegment('base', 'beta')).not.toThrow()
  })
})

describe('isProtectedRef', () => {
  it('flags beta/main/master and every release/* branch', () => {
    for (const p of ['beta', 'main', 'master', 'release/v2.2.0', 'release/anything']) {
      expect(isProtectedRef(p)).toBe(true)
    }
  })
  it('does not flag working or loop branches', () => {
    for (const ok of ['feat/1-x', 'fix/2-y', 'loop/beta/x', 'session/beta/abc']) {
      expect(isProtectedRef(ok)).toBe(false)
    }
  })
  it('treats empty/undefined as protected (fail closed)', () => {
    expect(isProtectedRef('')).toBe(true)
    // @ts-expect-error deliberate
    expect(isProtectedRef(undefined)).toBe(true)
  })
})

describe('isLoopBranch', () => {
  it('recognises a well-formed integration branch', () => {
    expect(isLoopBranch('loop/beta/daily')).toBe(true)
  })
  it('rejects a bare prefix, a wrong prefix, and non-strings', () => {
    for (const bad of ['loop/', 'loop/beta', 'feat/1-x', 'beta', 'session/beta/x', '', null, 42]) {
      // @ts-expect-error deliberate mixed types
      expect(isLoopBranch(bad)).toBe(false)
    }
  })
})

describe('assertLoopBranch (THE authority guard)', () => {
  it('passes for a loop/* branch', () => {
    expect(assertLoopBranch('loop/beta/daily')).toBe('loop/beta/daily')
  })
  it('refuses every protected branch', () => {
    for (const p of ['beta', 'main', 'release/v2.2.0']) {
      expect(() => assertLoopBranch(p)).toThrow(/protected branch/i)
    }
  })
  it('refuses a per-ticket working branch', () => {
    expect(() => assertLoopBranch('feat/522-x')).toThrow(/not a loop\/\* integration branch/i)
    expect(() => assertLoopBranch('session/beta/abc')).toThrow(/not a loop\/\* integration branch/i)
  })
})

describe('assertMergeableTicketBranch', () => {
  const loop = 'loop/beta/daily'
  it('accepts an ordinary ticket branch', () => {
    expect(assertMergeableTicketBranch('feat/209-x', loop)).toBe('feat/209-x')
    expect(assertMergeableTicketBranch('fix/242-y', loop)).toBe('fix/242-y')
  })
  it('refuses a protected branch as the merge source', () => {
    for (const p of ['beta', 'main', 'release/v2.2.0']) {
      expect(() => assertMergeableTicketBranch(p, loop)).toThrow(/protected/i)
    }
  })
  it('refuses a self-merge of the loop branch', () => {
    expect(() => assertMergeableTicketBranch(loop, loop)).toThrow(/itself/i)
  })
  it('refuses nesting one loop branch into another', () => {
    expect(() => assertMergeableTicketBranch('loop/beta/other', loop)).toThrow(/one loop branch .* into another/i)
  })
  it('refuses a qualified or remote-tracking ref (the origin/beta bypass)', () => {
    // Adversarial review: refs/heads/beta slipped past the protected-name check,
    // and origin/beta would merge all of beta into the loop branch.
    for (const q of ['refs/heads/beta', 'refs/heads/loop/beta/other', 'remotes/origin/x']) {
      expect(() => assertMergeableTicketBranch(q, loop)).toThrow(/qualified ref/i)
    }
  })
  it('refuses a name with ref-metacharacters, whitespace, or ..', () => {
    for (const bad of ['a b', 'a..b', 'a~1', 'a^', 'a:b', 'x@{u}', 'a*', 'a\tb']) {
      expect(() => assertMergeableTicketBranch(bad, loop)).toThrow(/ref-metacharacters|whitespace/i)
    }
  })
  it('refuses an empty/missing branch', () => {
    // @ts-expect-error deliberate
    expect(() => assertMergeableTicketBranch(undefined, loop)).toThrow(/no ticket branch/i)
  })
})
