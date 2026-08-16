// tests/unit/background-context.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteSessionStart,
  noteSubagentStart,
  noteSubagentStop,
  noteBackgroundToolStart,
  noteBackgroundToolStop,
  noteTurnEnd,
  forgetSession,
  isBackgroundContext,
  _resetBackgroundContextForTest,
} from '../../src/main/background-context'

const MAIN = '/home/u/.claude/projects/proj/main-abc.jsonl'
const SIDE = '/home/u/.claude/projects/proj/sub-def.jsonl'

beforeEach(() => _resetBackgroundContextForTest())

describe('background-context — subagent depth', () => {
  it('a fresh session is not a background context', () => {
    expect(isBackgroundContext('s1')).toBe(false)
  })

  it('SubagentStart marks background until the matching SubagentStop', () => {
    noteSubagentStart('s1')
    expect(isBackgroundContext('s1')).toBe(true)
    noteSubagentStop('s1')
    expect(isBackgroundContext('s1')).toBe(false)
  })

  it('handles nested / parallel agents via a depth counter', () => {
    noteSubagentStart('s1')
    noteSubagentStart('s1')
    noteSubagentStop('s1')
    expect(isBackgroundContext('s1')).toBe(true) // one still open
    noteSubagentStop('s1')
    expect(isBackgroundContext('s1')).toBe(false)
  })

  it('never goes negative on an unmatched SubagentStop', () => {
    noteSubagentStop('s1')
    expect(isBackgroundContext('s1')).toBe(false)
    noteSubagentStart('s1')
    expect(isBackgroundContext('s1')).toBe(true)
  })

  it('turn end clears a dangling subagent depth (missed SubagentStop)', () => {
    noteSubagentStart('s1')
    noteTurnEnd('s1')
    expect(isBackgroundContext('s1')).toBe(false)
  })
})

describe('background-context — spawn-tool bracket (Task/Agent/Workflow)', () => {
  it('an open spawn-tool bracket marks background until the matching close', () => {
    noteBackgroundToolStart('s1')
    expect(isBackgroundContext('s1')).toBe(true)
    noteBackgroundToolStop('s1')
    expect(isBackgroundContext('s1')).toBe(false)
  })

  it('handles nested / parallel spawns via a depth counter', () => {
    noteBackgroundToolStart('s1')
    noteBackgroundToolStart('s1')
    noteBackgroundToolStop('s1')
    expect(isBackgroundContext('s1')).toBe(true) // one still open
    noteBackgroundToolStop('s1')
    expect(isBackgroundContext('s1')).toBe(false)
  })

  it('never goes negative on an unmatched close', () => {
    noteBackgroundToolStop('s1')
    expect(isBackgroundContext('s1')).toBe(false)
    noteBackgroundToolStart('s1')
    expect(isBackgroundContext('s1')).toBe(true)
  })

  it('turn end clears a dangling tool bracket (missed PostToolUse)', () => {
    noteBackgroundToolStart('s1')
    noteTurnEnd('s1')
    expect(isBackgroundContext('s1')).toBe(false)
  })

  it('SessionStart clears a stale tool bracket', () => {
    noteBackgroundToolStart('s1')
    noteSessionStart('s1', MAIN)
    expect(isBackgroundContext('s1', MAIN)).toBe(false)
  })

  it('is independent of subagent depth — both must close to leave background', () => {
    noteBackgroundToolStart('s1')
    noteSubagentStart('s1')
    noteBackgroundToolStop('s1')
    expect(isBackgroundContext('s1')).toBe(true) // subagent depth still open
    noteSubagentStop('s1')
    expect(isBackgroundContext('s1')).toBe(false)
  })

  it('forgetSession drops a tool bracket too', () => {
    noteBackgroundToolStart('s1')
    forgetSession('s1')
    expect(isBackgroundContext('s1')).toBe(false)
  })
})

describe('background-context — transcript anchor (catches dynamic-workflow agents)', () => {
  it('a tick on the anchored main transcript is NOT background', () => {
    noteSessionStart('s1', MAIN)
    expect(isBackgroundContext('s1', MAIN)).toBe(false)
  })

  it('a tick on a different (sidechain) transcript IS background', () => {
    noteSessionStart('s1', MAIN)
    expect(isBackgroundContext('s1', SIDE)).toBe(true)
  })

  it('without an anchor, a lone transcript path is not enough to mark background (fail-open)', () => {
    expect(isBackgroundContext('s1', SIDE)).toBe(false)
  })

  it('SessionStart re-anchors on /clear or compaction', () => {
    noteSessionStart('s1', MAIN)
    const MAIN2 = '/home/u/.claude/projects/proj/main-xyz.jsonl'
    noteSessionStart('s1', MAIN2)
    expect(isBackgroundContext('s1', MAIN2)).toBe(false)
    expect(isBackgroundContext('s1', MAIN)).toBe(true) // old transcript now reads as a sidechain
  })

  it('SessionStart also clears stale depth', () => {
    noteSubagentStart('s1')
    noteSessionStart('s1', MAIN)
    expect(isBackgroundContext('s1', MAIN)).toBe(false)
  })
})

describe('background-context — teardown', () => {
  it('forgetSession drops depth and transcript anchor', () => {
    noteSessionStart('s1', MAIN)
    noteSubagentStart('s1')
    forgetSession('s1')
    expect(isBackgroundContext('s1', SIDE)).toBe(false) // anchor gone -> transcript mismatch no longer fires
    expect(isBackgroundContext('s1')).toBe(false)
  })

  it('state is per-session', () => {
    noteSubagentStart('s1')
    expect(isBackgroundContext('s2')).toBe(false)
  })
})
