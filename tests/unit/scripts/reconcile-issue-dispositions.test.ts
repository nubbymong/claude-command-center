import { describe, it, expect } from 'vitest'

// The script guards main() behind `require.main === module`, so require()-ing it
// imports only the pure helpers — no gh, no network.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rec = require('../../../scripts/reconcile-issue-dispositions.js') as {
  RELEASE_RE: RegExp
  activeLineFromVersion: (v: string) => string | null
  lineOf: (label: string) => string | null
  validateActiveLine: (line: string | null | undefined) => string | null | undefined
  resolveActiveLine: (input: { cliValue?: string | null; version: string | null }) => string | null
  decide: (input: { labels?: string[]; activeLine?: string | null }) => { add: string[]; flags: string[] }
  parseIssuesJson: (jsonText: string) => Array<{ number: number; title: string; labels: string[] }>
  parseArgv: (argv: string[]) => { dryRun: boolean; issue?: number; repo?: string; activeLine?: string }
  main: (io: {
    argv?: string[]
    env?: Record<string, string | undefined>
    gh?: (args: string[]) => string
    readPackageVersion?: () => string | null
    log?: (line: string) => void
  }) => { repo: string; activeLine: string | null; dryRun: boolean; scanned: number; added: Array<{ number: number; label: string }>; flagged: Array<{ number: number; flag: string }> }
}

const { activeLineFromVersion, validateActiveLine, resolveActiveLine, decide, parseIssuesJson, parseArgv, main } = rec
const ACTIVE = 'release-2.1'
const d = (labels: string[], activeLine: string | null = ACTIVE) => decide({ labels, activeLine })

describe('activeLineFromVersion', () => {
  it('parses major.minor off a prerelease version', () => {
    expect(activeLineFromVersion('2.1.0-beta.17')).toBe('release-2.1')
  })
  it('keeps a multi-digit minor', () => {
    expect(activeLineFromVersion('2.10.0-beta.1')).toBe('release-2.10')
  })
  it('a shipped stable means the NEXT patch on the line (the default branch is what the job checks out)', () => {
    expect(activeLineFromVersion('2.1.0')).toBe('release-2.1.1')
    expect(activeLineFromVersion('2.1.1')).toBe('release-2.1.2')
    expect(activeLineFromVersion('2.10.3')).toBe('release-2.10.4')
  })
  it('a patch prerelease is that patch; an x.y.0 prerelease is the line', () => {
    expect(activeLineFromVersion('2.1.1-rc.1')).toBe('release-2.1.1')
    expect(activeLineFromVersion('2.1.2-beta.3')).toBe('release-2.1.2')
    expect(activeLineFromVersion('2.2.0-beta.1')).toBe('release-2.2')
  })
  it('returns null when unparseable, including a version that is only a prefix of one (fail closed)', () => {
    expect(activeLineFromVersion('')).toBeNull()
    expect(activeLineFromVersion('nope')).toBeNull()
    expect(activeLineFromVersion('2.1')).toBeNull()
    expect(activeLineFromVersion('2.1oops')).toBeNull()
    expect(activeLineFromVersion('2.1.0-rc.1 ')).toBeNull()
    // malformed or foreign prerelease tags: not the repo grammar, so unknown
    expect(activeLineFromVersion('2.1.0-rc..1')).toBeNull()
    expect(activeLineFromVersion('2.1.0--')).toBeNull()
    expect(activeLineFromVersion('2.1.0-rc.')).toBeNull()
    expect(activeLineFromVersion('2.1.0-alpha.1')).toBeNull()
    expect(activeLineFromVersion('2.1.0-beta.1.2')).toBeNull()
  })
})

describe('decide — no-limbo (not committed)', () => {
  it('adds triage to an issue with no disposition at all', () => {
    expect(d([])).toEqual({ add: ['triage'], flags: [] })
    expect(d(['enhancement', 'ux'])).toEqual({ add: ['triage'], flags: [] })
  })
  it('leaves a backlog issue alone', () => {
    expect(d(['backlog', 'enhancement'])).toEqual({ add: [], flags: [] })
  })
  it('leaves a triage issue alone', () => {
    expect(d(['triage'])).toEqual({ add: [], flags: [] })
  })
  it('leaves a wontfix / duplicate / excluded issue alone', () => {
    expect(d(['wontfix'])).toEqual({ add: [], flags: [] })
    expect(d(['duplicate'])).toEqual({ add: [], flags: [] })
    expect(d(['excluded'])).toEqual({ add: [], flags: [] })
  })
  it('leaves a scheduled (release-tagged, not committed) issue alone', () => {
    expect(d(['release-2.1', 'bug'])).toEqual({ add: [], flags: [] })
  })
})

describe('decide — committed-state requires a release line', () => {
  it('auto-adds the active line to an in-beta issue with no release line', () => {
    expect(d(['in-beta', 'bug'])).toEqual({ add: ['release-2.1'], flags: [] })
  })
  it('leaves an in-beta issue that already has a release line', () => {
    expect(d(['in-beta', 'release-2.1'])).toEqual({ add: [], flags: [] })
  })
  it('flags a claimed/in-progress/done issue with no release line — never guesses', () => {
    expect(d(['loop-in-progress'])).toEqual({ add: [], flags: [expect.stringContaining('no release line')] })
    expect(d(['loop-claimed'])).toEqual({ add: [], flags: [expect.stringContaining('no release line')] })
    expect(d(['loop-done'])).toEqual({ add: [], flags: [expect.stringContaining('no release line')] })
  })
  it('leaves a committed issue that already has its release line', () => {
    expect(d(['loop-done', 'release-2.1'])).toEqual({ add: [], flags: [] })
  })
  it('does NOT auto-add a line when active line is unknown — flags instead', () => {
    expect(d(['in-beta'], null)).toEqual({ add: [], flags: [expect.stringContaining('unknown')] })
  })
})

describe('decide — in-release (ADR-019) behaves like in-beta', () => {
  it('is a committed state: auto-adds the active line when no release line', () => {
    expect(d(['in-release', 'bug'])).toEqual({ add: ['release-2.1'], flags: [] })
  })
  it('leaves an in-release issue that already has the active line', () => {
    expect(d(['in-release', 'release-2.1'])).toEqual({ add: [], flags: [] })
  })
  it('flags in-release on a deferred (non-active) line — invariant', () => {
    const r = d(['in-release', 'release-2.2'])
    expect(r.add).toEqual([])
    expect(r.flags[0]).toContain('active line')
  })
  it('flags in-release with a non-release disposition (contradictory)', () => {
    const r = d(['in-release', 'backlog'])
    expect(r.add).toEqual([])
    expect(r.flags[0]).toContain('needs a release line')
  })
  it('does NOT auto-add when active line is unknown — flags instead', () => {
    expect(d(['in-release'], null)).toEqual({ add: [], flags: [expect.stringContaining('unknown')] })
  })
})

describe('decide — conflicts are flagged, never auto-fixed', () => {
  it('flags two release lines and adds nothing', () => {
    const r = d(['release-2.1', 'release-2.2'])
    expect(r.add).toEqual([])
    expect(r.flags[0]).toContain('multiple dispositions')
  })
  it('flags a release line together with backlog/triage/wontfix', () => {
    expect(d(['release-2.1', 'backlog']).flags[0]).toContain('multiple dispositions')
    expect(d(['triage', 'backlog']).flags[0]).toContain('multiple dispositions')
  })
  it('flags an in-beta issue marked backlog and does NOT add a release line', () => {
    const r = d(['in-beta', 'backlog'])
    expect(r.add).toEqual([])
    expect(r.flags[0]).toContain('needs a release line')
  })
})

describe('decide — deferred release lines', () => {
  it('keeps a later-line release-2.2 on a NON-committed issue while active is 2.1', () => {
    expect(d(['release-2.2', 'enhancement'])).toEqual({ add: [], flags: [] })
  })
  it('flags in-beta + a deferred line (invariant: in-beta must be on the active line)', () => {
    const r = d(['in-beta', 'release-2.2'])
    expect(r.add).toEqual([])
    expect(r.flags[0]).toContain('active line')
  })
  it('allows a loop-* committed issue to target a future line (only in-beta is pinned to active)', () => {
    expect(d(['loop-in-progress', 'release-2.2'])).toEqual({ add: [], flags: [] })
  })
})

describe('decide — label matching is case-insensitive', () => {
  it('recognizes mixed-case lifecycle + release labels (no silent miss)', () => {
    // `In-Beta` + `Release-2.1` must be read as committed + on the active line — OK.
    expect(d(['In-Beta', 'Release-2.1'])).toEqual({ add: [], flags: [] })
  })
  it('auto-adds the active line for a mixed-case In-Beta with no release line', () => {
    expect(d(['In-Beta', 'Bug'])).toEqual({ add: ['release-2.1'], flags: [] })
  })
  it('normalizes a mixed-case active-line argument when comparing', () => {
    expect(d(['in-beta', 'release-2.1'], 'Release-2.1')).toEqual({ add: [], flags: [] })
  })
})

describe('validateActiveLine', () => {
  it('accepts a well-formed release line (any case) and null', () => {
    expect(validateActiveLine('release-2.1')).toBe('release-2.1')
    expect(validateActiveLine('Release-2.10')).toBe('Release-2.10')
    expect(validateActiveLine('release-2.1.1')).toBe('release-2.1.1')
    expect(validateActiveLine(null)).toBeNull()
    expect(validateActiveLine(undefined)).toBeUndefined()
  })
  it('throws on a malformed / garbage value so it can never be auto-added', () => {
    expect(() => validateActiveLine('2.1')).toThrow()
    expect(() => validateActiveLine('release-2')).toThrow()
    expect(() => validateActiveLine('rm -rf')).toThrow()
    expect(() => validateActiveLine('release-2.1; drop')).toThrow()
    expect(() => validateActiveLine('release-2.1.1.1')).toThrow()
    expect(() => validateActiveLine('release-2.1.0')).toThrow() // x.y.0 is the line label, never a patch label
    expect(() => validateActiveLine('release-2.1.01')).toThrow()
    expect(() => validateActiveLine('release-2.1.1-rc.1')).toThrow()
  })
})

describe('parseIssuesJson', () => {
  it('parses a title containing "] [" without corrupting the JSON', () => {
    const json = JSON.stringify([
      { number: 5, title: 'weird ] [ title', labels: [{ name: 'triage' }] },
      { number: 6, title: 'normal', labels: [] },
    ])
    const out = parseIssuesJson(json)
    expect(out).toEqual([
      { number: 5, title: 'weird ] [ title', labels: ['triage'] },
      { number: 6, title: 'normal', labels: [] },
    ])
  })
})

describe('parseArgv', () => {
  it('reads flags', () => {
    expect(parseArgv(['--dry-run', '--issue', '123', '--repo', 'o/n', '--active-line', 'release-2.1']))
      .toEqual({ dryRun: true, issue: 123, repo: 'o/n', activeLine: 'release-2.1' })
  })
})

describe('decide — patch-release labels (release-x.y.z) on a shipped line', () => {
  // Once 2.1.0 is live, patch work carries release-2.1.1 (CONTRIBUTING.md); the
  // active label the job derives from a shipped 2.1.0 is exactly that.
  const PATCH = 'release-2.1.1'
  it('a patch label is a release disposition: no triage, nothing added', () => {
    expect(d(['release-2.1.1'], PATCH)).toEqual({ add: [], flags: [] })
    expect(d(['in-beta', 'release-2.1.1'], PATCH)).toEqual({ add: [], flags: [] })
  })
  it('auto-adds the PATCH label to an in-beta issue with no release line', () => {
    expect(d(['in-beta'], PATCH)).toEqual({ add: ['release-2.1.1'], flags: [] })
    expect(d(['in-release'], PATCH)).toEqual({ add: ['release-2.1.1'], flags: [] })
  })
  it('the line label and its patch label are the same line: no contradiction either way', () => {
    expect(d(['in-beta', 'release-2.1'], PATCH)).toEqual({ add: [], flags: [] })
    expect(d(['in-beta', 'release-2.1.1'], 'release-2.1')).toEqual({ add: [], flags: [] })
  })
  it('a different line is still contradictory for in-beta, patch or not', () => {
    const r = d(['in-beta', 'release-2.2'], PATCH)
    expect(r.add).toEqual([])
    expect(r.flags[0]).toMatch(/release-2\.2.*not the active line release-2\.1/)
  })
  it('a line label together with a patch label is two dispositions', () => {
    expect(d(['release-2.1', 'release-2.1.1'], PATCH).flags[0]).toMatch(/multiple dispositions/)
  })
  it('release-x.y.0 is not a disposition at all (the line label is what x.y.0 means)', () => {
    expect(d(['release-2.1.0'], PATCH)).toEqual({ add: ['triage'], flags: [] })
    expect(d(['in-beta', 'release-2.1.0'], PATCH)).toEqual({ add: ['release-2.1.1'], flags: [] })
  })
  it('lineOf strips the patch and nothing else', () => {
    expect(rec.lineOf('release-2.1.1')).toBe('release-2.1')
    expect(rec.lineOf('Release-2.10')).toBe('release-2.10')
    expect(rec.lineOf('backlog')).toBeNull()
  })
})

describe('numbers are canonical: no leading zero anywhere (final adversarial pass, 2.1.1)', () => {
  // `release-02.1` is not the 2.1 line spelled differently; lineOf() used to fold
  // it into the real one, so an in-beta issue carrying it read as "on the active
  // line" and a version `02.1.1` would have minted `release-02.1`.
  it('RELEASE_RE rejects a leading zero in major, minor or patch', () => {
    for (const bad of ['release-02.1', 'release-2.01', 'release-2.1.01', 'release-02.1.1', 'release-00.1']) {
      expect(rec.RELEASE_RE.test(bad), bad).toBe(false)
      expect(() => validateActiveLine(bad), bad).toThrow()
    }
    for (const ok of ['release-0.1', 'release-2.0', 'release-10.20', 'release-2.1.10']) {
      expect(rec.RELEASE_RE.test(ok), ok).toBe(true)
    }
  })
  it('lineOf returns null for a non-canonical label instead of folding it into a real line', () => {
    expect(rec.lineOf('release-02.1')).toBeNull()
    expect(rec.lineOf('release-2.01.1')).toBeNull()
    expect(rec.lineOf('release-2.1x')).toBeNull()
    expect(rec.lineOf('release-0.1')).toBe('release-0.1')
  })
  it('decide does not treat release-02.1 as the active 2.1 line', () => {
    const r = decide({ labels: ['in-beta', 'release-02.1'], activeLine: 'release-2.1' })
    // the odd label is not a release disposition: the issue has no line, so the active one is added
    expect(r).toEqual({ add: ['release-2.1'], flags: [] })
  })
  it('activeLineFromVersion refuses a version with a leading zero', () => {
    expect(activeLineFromVersion('02.1.1')).toBeNull()
    expect(activeLineFromVersion('2.01.0-beta.1')).toBeNull()
    expect(activeLineFromVersion('2.1.01')).toBeNull()
    expect(activeLineFromVersion('0.1.0-beta.1')).toBe('release-0.1') // a bare 0 is canonical
  })
})

describe('resolveActiveLine -- the label main() auto-adds is validated whichever way it was produced', () => {
  it('a CLI override wins and must be well-formed', () => {
    expect(resolveActiveLine({ cliValue: 'release-2.2', version: '2.1.1-beta.1' })).toBe('release-2.2')
    expect(() => resolveActiveLine({ cliValue: 'release-02.2', version: '2.1.1-beta.1' })).toThrow(/active-line/)
  })
  it('otherwise derives from the version, and an unknown version is null (flag, never label)', () => {
    expect(resolveActiveLine({ version: '2.1.1-beta.1' })).toBe('release-2.1.1')
    expect(resolveActiveLine({ version: '2.1.0' })).toBe('release-2.1.1')
    expect(resolveActiveLine({ version: '2.2.0-beta.1' })).toBe('release-2.2')
    expect(resolveActiveLine({ version: null })).toBeNull()
    expect(resolveActiveLine({ version: 'garbage' })).toBeNull()
    expect(resolveActiveLine({ version: '02.1.1' })).toBeNull()
  })
})

// ── main() end to end, at the gh-argv layer ─────────────────────────
// The claim "never removes a label, never closes anything" is a claim about the
// argv handed to `gh`. Until now no test looked: a mutant that appended
// `--remove-label backlog` and `issue close` stayed green (final adversarial
// pass, 2.1.1). Every `gh` call of a run is recorded and the whole set asserted.
type Issue = { number: number; title: string; labels: Array<{ name: string }>; pull_request?: object }
function fakeGh(issues: Issue[]) {
  const calls: string[][] = []
  const gh = (args: string[]): string => {
    calls.push([...args])
    const [verb, sub] = args
    if (verb === 'issue' && sub === 'list') return JSON.stringify(issues.filter((i) => !i.pull_request))
    if (verb === 'issue' && sub === 'edit') return ''
    if (verb === 'api') {
      const m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(args[1] ?? '')
      const it = m && issues.find((i) => i.number === Number(m[1]))
      if (!it) throw new Error(`fake gh: unexpected api path ${args[1]}`)
      return JSON.stringify(it)
    }
    if (verb === 'repo' && sub === 'view') return 'fallback/repo'
    throw new Error(`fake gh: unexpected call ${args.join(' ')}`)
  }
  return { gh, calls }
}
const FIXTURE: Issue[] = [
  { number: 1, title: 'limbo', labels: [{ name: 'bug' }] },
  { number: 2, title: 'shipped, no line', labels: [{ name: 'in-beta' }] },
  { number: 3, title: 'conflict', labels: [{ name: 'release-2.1' }, { name: 'backlog' }] },
  { number: 4, title: 'fine', labels: [{ name: 'triage' }] },
  { number: 5, title: 'a PR, never an issue', labels: [{ name: 'bug' }], pull_request: {} },
]
const baseIo = (gh: (a: string[]) => string, extra: Partial<Parameters<typeof main>[0]> = {}) => ({
  argv: ['--repo', 'o/n'],
  env: {},
  gh,
  readPackageVersion: () => '2.1.1-beta.1',
  log: () => {},
  ...extra,
})
const isRead = (c: string[]) => (c[0] === 'issue' && c[1] === 'list') || c[0] === 'api' || (c[0] === 'repo' && c[1] === 'view')
const isAddLabel = (c: string[]) => c[0] === 'issue' && c[1] === 'edit' && c.includes('--add-label') && c.length === 7

describe('main() -- the whole run against a recording gh', () => {
  it('a full scan issues exactly one list read and one --add-label per decision, nothing else', () => {
    const { gh, calls } = fakeGh(FIXTURE)
    const out = main(baseIo(gh))
    expect(out.repo).toBe('o/n')
    expect(out.activeLine).toBe('release-2.1.1')
    expect(out.scanned).toBe(4)
    expect(calls[0]).toEqual(['issue', 'list', '--repo', 'o/n', '--state', 'open', '--limit', '2000', '--json', 'number,title,labels'])
    expect(calls.slice(1)).toEqual([
      ['issue', 'edit', '1', '--repo', 'o/n', '--add-label', 'triage'],
      ['issue', 'edit', '2', '--repo', 'o/n', '--add-label', 'release-2.1.1'],
    ])
    expect(out.added).toEqual([
      { number: 1, label: 'triage', title: 'limbo' },
      { number: 2, label: 'release-2.1.1', title: 'shipped, no line' },
    ])
    expect(out.flagged.map((f) => f.number)).toEqual([3])
  })

  it('NEVER removes a label, closes, comments, or calls anything but list/edit --add-label', () => {
    const { gh, calls } = fakeGh(FIXTURE)
    main(baseIo(gh))
    for (const c of calls) {
      expect(isRead(c) || isAddLabel(c), c.join(' ')).toBe(true)
      expect(c.join(' ')).not.toMatch(/--remove-label|close|reopen|comment|delete|-X |--method|transfer|lock/)
    }
  })

  it('--dry-run reads and reports but issues no edit at all', () => {
    const { gh, calls } = fakeGh(FIXTURE)
    const out = main(baseIo(gh, { argv: ['--repo', 'o/n', '--dry-run'] }))
    expect(out.dryRun).toBe(true)
    expect(out.added.map((a) => a.number)).toEqual([1, 2])
    expect(calls.filter((c) => !isRead(c))).toEqual([])
  })

  it('DRY_RUN=1 in the environment is the same switch', () => {
    const { gh, calls } = fakeGh(FIXTURE)
    main(baseIo(gh, { env: { DRY_RUN: '1' } }))
    expect(calls.filter((c) => !isRead(c))).toEqual([])
  })

  it('--issue N reads that one issue through the API and labels only it', () => {
    const { gh, calls } = fakeGh(FIXTURE)
    const out = main(baseIo(gh, { argv: ['--repo', 'o/n', '--issue', '1'] }))
    expect(out.scanned).toBe(1)
    expect(calls).toEqual([
      ['api', 'repos/o/n/issues/1'],
      ['issue', 'edit', '1', '--repo', 'o/n', '--add-label', 'triage'],
    ])
  })

  it('--issue N on a pull request does nothing (a PR is never an issue disposition)', () => {
    const { gh, calls } = fakeGh(FIXTURE)
    const out = main(baseIo(gh, { argv: ['--repo', 'o/n', '--issue', '5'] }))
    expect(out.scanned).toBe(0)
    expect(calls).toEqual([['api', 'repos/o/n/issues/5']])
  })

  it('the repo comes from --repo, else GITHUB_REPOSITORY, else gh repo view -- in that order', () => {
    const a = fakeGh([])
    main(baseIo(a.gh, { argv: [], env: { GITHUB_REPOSITORY: 'env/repo' } }))
    expect(a.calls[0]).toEqual(['issue', 'list', '--repo', 'env/repo', '--state', 'open', '--limit', '2000', '--json', 'number,title,labels'])
    const b = fakeGh([])
    main(baseIo(b.gh, { argv: [] }))
    expect(b.calls[0]).toEqual(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    expect(b.calls[1][3]).toBe('fallback/repo')
  })

  it('an unparseable package version flags the in-beta issue instead of labelling it', () => {
    const { gh, calls } = fakeGh(FIXTURE)
    const out = main(baseIo(gh, { readPackageVersion: () => 'not-a-version' }))
    expect(out.activeLine).toBeNull()
    expect(calls.filter(isAddLabel)).toEqual([['issue', 'edit', '1', '--repo', 'o/n', '--add-label', 'triage']])
    expect(out.flagged.find((f) => f.number === 2)?.flag).toMatch(/unknown/)
  })

  it('a malformed --active-line throws before any gh call is made', () => {
    const { gh, calls } = fakeGh(FIXTURE)
    expect(() => main(baseIo(gh, { argv: ['--repo', 'o/n', '--active-line', 'release-2'] }))).toThrow(/active-line/)
    expect(calls).toEqual([])
  })
})
