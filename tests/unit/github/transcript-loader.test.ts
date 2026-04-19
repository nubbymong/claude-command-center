import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// loadTranscriptEvents reads from ~/.claude/projects/. os.homedir() reads
// HOME (POSIX) and USERPROFILE (Windows), so we stub both via vi.stubEnv
// — which respects vitest's per-test isolation and won't bleed into
// parallel workers the way raw process.env mutations can.
let fakeHome: string

beforeEach(async () => {
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-tx-'))
  vi.stubEnv('HOME', fakeHome)
  vi.stubEnv('USERPROFILE', fakeHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(fakeHome, { recursive: true, force: true })
})

async function writeProjectJsonl(cwd: string, filename: string, lines: string[], mtime?: number) {
  // Mirror the convention in src/main/utils/claude-project-path.ts.
  const folder = cwd.replace(/:/g, '-').replace(/[\\/]+/g, '-')
  const dir = path.join(fakeHome, '.claude', 'projects', folder)
  await fs.mkdir(dir, { recursive: true })
  const full = path.join(dir, filename)
  await fs.writeFile(full, lines.join('\n'), 'utf8')
  if (mtime !== undefined) {
    await fs.utimes(full, new Date(mtime), new Date(mtime))
  }
  return full
}

describe('loadTranscriptEvents', () => {
  it('returns empty when cwd is undefined', async () => {
    const { loadTranscriptEvents } = await import(
      '../../../src/main/github/session/transcript-loader'
    )
    const r = await loadTranscriptEvents(undefined)
    expect(r).toEqual({ messages: [], toolCalls: [] })
  })

  it('returns empty when project folder does not exist', async () => {
    const { loadTranscriptEvents } = await import(
      '../../../src/main/github/session/transcript-loader'
    )
    const r = await loadTranscriptEvents('/nonexistent/path')
    expect(r).toEqual({ messages: [], toolCalls: [] })
  })

  it('picks the most recently modified jsonl when multiple exist', async () => {
    const cwd = '/home/x/app'
    await writeProjectJsonl(
      cwd,
      'old.jsonl',
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: 'old file' },
        }),
      ],
      Date.now() - 60_000,
    )
    await writeProjectJsonl(
      cwd,
      'new.jsonl',
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-02T00:00:00Z',
          message: { role: 'user', content: 'new file wins' },
        }),
      ],
      Date.now(),
    )

    const { loadTranscriptEvents } = await import(
      '../../../src/main/github/session/transcript-loader'
    )
    const r = await loadTranscriptEvents(cwd)
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0].text).toBe('new file wins')
  })

  it('tolerates invalid JSON lines', async () => {
    const cwd = '/home/x/app'
    await writeProjectJsonl(cwd, 'a.jsonl', [
      'not json at all',
      JSON.stringify({
        message: { role: 'user', content: 'good line' },
        timestamp: '2026-01-01T00:00:00Z',
      }),
      '{"half": ',
    ])

    const { loadTranscriptEvents } = await import(
      '../../../src/main/github/session/transcript-loader'
    )
    const r = await loadTranscriptEvents(cwd)
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0].text).toBe('good line')
  })

  it('extracts tool calls from content parts', async () => {
    const cwd = '/home/x/app'
    await writeProjectJsonl(cwd, 'a.jsonl', [
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/home/x/a.ts' } },
          ],
        },
        timestamp: '2026-01-01T00:00:00Z',
      }),
    ])

    const { loadTranscriptEvents } = await import(
      '../../../src/main/github/session/transcript-loader'
    )
    const r = await loadTranscriptEvents(cwd)
    expect(r.messages.map((m) => m.text)).toEqual(['ok'])
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].tool).toBe('Edit')
    expect(r.toolCalls[0].args).toEqual({ file_path: '/home/x/a.ts' })
  })

  it('caps at MAX_LINES (tails the newest lines)', async () => {
    const cwd = '/home/x/app'
    const many: string[] = []
    for (let i = 0; i < 600; i++) {
      many.push(
        JSON.stringify({
          message: { role: 'user', content: `msg-${i}` },
          timestamp: '2026-01-01T00:00:00Z',
        }),
      )
    }
    await writeProjectJsonl(cwd, 'a.jsonl', many)

    const { loadTranscriptEvents } = await import(
      '../../../src/main/github/session/transcript-loader'
    )
    const r = await loadTranscriptEvents(cwd)
    expect(r.messages).toHaveLength(500)
    // The tail should include the newest 500 — i.e. msg-599 down to msg-100.
    expect(r.messages[r.messages.length - 1].text).toBe('msg-599')
    expect(r.messages[0].text).toBe('msg-100')
  })
})
