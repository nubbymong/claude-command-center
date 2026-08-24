import { describe, it, expect } from 'vitest'

// roll-issues-into-release.mjs guards main() behind an argv[1] check, so
// importing it here pulls in the pure plan/label logic without touching GitHub.
import {
  classifyIssue,
  planRoll,
  rolledLabels,
  rollCommentBody,
  parseArgv,
  labelNames,
} from '../../../scripts/roll-issues-into-release.mjs'

const issue = (over: Record<string, unknown> = {}) => ({
  number: 431,
  title: 'Some shipped fix',
  state: 'open',
  labels: [{ name: 'bug' }, { name: 'in-beta' }],
  ...over,
})

// ── classifyIssue — the fail-safe ──────────────────────────────────
describe('classifyIssue', () => {
  it('rolls an open in-beta issue', () => {
    expect(classifyIssue(issue())).toEqual({ action: 'roll' })
  })

  it('skips an issue already in-release — re-runs and rolling re-releases are no-ops', () => {
    expect(classifyIssue(issue({ labels: [{ name: 'in-release' }] }))).toEqual({
      action: 'skip',
      reason: 'already labeled in-release',
    })
    // Even if in-beta is (wrongly) still present alongside it, never double-roll.
    expect(classifyIssue(issue({ labels: ['in-beta', 'in-release'] }))).toEqual({
      action: 'skip',
      reason: 'already labeled in-release',
    })
  })

  it('NEVER touches a pull request', () => {
    expect(classifyIssue(issue({ pull_request: { url: 'x' } }))).toEqual({ action: 'skip', reason: 'is a pull request' })
  })

  it('skips a non-open issue', () => {
    expect(classifyIssue(issue({ state: 'closed' }))).toEqual({ action: 'skip', reason: 'already closed' })
  })

  it('skips an unlabeled issue, and names owner-exclusion distinctly', () => {
    expect(classifyIssue(issue({ labels: [{ name: 'enhancement' }] }))).toEqual({
      action: 'skip',
      reason: 'not labeled in-beta',
    })
    expect(classifyIssue(issue({ labels: ['excluded'] }))).toEqual({
      action: 'skip',
      reason: 'labeled excluded (owner-excluded)',
    })
  })

  it('excluded WINS over in-beta — same precedence as the gate', () => {
    // An owner-excluded issue that also (wrongly or partially) carries in-beta
    // must never be commented as rolled and auto-closed on promotion.
    expect(classifyIssue(issue({ labels: ['excluded', 'in-beta'] }))).toEqual({
      action: 'skip',
      reason: 'labeled excluded (owner-excluded)',
    })
  })

  it('accepts plain-string labels', () => {
    expect(classifyIssue(issue({ labels: ['in-beta'] }))).toEqual({ action: 'roll' })
  })
})

// ── planRoll ───────────────────────────────────────────────────────
describe('planRoll', () => {
  it('splits a realistic rc milestone into rolls and annotated skips, ascending', () => {
    const { toRoll, skipped } = planRoll([
      issue({ number: 434 }),
      issue({ number: 431 }),
      issue({ number: 435, pull_request: { url: 'x' } }),
      issue({ number: 412, labels: [{ name: 'enhancement' }] }),
      issue({ number: 374, labels: ['excluded'] }),
    ])
    expect(toRoll.map((i) => i.number)).toEqual([431, 434])
    expect(skipped).toEqual([
      { number: 435, reason: 'is a pull request' },
      { number: 412, reason: 'not labeled in-beta' },
      { number: 374, reason: 'labeled excluded (owner-excluded)' },
    ])
  })

  it('rolls nothing when given nothing', () => {
    expect(planRoll([])).toEqual({ toRoll: [], skipped: [] })
    expect(planRoll(undefined as unknown as [])).toEqual({ toRoll: [], skipped: [] })
  })
})

// ── rolledLabels ───────────────────────────────────────────────────
describe('rolledLabels', () => {
  it('swaps in-beta for in-release and preserves every other label', () => {
    expect(rolledLabels([{ name: 'bug' }, { name: 'in-beta' }, { name: 'release-2.1' }])).toEqual([
      'bug',
      'release-2.1',
      'in-release',
    ])
  })

  it('never duplicates in-release when it is somehow already present', () => {
    expect(rolledLabels(['in-beta', 'in-release'])).toEqual(['in-release'])
  })

  it('handles string labels and an empty set', () => {
    expect(rolledLabels(['in-beta'])).toEqual(['in-release'])
    expect(rolledLabels([])).toEqual(['in-release'])
  })
})

// ── rollCommentBody ────────────────────────────────────────────────
describe('rollCommentBody', () => {
  it('names the rc version and both labels', () => {
    const body = rollCommentBody({ version: '2.1.0-rc.1' })
    expect(body).toContain('**v2.1.0-rc.1**')
    expect(body).toContain('`in-beta`')
    expect(body).toContain('`in-release`')
    expect(body).toContain('promotes to stable')
  })
})

// ── parseArgv / labelNames ─────────────────────────────────────────
describe('parseArgv', () => {
  it('reads every flag', () => {
    expect(parseArgv(['--version', '2.1.0-rc.1', '--dry-run', '--repo', 'o/n'])).toEqual({
      dryRun: true,
      version: '2.1.0-rc.1',
      repo: 'o/n',
    })
  })

  it('defaults to a live run', () => {
    expect(parseArgv([])).toEqual({ dryRun: false })
  })
})

describe('labelNames', () => {
  it('reads both REST label shapes and drops junk', () => {
    expect(labelNames([{ name: 'a' }, 'b', null as unknown as string, { name: '' }])).toEqual(['a', 'b'])
  })
})
