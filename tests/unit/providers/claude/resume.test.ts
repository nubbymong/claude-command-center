import { describe, it, expect, vi } from 'vitest'

// Deterministic fixture home. The old version of this test walked the REAL
// ~/.claude/projects (gigabytes on dev machines — 7s+ standalone, timeout
// flake under full-suite I/O load; vacuously green on empty CI homes).
const fixtureHome = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-resume-home-'))
  const projectDir = nodePath.join(home, '.claude', 'projects', 'F--CLAUDE-MULTI-APP')
  nodeFs.mkdirSync(projectDir, { recursive: true })
  nodeFs.writeFileSync(
    nodePath.join(projectDir, 'fixture-session-1.jsonl'),
    [
      JSON.stringify({ type: 'summary', summary: 'not a label source' }),
      JSON.stringify({
        type: 'user',
        cwd: 'F:\\CLAUDE_MULTI_APP',
        message: { content: 'first real user prompt for the label' },
      }),
    ].join('\n') + '\n',
  )
  return home
})

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, homedir: () => fixtureHome }
})

const { ClaudeProvider } = await import('../../../../src/main/providers/claude')
import type { HistorySession } from '../../../../src/main/providers/types'

describe('ClaudeProvider resume + history', () => {
  it('listHistorySessions returns HistorySession entries from ~/.claude/projects', async () => {
    const p = new ClaudeProvider()
    const sessions: HistorySession[] = await p.listHistorySessions()
    expect(Array.isArray(sessions)).toBe(true)
    // Fixture guarantees content — the old real-home version skipped every
    // assertion when the home was empty (vacuous pass on CI).
    expect(sessions.length).toBe(1)
    const s = sessions[0]
    expect(s.provider).toBe('claude')
    expect(s.sessionId).toBe('fixture-session-1')
    expect(typeof s.lastModified).toBe('number')
    // cwd must be the real path from the transcript line, not the encoded
    // project-dir name like "F--CLAUDE-MULTI-APP"
    expect(s.cwd).toBe('F:\\CLAUDE_MULTI_APP')
    expect(s.label).toBe('first real user prompt for the label')
  })

  it('resumeCommand returns claude --resume <id>', () => {
    const p = new ClaudeProvider()
    const r = p.resumeCommand('test-session-id')
    expect(typeof r.cmd).toBe('string')
    expect(r.cmd.length).toBeGreaterThan(0)
    expect(r.args).toEqual(['--resume', 'test-session-id'])
  })
})
