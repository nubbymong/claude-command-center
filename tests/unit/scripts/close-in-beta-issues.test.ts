import { describe, it, expect } from 'vitest'

// close-in-beta-issues.js guards main() behind `require.main === module`, so
// require()-ing it here imports only the pure helpers — no git, no gh, no network.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const closer = require('../../../scripts/close-in-beta-issues.js') as {
  LIFECYCLE_LABELS: string[]
  extractRefs: (text: string) => number[]
  refsFromCommitLog: (log: string) => number[]
  classifyCandidate: (item: unknown) => { action: string; reason?: string; label?: string; carried?: string[] }
  planClosures: (items: unknown[]) => {
    toClose: Array<{ number: number; closeLabel: string; closeCarried: string[] }>
    skipped: Array<{ number: number; reason: string }>
  }
  selectCandidates: (
    refs: number[],
    labeled: Map<number, unknown>,
  ) => { matched: Array<{ number: number }>; unmatched: number[] }
  expandViaPrBodies: (opts: {
    direct: number[]
    labeled: Map<number, unknown>
    unmatched: number[]
    fetchItem: (n: number) => unknown
    max?: number
    log?: (line: string) => void
  }) => { found: Array<{ number: number }>; stillMissing: number[]; lookups: number }
  fetchLifecycleIssues: (
    repo: string,
    runGh: (args: string[]) => string,
    maxPages?: number,
  ) => Map<number, { number: number }>
  resolveRange: (opts: {
    explicit?: string
    before?: string
    after?: string
    isKnownCommit: (sha: string) => boolean
    previousTag?: string | null
  }) => string | null
  closeCommentBody: (opts: { version?: string | null; sha?: string; range?: string; label?: string }) => string
  parseArgv: (argv: string[]) => { dryRun: boolean; range?: string; version?: string; repo?: string }
}

const {
  extractRefs,
  refsFromCommitLog,
  classifyCandidate,
  planClosures,
  selectCandidates,
  expandViaPrBodies,
  fetchLifecycleIssues,
  resolveRange,
  closeCommentBody,
  parseArgv,
} = closer

const issue = (over: Record<string, unknown> = {}) => ({
  number: 74,
  title: 'Per-config Claude launch parameters',
  state: 'open',
  labels: [{ name: 'enhancement' }, { name: 'in-beta' }],
  ...over,
})

// ── extractRefs ────────────────────────────────────────────────────
describe('extractRefs', () => {
  it('pulls every #ref, deduped and ascending', () => {
    expect(extractRefs('fixes #12, also #7 and #12 again')).toEqual([7, 12])
  })

  it('finds the squash-merge trailer and an inline issue ref together', () => {
    // Real subject from beta: the issue AND the PR are both in one line.
    expect(extractRefs('fix(hooks): merge inherited hooks (#137) (#138)')).toEqual([137, 138])
  })

  it('ignores a six-plus digit run so hex/colour literals cannot become refs', () => {
    expect(extractRefs('color: #fbca04')).toEqual([])
    expect(extractRefs('#1234567')).toEqual([])
  })

  it('does NOT read a cross-repo owner/repo#N ref as a local issue', () => {
    // Would otherwise close local #5 because someone cited another repo.
    expect(extractRefs('see nubbymong/other#5 for context')).toEqual([])
    expect(extractRefs('microsoft/vscode#12345')).toEqual([])
  })

  it('still matches a bare ref in prose about another project', () => {
    // Real cases from this repo's history: xterm.js #1194 / #891, electron-builder
    // #2964. Nothing in the text marks these as foreign, so they ARE harvested —
    // they just never resolve locally, and the label filter is the real guard.
    expect(extractRefs('xterm.js #1194 "initial cursorBlink has no effect"')).toEqual([1194])
  })

  it('returns empty for blank input', () => {
    expect(extractRefs('')).toEqual([])
    expect(extractRefs(undefined as unknown as string)).toEqual([])
  })
})

// ── refsFromCommitLog ──────────────────────────────────────────────
describe('refsFromCommitLog', () => {
  it('harvests refs across subjects and bodies', () => {
    const log = [
      'feat(config): per-config Claude permission mode + extra CLI args (#92)',
      'Closes #74.',
      '',
      'docs(process): codify the in-beta issue lifecycle (#135)',
    ].join('\n')
    expect(refsFromCommitLog(log)).toEqual([74, 92, 135])
  })

  it('drops co-author and sign-off trailers', () => {
    const log = ['fix: whatever (#10)', 'Co-authored-by: someone <a@b.c>', 'Signed-off-by: other <d@e.f>'].join('\n')
    expect(refsFromCommitLog(log)).toEqual([10])
  })

  it('returns empty for a range with no refs (e.g. a lone version bump)', () => {
    expect(refsFromCommitLog('build(release): 2.1.0')).toEqual([])
  })
})

// ── classifyCandidate — the fail-safe ──────────────────────────────
describe('classifyCandidate', () => {
  it('closes an open issue carrying in-beta', () => {
    expect(classifyCandidate(issue())).toEqual({ action: 'close', label: 'in-beta', carried: ['in-beta'] })
  })

  it('closes an open issue carrying in-release (rolled into an rc before promotion)', () => {
    const verdict = classifyCandidate(issue({ labels: [{ name: 'in-release' }, { name: 'bug' }] }))
    expect(verdict).toEqual({ action: 'close', label: 'in-release', carried: ['in-release'] })
  })

  it('an issue somehow carrying BOTH lifecycle labels closes as in-release and sheds both', () => {
    // The roll script swaps rather than stacks, so both-at-once is a labeling
    // accident — the close must still describe the furthest state and leave no
    // lifecycle label behind.
    const verdict = classifyCandidate(issue({ labels: ['in-beta', 'in-release'] }))
    expect(verdict).toEqual({ action: 'close', label: 'in-release', carried: ['in-beta', 'in-release'] })
  })

  it('NEVER touches a pull request, even a labeled one', () => {
    // Squash subjects reference PRs far more often than issues, so this is the
    // single most-exercised guard in the script.
    const verdict = classifyCandidate(issue({ number: 92, pull_request: { url: 'x' }, labels: [{ name: 'in-beta' }] }))
    expect(verdict).toEqual({ action: 'skip', reason: 'is a pull request' })
  })

  it('NEVER closes an issue that lacks a lifecycle label', () => {
    // The whole guard against over-eager ref matching: #134 and #116 get
    // referenced by promoted PR bodies but are not shipped by them.
    expect(classifyCandidate(issue({ number: 134, labels: [{ name: 'enhancement' }] }))).toEqual({
      action: 'skip',
      reason: 'not labeled in-beta or in-release',
    })
    expect(classifyCandidate(issue({ labels: [] }))).toEqual({ action: 'skip', reason: 'not labeled in-beta or in-release' })
  })

  it('skips an already-closed issue instead of re-closing it', () => {
    expect(classifyCandidate(issue({ state: 'closed' }))).toEqual({ action: 'skip', reason: 'already closed' })
  })

  it('skips a ref that does not resolve', () => {
    expect(classifyCandidate(null)).toEqual({ action: 'skip', reason: 'not found' })
    // main() substitutes this marker so an unresolvable ref is still REPORTED
    // rather than dropped from the run log.
    expect(classifyCandidate({ number: 1194, notFound: true })).toEqual({ action: 'skip', reason: 'not found' })
  })

  it('accepts plain-string labels as well as label objects', () => {
    expect(classifyCandidate(issue({ labels: ['in-beta'] }))).toEqual({ action: 'close', label: 'in-beta', carried: ['in-beta'] })
  })
})

// ── planClosures ───────────────────────────────────────────────────
describe('planClosures', () => {
  it('splits a realistic promotion into closes and annotated skips', () => {
    const { toClose, skipped } = planClosures([
      issue({ number: 74 }),
      issue({ number: 75, labels: [{ name: 'in-release' }] }),
      issue({ number: 92, pull_request: { url: 'x' } }),
      issue({ number: 134, labels: [{ name: 'enhancement' }] }),
      issue({ number: 130, state: 'closed' }),
    ])
    expect(toClose.map((i) => i.number)).toEqual([74, 75])
    // The close loop reads these off the plan: which label to describe in the
    // comment, and which to remove.
    expect(toClose.map((i) => i.closeLabel)).toEqual(['in-beta', 'in-release'])
    expect(toClose.map((i) => i.closeCarried)).toEqual([['in-beta'], ['in-release']])
    expect(skipped).toEqual([
      { number: 92, reason: 'is a pull request' },
      { number: 134, reason: 'not labeled in-beta or in-release' },
      { number: 130, reason: 'already closed' },
    ])
  })

  it('closes nothing when given nothing', () => {
    expect(planClosures([])).toEqual({ toClose: [], skipped: [] })
  })
})

// ── selectCandidates — the fix for the 475-ref promotion ───────────
describe('selectCandidates', () => {
  const labeledMap = (...items: Array<Record<string, unknown>>) => new Map(items.map((i) => [i.number as number, i]))

  it('keeps only the refs that are open and lifecycle-labeled', () => {
    const labeled = labeledMap(issue({ number: 74 }), issue({ number: 75 }))
    // 92 is a PR, 1194 is another project's issue — neither is in the label set,
    // and neither costs an API call to reject any more.
    const { matched, unmatched } = selectCandidates([74, 92, 75, 1194], labeled)
    expect(matched.map((i) => i.number)).toEqual([74, 75])
    expect(unmatched).toEqual([])
  })

  it('scales to a full release range without a single per-ref lookup', () => {
    // The regression this function exists for: v2.0.0..main for 2.1.0 carried
    // 775 commits / 475 distinct refs against 128 labeled issues. The old walk
    // fetched refs until a 200 ceiling and then returned having closed NOTHING.
    const refs = Array.from({ length: 475 }, (_, i) => i + 1)
    const labeled = labeledMap(...Array.from({ length: 128 }, (_, i) => issue({ number: i + 1 })))
    const { matched, unmatched } = selectCandidates(refs, labeled)
    expect(matched).toHaveLength(128)
    expect(unmatched).toEqual([])
  })

  it('reports a labeled issue no commit cites, so the caller can expand PR bodies', () => {
    const labeled = labeledMap(issue({ number: 74 }), issue({ number: 555 }))
    expect(selectCandidates([74, 92], labeled).unmatched).toEqual([555])
  })

  it('never reports a labeled PULL REQUEST as a shortfall', () => {
    // A labeled PR can never close, so chasing it would buy 200 useless lookups.
    const labeled = labeledMap(issue({ number: 74 }), issue({ number: 600, pull_request: { url: 'x' } }))
    expect(selectCandidates([74], labeled).unmatched).toEqual([])
  })

  it('does not double-count a ref cited twice in the range', () => {
    const labeled = labeledMap(issue({ number: 74 }))
    expect(selectCandidates([74, 74], labeled).matched).toHaveLength(1)
  })

  it('closes nothing when no ref is labeled', () => {
    expect(selectCandidates([1, 2, 3], labeledMap())).toEqual({ matched: [], unmatched: [] })
  })
})

// ── expandViaPrBodies — the only unbounded pass ────────────────────
describe('expandViaPrBodies', () => {
  const pr = (number: number, body: string, over: Record<string, unknown> = {}) => ({
    number,
    title: `fix: something (#${number})`,
    body,
    state: 'open',
    pull_request: { url: 'x' },
    labels: [],
    ...over,
  })

  it('finds a labeled issue through the body of a cited PR', () => {
    const labeled = new Map<number, unknown>([[555, issue({ number: 555 })]])
    const fetched: number[] = []
    const r = expandViaPrBodies({
      direct: [600],
      labeled,
      unmatched: [555],
      fetchItem: (n) => {
        fetched.push(n)
        return pr(600, 'Closes #555.')
      },
    })
    expect(r.found.map((i) => i.number)).toEqual([555])
    expect(r.stillMissing).toEqual([])
    expect(fetched).toEqual([600])
  })

  it('reads a LABELED pull request already in hand, without spending a lookup', () => {
    // Regression: `labeled` holds issues AND pull requests, because REST
    // /issues?labels= returns both. Skipping everything already in `labeled`
    // skipped labeled PRs too — and a labeled PR's body is the entire reason
    // this pass exists, so #555 was reported as "not referenced anywhere in
    // this range" when it plainly was.
    const labeled = new Map<number, unknown>([
      [555, issue({ number: 555 })],
      [600, pr(600, 'Closes #555.', { labels: [{ name: 'in-beta' }] })],
    ])
    const r = expandViaPrBodies({
      direct: [600],
      labeled,
      unmatched: [555],
      fetchItem: () => {
        throw new Error('must not fetch a PR we already hold')
      },
    })
    expect(r.found.map((i) => i.number)).toEqual([555])
    expect(r.lookups).toBe(0)
  })

  it('stops at the ceiling but KEEPS what it already found', () => {
    // The old overflow path returned and discarded the run. Whatever matched
    // before the ceiling must survive it.
    const labeled = new Map<number, unknown>([
      [555, issue({ number: 555 })],
      [556, issue({ number: 556 })],
    ])
    const lines: string[] = []
    const r = expandViaPrBodies({
      direct: [600, 601, 602, 603],
      labeled,
      unmatched: [555, 556],
      max: 2,
      log: (l) => lines.push(l),
      fetchItem: (n) => (n === 600 ? pr(600, 'Closes #555.') : pr(n, 'no refs here')),
    })
    expect(r.found.map((i) => i.number)).toEqual([555])
    expect(r.stillMissing).toEqual([556])
    expect(r.lookups).toBe(2)
    expect(lines.join('\n')).toContain('Stopped after 2 lookups')
  })

  it('stops early the moment the shortfall closes, buying no further lookups', () => {
    const labeled = new Map<number, unknown>([[555, issue({ number: 555 })]])
    const r = expandViaPrBodies({
      direct: [600, 601, 602],
      labeled,
      unmatched: [555],
      fetchItem: (n) => pr(n, n === 600 ? 'Closes #555.' : 'nothing'),
    })
    expect(r.lookups).toBe(1)
  })

  it('never pushes undefined when a PR body cites a ref that is not labeled', () => {
    const labeled = new Map<number, unknown>([[555, issue({ number: 555 })]])
    const r = expandViaPrBodies({
      direct: [600],
      labeled,
      unmatched: [555],
      fetchItem: () => pr(600, 'Closes #555. Also mentions #999 and #1000.'),
    })
    expect(r.found).toHaveLength(1)
    expect(r.found.every(Boolean)).toBe(true)
  })

  it('skips a labeled ISSUE without a lookup, and ignores a ref that is not a PR', () => {
    const labeled = new Map<number, unknown>([
      [74, issue({ number: 74 })],
      [555, issue({ number: 555 })],
    ])
    const r = expandViaPrBodies({
      direct: [74, 900],
      labeled,
      unmatched: [555],
      fetchItem: () => issue({ number: 900, labels: [] }),
    })
    expect(r.lookups).toBe(1)
    expect(r.stillMissing).toEqual([555])
  })
})

// ── fetchLifecycleIssues — paging bounds ───────────────────────────
describe('fetchLifecycleIssues', () => {
  const page = (numbers: number[]) => JSON.stringify(numbers.map((n) => ({ number: n, title: `#${n}`, state: 'open', labels: [] })))

  it('merges both lifecycle labels into one map', () => {
    const gh = (args: string[]) => (args[1].includes('in-beta') ? page([1, 2]) : page([3]))
    expect([...fetchLifecycleIssues('o/n', gh).keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('stops after a short page', () => {
    let calls = 0
    const gh = () => {
      calls++
      return page([1])
    }
    fetchLifecycleIssues('o/n', gh)
    expect(calls).toBe(2) // one short page per label
  })

  it('pages past an exactly-full first page', () => {
    // The real boundary: `in-release` returned exactly 100 on page 1 and 9 on
    // page 2. Breaking on `length < 100` must not stop at the full page.
    const first = Array.from({ length: 100 }, (_, i) => i + 1)
    let call = 0
    const gh = () => {
      call++
      return call % 2 === 1 ? page(first) : page([1000 + call])
    }
    expect(fetchLifecycleIssues('o/n', gh).size).toBe(102)
  })

  it('throws a NAMED error on a non-array body rather than "items is not iterable"', () => {
    expect(() => fetchLifecycleIssues('o/n', () => JSON.stringify({ message: 'Bad credentials' }))).toThrow(/non-array/)
  })

  it('refuses to page forever when the API ignores `page`', () => {
    // Without a ceiling this spins until the Actions job times out.
    const full = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(() => fetchLifecycleIssues('o/n', () => page(full), 3)).toThrow(/refusing to page further/i)
  })
})

// ── resolveRange ───────────────────────────────────────────────────
describe('resolveRange', () => {
  const known = () => true
  const unknown = () => false

  it('prefers an explicit --range over everything', () => {
    expect(resolveRange({ explicit: 'v2.0.0..main', before: 'aaa', after: 'bbb', isKnownCommit: known, previousTag: 'v1.0.0' })).toBe(
      'v2.0.0..main',
    )
  })

  it('uses the push event before..after when the before sha is real', () => {
    expect(resolveRange({ before: 'aaa', after: 'bbb', isKnownCommit: known, previousTag: 'v1.0.0' })).toBe('aaa..bbb')
  })

  it('falls back to the previous tag when before is all-zeros (first push)', () => {
    expect(resolveRange({ before: '0000000000000000000000000000000000000000', after: 'bbb', isKnownCommit: known, previousTag: 'v2.0.0' })).toBe(
      'v2.0.0..bbb',
    )
  })

  it('falls back to the previous tag when before is unreachable (force push)', () => {
    expect(resolveRange({ before: 'aaa', after: 'bbb', isKnownCommit: unknown, previousTag: 'v2.0.0' })).toBe('v2.0.0..bbb')
  })

  it('returns null rather than guessing when there is no before and no tag', () => {
    // Fail-safe: a wrong range could sweep in issues from earlier releases.
    expect(resolveRange({ after: 'bbb', isKnownCommit: known, previousTag: null })).toBeNull()
  })
})

// ── closeCommentBody ───────────────────────────────────────────────
describe('closeCommentBody', () => {
  it('names the version, the short sha, and the range', () => {
    const body = closeCommentBody({ version: '2.1.0', sha: 'abcdef1234567890', range: 'v2.0.0..main' })
    expect(body).toContain('**v2.1.0**')
    expect(body).toContain('abcdef1')
    expect(body).toContain('v2.0.0..main')
    expect(body).toContain('in-beta')
  })

  it('describes the rc journey for an issue that carried in-release', () => {
    const body = closeCommentBody({ version: '2.1.0', sha: 'abcdef1234567890', label: 'in-release' })
    expect(body).toContain('release candidate')
    expect(body).toContain('`in-release`')
    expect(body).not.toContain('`in-beta`')
  })

  it('degrades gracefully with no version', () => {
    const body = closeCommentBody({ version: null, sha: 'abcdef1234567890' })
    expect(body).toContain('a stable release')
    expect(body).not.toContain('undefined')
  })
})

// ── parseArgv ──────────────────────────────────────────────────────
describe('parseArgv', () => {
  it('reads every flag', () => {
    expect(parseArgv(['--range', 'a..b', '--dry-run', '--version', '2.1.0', '--repo', 'o/n'])).toEqual({
      dryRun: true,
      range: 'a..b',
      version: '2.1.0',
      repo: 'o/n',
    })
  })

  it('defaults to a live run with no range', () => {
    expect(parseArgv([])).toEqual({ dryRun: false })
  })
})
