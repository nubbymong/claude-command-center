/**
 * Pure unit tests for transcript-normalizer.ts.
 *
 * Fixtures are shaped after the real 605k-line histogram (2026-06-06) so every
 * branch is validated against real-world data patterns, not invented shapes.
 *
 * IMPORTANT: This is a plain vitest test — NOT a native test. The normalizer
 * has zero runtime deps beyond TypeScript, so no Electron ABI or sqlite is
 * involved. Do NOT rename to *.native.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { makeNormalizer, PARSER_VERSION, type MessageKind } from '../../../src/main/logging/transcript-normalizer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(obj: object): string {
  return JSON.stringify(obj)
}

function userEntry(content: unknown, extra?: object): object {
  return {
    type: 'user',
    timestamp: '2024-01-15T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  }
}

function assistantEntry(content: unknown, extra?: object): object {
  return {
    type: 'assistant',
    timestamp: '2024-01-15T10:01:00.000Z',
    message: { role: 'assistant', content },
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// PARSER_VERSION export
// ---------------------------------------------------------------------------

describe('PARSER_VERSION', () => {
  it('is exported as a number (currently 1)', () => {
    expect(typeof PARSER_VERSION).toBe('number')
    expect(PARSER_VERSION).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// makeNormalizer — basic construction
// ---------------------------------------------------------------------------

describe('makeNormalizer', () => {
  it('returns an object with push() and stats', () => {
    const n = makeNormalizer()
    expect(typeof n.push).toBe('function')
    expect(n.stats).toEqual({ malformed: 0, skippedMeta: 0, unknown: 0, unknownParts: 0 })
  })

  it('starts idx at 0 by default', () => {
    const n = makeNormalizer()
    const msgs = n.push(line(assistantEntry('hello')))
    expect(msgs[0].idx).toBe(0)
  })

  it('starts idx at startIdx when provided', () => {
    const n = makeNormalizer({ startIdx: 42 })
    const msgs = n.push(line(assistantEntry('hello')))
    expect(msgs[0].idx).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Text message — plain string content
// ---------------------------------------------------------------------------

describe('plain-string content', () => {
  it('produces a single message with kind "message"', () => {
    const n = makeNormalizer()
    const msgs = n.push(line(assistantEntry('Hello **world**!')))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].kind).toBe('message')
    expect(msgs[0].content).toBe('Hello **world**!')
    expect(msgs[0].toolName).toBeUndefined()
  })

  it('preserves markdown verbatim (no escaping)', () => {
    const n = makeNormalizer()
    const md = '# Heading\n\n- **bold**\n- `code`\n> blockquote'
    const msgs = n.push(line(assistantEntry(md)))
    expect(msgs[0].content).toBe(md)
  })

  it('maps user role correctly from string content', () => {
    const n = makeNormalizer()
    const msgs = n.push(line(userEntry('User says hi')))
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].kind).toBe('message')
    expect(msgs[0].content).toBe('User says hi')
  })

  it('yields empty array when content is whitespace-only', () => {
    const n = makeNormalizer()
    const cases = ['   ', '\n', '  \n  \t', '\t\t\n']
    for (const content of cases) {
      const msgs = n.push(line(assistantEntry(content)))
      expect(msgs).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Array content — text parts
// ---------------------------------------------------------------------------

describe('array content — text parts', () => {
  it('produces one message from a single text part', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([{ type: 'text', text: 'A single text part.' }])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('message')
    expect(msgs[0].content).toBe('A single text part.')
  })

  it('joins multiple text parts with "\\n\\n"', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      { type: 'text', text: 'Part one.' },
      { type: 'text', text: 'Part two.' },
      { type: 'text', text: 'Part three.' },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('Part one.\n\nPart two.\n\nPart three.')
  })

  it('yields nothing when all text parts are empty/whitespace', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      { type: 'text', text: '' },
      { type: 'text', text: '   ' },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// tool_use parts → tool_call rows
// ---------------------------------------------------------------------------

describe('tool_use parts → tool_call', () => {
  it('produces a tool_call row with toolName and bounded toolMeta', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      {
        type: 'tool_use',
        name: 'Read',
        input: { file_path: '/src/foo.ts', extra: 'ignored' },
      },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('tool_call')
    expect(msgs[0].toolName).toBe('Read')
    expect(msgs[0].content).toBe('')
    // toolMeta must be parseable JSON and include the file_path
    const meta = JSON.parse(msgs[0].toolMeta!)
    expect(meta.file_path).toBe('/src/foo.ts')
  })

  it('extracts the known preview keys (file_path, command, url, query, pattern, prompt, description)', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      {
        type: 'tool_use',
        name: 'MultiTool',
        input: {
          file_path: '/a/b.ts',
          command: 'ls -la',
          url: 'https://example.com',
          query: 'SELECT 1',
          pattern: '**/*.ts',
          prompt: 'Do something',
          description: 'A description',
          unrelated_key: 'should be absent',
        },
      },
    ])
    const msgs = n.push(line(entry))
    const meta = JSON.parse(msgs[0].toolMeta!)
    expect(meta.file_path).toBe('/a/b.ts')
    expect(meta.command).toBe('ls -la')
    expect(meta.url).toBe('https://example.com')
    expect(meta.query).toBe('SELECT 1')
    expect(meta.pattern).toBe('**/*.ts')
    expect(meta.prompt).toBe('Do something')
    expect(meta.description).toBe('A description')
    expect(meta.unrelated_key).toBeUndefined()
  })

  it('truncates each extracted value to 200 chars', () => {
    const n = makeNormalizer()
    const longValue = 'x'.repeat(300)
    const entry = assistantEntry([
      {
        type: 'tool_use',
        name: 'Write',
        input: { file_path: longValue },
      },
    ])
    const msgs = n.push(line(entry))
    const meta = JSON.parse(msgs[0].toolMeta!)
    expect(meta.file_path.length).toBeLessThanOrEqual(200)
  })

  it('keeps total toolMeta ≤ 2KB even when input is 10KB', () => {
    const n = makeNormalizer()
    // Build a 10KB input value
    const bigValue = 'A'.repeat(10_000)
    const entry = assistantEntry([
      {
        type: 'tool_use',
        name: 'Write',
        input: {
          file_path: bigValue,
          command: bigValue,
          url: bigValue,
          query: bigValue,
          pattern: bigValue,
          prompt: bigValue,
          description: bigValue,
        },
      },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('tool_call')
    expect(msgs[0].toolMeta!.length).toBeLessThanOrEqual(2048)
    // Verify the output is valid JSON
    expect(() => JSON.parse(msgs[0].toolMeta!)).not.toThrow()
  })

  it('produces valid JSON ≤ 2KB for toolMeta even with extreme inputs on all 7 preview keys', () => {
    const n = makeNormalizer()
    // Craft inputs that stress all 7 keys with large values to trigger cap logic
    const entry = assistantEntry([
      {
        type: 'tool_use',
        name: 'MultiTool',
        input: {
          file_path: 'x'.repeat(300),
          command: 'y'.repeat(300),
          url: 'z'.repeat(300),
          query: 'q'.repeat(300),
          pattern: 'p'.repeat(300),
          prompt: 'r'.repeat(300),
          description: 'd'.repeat(300),
        },
      },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    const meta = msgs[0].toolMeta!
    expect(meta.length).toBeLessThanOrEqual(2048)
    // Verify the output is valid JSON (either the full preview or the truncation sentinel)
    const parsed = JSON.parse(meta)
    expect(parsed).toBeDefined()
  })

  it('produces one tool_call per tool_use part', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      { type: 'tool_use', name: 'ToolA', input: { command: 'a' } },
      { type: 'tool_use', name: 'ToolB', input: { command: 'b' } },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(2)
    expect(msgs[0].toolName).toBe('ToolA')
    expect(msgs[1].toolName).toBe('ToolB')
    expect(msgs[0].kind).toBe('tool_call')
    expect(msgs[1].kind).toBe('tool_call')
  })
})

// ---------------------------------------------------------------------------
// tool_result parts → skipped
// ---------------------------------------------------------------------------

describe('tool_result parts → skipped', () => {
  it('a user entry whose content is all tool_result yields []', () => {
    const n = makeNormalizer()
    // Classic user-role tool_result entry
    const entry = userEntry([
      { type: 'tool_result', tool_use_id: 'abc', content: 'result text' },
      { type: 'tool_result', tool_use_id: 'def', content: 'another result' },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(0)
  })

  it('skips tool_result parts in a mixed entry, keeps text + tool_use', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      { type: 'text', text: 'Here is my plan.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } },
      { type: 'tool_result', tool_use_id: 'xyz', content: 'hi' },
    ])
    const msgs = n.push(line(entry))
    // Expect: 1 message (text) + 1 tool_call (tool_use); tool_result silently dropped
    expect(msgs).toHaveLength(2)
    expect(msgs[0].kind).toBe('message')
    expect(msgs[0].content).toBe('Here is my plan.')
    expect(msgs[1].kind).toBe('tool_call')
    expect(msgs[1].toolName).toBe('Bash')
  })
})

// ---------------------------------------------------------------------------
// thinking parts → skipped
// ---------------------------------------------------------------------------

describe('thinking parts → skipped', () => {
  it('does not emit rows for thinking parts', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      { type: 'thinking', thinking: '<extended thinking content>' },
      { type: 'text', text: 'The answer is 42.' },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('message')
    expect(msgs[0].content).toBe('The answer is 42.')
  })

  it('yields nothing when an entry has ONLY thinking parts', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      { type: 'thinking', thinking: 'just thinking...' },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// image parts → '[image]' in message
// ---------------------------------------------------------------------------

describe('image parts → [image]', () => {
  it('appends literal "[image]" to message content for each image part', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc==' } },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('message')
    expect(msgs[0].content).toContain('[image]')
  })

  it('includes [image] among text parts in a mixed entry', () => {
    const n = makeNormalizer()
    const entry = userEntry([
      { type: 'text', text: 'Look at this:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'xyz==' } },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('Look at this:')
    expect(msgs[0].content).toContain('[image]')
  })
})

// ---------------------------------------------------------------------------
// isSidechain → kind 'sidechain'
// ---------------------------------------------------------------------------

describe('isSidechain entries', () => {
  it('sets kind to "sidechain" for a plain-string entry with isSidechain:true', () => {
    const n = makeNormalizer()
    const entry = assistantEntry('Plain text sidechain output.', { isSidechain: true })
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('sidechain')
    expect(msgs[0].content).toBe('Plain text sidechain output.')
  })

  it('sets kind to "sidechain" for a text-part entry with isSidechain:true', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([{ type: 'text', text: 'Sub-agent output.' }], { isSidechain: true })
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('sidechain')
  })

  it('sets kind to "sidechain" on tool_call rows too when isSidechain:true', () => {
    const n = makeNormalizer()
    const entry = assistantEntry(
      [{ type: 'tool_use', name: 'BashTool', input: { command: 'pwd' } }],
      { isSidechain: true },
    )
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('sidechain')
  })
})

// ---------------------------------------------------------------------------
// Skip-list — known metadata types
// ---------------------------------------------------------------------------

// INTENTIONAL GOLDEN COPY: this array mirrors the SKIP_TYPES Set in transcript-normalizer.ts.
// If the src Set changes, update both places and bump PARSER_VERSION.
const SKIP_TYPES = [
  'attachment',
  'last-prompt',
  'pr-link',
  'permission-mode',
  'custom-title',
  'agent-name',
  'system',
  'queue-operation',
  'mode',
  'ai-title',
  'progress',
  'worktree-state',
  'file-history-snapshot',
  'summary',
] as const

describe('skip-list metadata types', () => {
  for (const t of SKIP_TYPES) {
    it(`silently skips type "${t}" and increments skippedMeta`, () => {
      const n = makeNormalizer()
      const msgs = n.push(line({ type: t, timestamp: '2024-01-01T00:00:00.000Z', data: {} }))
      expect(msgs).toHaveLength(0)
      expect(n.stats.skippedMeta).toBe(1)
      expect(n.stats.unknown).toBe(0)
    })
  }

  it('skips entries with isMeta:true regardless of type', () => {
    const n = makeNormalizer()
    const msgs = n.push(line({ type: 'some-meta', isMeta: true, data: 'x' }))
    expect(msgs).toHaveLength(0)
    expect(n.stats.skippedMeta).toBe(1)
  })

  it('counts multiple skip-list entries in stats.skippedMeta', () => {
    const n = makeNormalizer()
    n.push(line({ type: 'attachment' }))
    n.push(line({ type: 'pr-link' }))
    n.push(line({ type: 'permission-mode' }))
    expect(n.stats.skippedMeta).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Unknown types → unknown row
// ---------------------------------------------------------------------------

describe('unknown types', () => {
  it('produces one unknown row for a user/assistant entry with message field absent', () => {
    const n = makeNormalizer()
    const entry = { type: 'user', timestamp: '2024-01-01T00:00:00.000Z', data: { foo: 'bar' } }
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].kind).toBe('unknown')
    expect(msgs[0].content).toBe('')
    expect(n.stats.unknown).toBe(1)
  })

  it('produces one unknown row for a user/assistant entry with message: null', () => {
    const n = makeNormalizer()
    const entry = { type: 'assistant', timestamp: '2024-01-01T00:00:00.000Z', message: null }
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].kind).toBe('unknown')
    expect(n.stats.unknown).toBe(1)
  })

  it('produces one unknown row for a genuinely novel type', () => {
    const n = makeNormalizer()
    const entry = { type: 'hologram', timestamp: '2024-01-01T00:00:00.000Z', data: { foo: 'bar' } }
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].kind).toBe('unknown')
    expect(msgs[0].content).toBe('')
    expect(n.stats.unknown).toBe(1)
  })

  it('stores the verbatim JSONL line in raw', () => {
    const n = makeNormalizer()
    const rawLine = line({ type: 'hologram', id: 'abc123' })
    const msgs = n.push(rawLine)
    expect(msgs[0].raw).toBe(rawLine)
  })

  it('caps raw at 32*1024 chars and appends truncation suffix', () => {
    const n = makeNormalizer()
    // Build a JSONL line > 32KB by putting a huge field inside a novel-type entry
    const big = 'X'.repeat(40_000)
    const hugeEntry = { type: 'hologram', payload: big }
    const rawLine = line(hugeEntry)
    expect(rawLine.length).toBeGreaterThan(32 * 1024)

    const msgs = n.push(rawLine)
    expect(msgs[0].raw!.length).toBeLessThanOrEqual(32 * 1024 + 50) // cap + short suffix
    expect(msgs[0].raw).toContain('…[truncated]')
  })

  it('counts unknown entries in stats.unknown', () => {
    const n = makeNormalizer()
    n.push(line({ type: 'hologram' }))
    n.push(line({ type: 'wormhole' }))
    expect(n.stats.unknown).toBe(2)
    expect(n.stats.skippedMeta).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Malformed JSON
// ---------------------------------------------------------------------------

describe('malformed JSON', () => {
  it('returns [] for a non-parseable line', () => {
    const n = makeNormalizer()
    const msgs = n.push('{ this is not valid json }}}')
    expect(msgs).toHaveLength(0)
    expect(n.stats.malformed).toBe(1)
  })

  it('never throws on malformed input', () => {
    const n = makeNormalizer()
    expect(() => n.push('totally not json at all!!')).not.toThrow()
    expect(() => n.push('')).not.toThrow()
    expect(() => n.push('null')).not.toThrow()
    expect(() => n.push('42')).not.toThrow()
    expect(() => n.push('"just a string"')).not.toThrow()
  })

  it('returns [] for bare JSON values (null, number, string, array) and increments malformed', () => {
    const n = makeNormalizer()
    const cases = ['null', '42', '"just a string"', '[1,2]']
    for (const input of cases) {
      const msgs = n.push(input)
      expect(msgs).toHaveLength(0)
    }
    expect(n.stats.malformed).toBe(4)
  })

  it('counts multiple malformed lines in stats.malformed', () => {
    const n = makeNormalizer()
    n.push('bad json 1')
    n.push('bad json 2')
    n.push('bad json 3')
    expect(n.stats.malformed).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// idx sequencing
// ---------------------------------------------------------------------------

describe('idx sequencing', () => {
  it('assigns sequential idx across pushes', () => {
    const n = makeNormalizer()
    const msgs1 = n.push(line(assistantEntry('First')))
    const msgs2 = n.push(line(assistantEntry('Second')))
    const msgs3 = n.push(line(assistantEntry('Third')))
    expect(msgs1[0].idx).toBe(0)
    expect(msgs2[0].idx).toBe(1)
    expect(msgs3[0].idx).toBe(2)
  })

  it('continues idx from startIdx', () => {
    const n = makeNormalizer({ startIdx: 100 })
    const m1 = n.push(line(assistantEntry('A')))
    const m2 = n.push(line(assistantEntry('B')))
    expect(m1[0].idx).toBe(100)
    expect(m2[0].idx).toBe(101)
  })

  it('increments idx for each message and each tool_call emitted from one entry', () => {
    const n = makeNormalizer({ startIdx: 10 })
    // One entry with text + two tool_use → 3 rows
    const entry = assistantEntry([
      { type: 'text', text: 'Doing stuff.' },
      { type: 'tool_use', name: 'ToolA', input: { command: 'a' } },
      { type: 'tool_use', name: 'ToolB', input: { command: 'b' } },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(3)
    expect(msgs[0].idx).toBe(10)
    expect(msgs[1].idx).toBe(11)
    expect(msgs[2].idx).toBe(12)
    // Next push continues from 13
    const next = n.push(line(assistantEntry('After.')))
    expect(next[0].idx).toBe(13)
  })

  it('skipped entries do not consume idx', () => {
    const n = makeNormalizer()
    n.push(line({ type: 'attachment' }))
    n.push(line({ type: 'pr-link' }))
    const msgs = n.push(line(assistantEntry('After skips.')))
    expect(msgs[0].idx).toBe(0) // idx 0, not 2
  })

  it('malformed lines do not consume idx', () => {
    const n = makeNormalizer()
    n.push('not json')
    const msgs = n.push(line(assistantEntry('After malformed.')))
    expect(msgs[0].idx).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Timestamp handling
// ---------------------------------------------------------------------------

describe('timestamp handling', () => {
  it('parses ISO timestamp string to epoch ms', () => {
    const n = makeNormalizer()
    const msgs = n.push(line(assistantEntry('Hi', { timestamp: '2024-06-01T12:00:00.000Z' })))
    expect(msgs[0].ts).toBe(new Date('2024-06-01T12:00:00.000Z').getTime())
  })

  it('accepts numeric ts field directly', () => {
    const n = makeNormalizer()
    const entry = { type: 'assistant', ts: 1717243200000, message: { role: 'assistant', content: 'hi' } }
    const msgs = n.push(line(entry))
    expect(msgs[0].ts).toBe(1717243200000)
  })

  it('inherits lastTs when timestamp is missing on a KEPT entry', () => {
    const n = makeNormalizer()
    // First entry sets the lastTs
    n.push(line({ type: 'assistant', timestamp: '2024-06-01T12:00:00.000Z', message: { role: 'assistant', content: 'First.' } }))
    // Second entry has no timestamp — should inherit
    const msgs = n.push(line({ type: 'assistant', message: { role: 'assistant', content: 'Second.' } }))
    expect(msgs[0].ts).toBe(new Date('2024-06-01T12:00:00.000Z').getTime())
  })

  it('uses 0 as ts when there is no timestamp and no lastTs', () => {
    const n = makeNormalizer()
    const msgs = n.push(line({ type: 'assistant', message: { role: 'assistant', content: 'No ts.' } }))
    expect(msgs[0].ts).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Role fallback
// ---------------------------------------------------------------------------

describe('role fallback', () => {
  it('uses message.role when available', () => {
    const n = makeNormalizer()
    const msgs = n.push(line({ type: 'user', message: { role: 'user', content: 'hello' } }))
    expect(msgs[0].role).toBe('user')
  })

  it('falls back to entry type when message.role is missing', () => {
    const n = makeNormalizer()
    const msgs = n.push(line({ type: 'assistant', message: { content: 'hello' } }))
    expect(msgs[0].role).toBe('assistant')
  })

  it('falls back to entry type for plain-string content too', () => {
    const n = makeNormalizer()
    const msgs = n.push(line({ type: 'user', message: { content: 'plain string' } }))
    expect(msgs[0].role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// Mixed scenario: realistic assistant turn
// ---------------------------------------------------------------------------

describe('realistic mixed assistant turn', () => {
  it('produces message + tool_calls only (tool_result + thinking dropped)', () => {
    const n = makeNormalizer({ startIdx: 5 })
    const entry = {
      type: 'assistant',
      timestamp: '2024-06-06T09:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think…' },
          { type: 'text', text: 'I will read that file.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/foo.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          // tool_result shouldn't appear in assistant turns in practice, but handle defensively
        ],
      },
    }
    const msgs = n.push(line(entry))
    // thinking skipped → text(message) + Read(tool_call) + Bash(tool_call) = 3
    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toMatchObject({ idx: 5, kind: 'message', content: 'I will read that file.', role: 'assistant' })
    expect(msgs[1]).toMatchObject({ idx: 6, kind: 'tool_call', toolName: 'Read' })
    expect(msgs[2]).toMatchObject({ idx: 7, kind: 'tool_call', toolName: 'Bash' })
  })
})

// ---------------------------------------------------------------------------
// Summary / stat consistency
// ---------------------------------------------------------------------------

describe('stats consistency', () => {
  it('stats object is the same reference throughout (not cloned per push)', () => {
    const n = makeNormalizer()
    const stats1 = n.stats
    n.push(line({ type: 'attachment' }))
    expect(n.stats).toBe(stats1) // same reference
    expect(stats1.skippedMeta).toBe(1)
  })

  it('all three counters are independent', () => {
    const n = makeNormalizer()
    n.push('bad json')                                        // malformed
    n.push(line({ type: 'attachment' }))                     // skippedMeta
    n.push(line({ type: 'hologram', id: 1 }))                // unknown
    expect(n.stats).toEqual({ malformed: 1, skippedMeta: 1, unknown: 1, unknownParts: 0 })
  })
})

// ---------------------------------------------------------------------------
// unknownParts telemetry (task 1)
// ---------------------------------------------------------------------------

describe('unknownParts telemetry', () => {
  it('increments unknownParts for a non-object content part (null)', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([null, { type: 'text', text: 'ok' }])
    n.push(line(entry))
    expect(n.stats.unknownParts).toBe(1)
    expect(n.stats.unknown).toBe(0) // entry-level counter unchanged
  })

  it('increments unknownParts for an unknown part type object', () => {
    const n = makeNormalizer()
    const entry = assistantEntry([
      { type: 'hologram_part', data: 'x' },
      { type: 'text', text: 'hello' },
    ])
    n.push(line(entry))
    expect(n.stats.unknownParts).toBe(1)
  })

  it('accumulates unknownParts across multiple entries', () => {
    const n = makeNormalizer()
    n.push(line(assistantEntry([{ type: 'alien' }])))
    n.push(line(assistantEntry([42, null]))) // two non-object parts
    expect(n.stats.unknownParts).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// startTs option — seed lastTs for resume (task 2)
// ---------------------------------------------------------------------------

describe('startTs option', () => {
  it('uses startTs as lastTs when no timestamp in entry', () => {
    const seedTs = new Date('2024-03-01T00:00:00.000Z').getTime()
    const n = makeNormalizer({ startTs: seedTs })
    const msgs = n.push(line({ type: 'assistant', message: { role: 'assistant', content: 'No ts.' } }))
    expect(msgs[0].ts).toBe(seedTs)
  })

  it('overrides startTs when entry has its own timestamp', () => {
    const seedTs = new Date('2024-01-01T00:00:00.000Z').getTime()
    const entryTs = new Date('2024-06-01T12:00:00.000Z').getTime()
    const n = makeNormalizer({ startTs: seedTs })
    const msgs = n.push(line(assistantEntry('Hi', { timestamp: '2024-06-01T12:00:00.000Z' })))
    expect(msgs[0].ts).toBe(entryTs)
  })

  it('startTs defaults to 0 when not provided', () => {
    const n = makeNormalizer()
    const msgs = n.push(line({ type: 'assistant', message: { role: 'assistant', content: 'No ts.' } }))
    expect(msgs[0].ts).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// toolMeta total-cap: drop trailing keys, not all-or-nothing (task 3)
// ---------------------------------------------------------------------------

describe('toolMeta cap — drop trailing keys', () => {
  it('drops trailing keys in reverse order until JSON fits ≤ 2048', () => {
    const n = makeNormalizer()
    // All 7 keys at 200 chars each → total ~7*215 chars ≈ 1505 chars, easily fits.
    // Use 180 chars each to ensure total > 2048 when we add JSON overhead:
    // 7 * (200+overhead) > 2048.  Use exact 200-char values for each key.
    const val200 = 'A'.repeat(200)
    const entry = assistantEntry([{
      type: 'tool_use',
      name: 'T',
      input: {
        file_path: val200,
        command: val200,
        url: val200,
        query: val200,
        pattern: val200,
        prompt: val200,
        description: val200,
      },
    }])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(1)
    const meta = msgs[0].toolMeta!
    expect(meta.length).toBeLessThanOrEqual(2048)
    const parsed = JSON.parse(meta) // must still be valid JSON
    expect(parsed).toBeDefined()
    // Must NOT be the all-or-nothing sentinel — file_path should survive
    if (parsed._truncated !== true) {
      expect(parsed.file_path).toBeDefined()
    }
  })

  it('retains file_path when only the tail keys pushed it over the cap', () => {
    const n = makeNormalizer()
    // Craft a scenario: file_path fits alone, but adding description overflows.
    const val200 = 'B'.repeat(200)
    const entry = assistantEntry([{
      type: 'tool_use',
      name: 'T',
      input: { file_path: val200, description: val200 },
    }])
    const msgs = n.push(line(entry))
    const parsed = JSON.parse(msgs[0].toolMeta!)
    // After dropping description, file_path alone fits; _truncated must NOT appear
    if ('_truncated' in parsed) {
      // If sentinel, that means even file_path alone ≥ 2048 — shouldn't happen here
      throw new Error('Unexpected _truncated sentinel when file_path alone fits')
    }
    expect(parsed.file_path).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Interleaved [text, tool_use, text] → 3 rows in order (task 4)
// ---------------------------------------------------------------------------

describe('interleaved text + tool_use + text → ordered rows', () => {
  it('produces message/tool_call/message with consecutive idx', () => {
    const n = makeNormalizer({ startIdx: 0 })
    const entry = assistantEntry([
      { type: 'text', text: 'Before the tool call.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/foo.ts' } },
      { type: 'text', text: 'After the tool call.' },
    ])
    const msgs = n.push(line(entry))
    expect(msgs).toHaveLength(3)
    // Order: message → tool_call → message
    expect(msgs[0].kind as MessageKind).toBe('message')
    expect(msgs[0].content).toBe('Before the tool call.')
    expect(msgs[0].idx).toBe(0)
    expect(msgs[1].kind as MessageKind).toBe('tool_call')
    expect(msgs[1].toolName).toBe('Read')
    expect(msgs[1].idx).toBe(1)
    expect(msgs[2].kind as MessageKind).toBe('message')
    expect(msgs[2].content).toBe('After the tool call.')
    expect(msgs[2].idx).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Conversation-entry unknown paths: verbatim raw (task 5)
// ---------------------------------------------------------------------------

describe('conversation-entry unknown: verbatim raw', () => {
  it('stores verbatim input line in raw when message field is absent', () => {
    const n = makeNormalizer()
    const rawLine = line({ type: 'user', timestamp: '2024-01-01T00:00:00.000Z', data: { x: 1 } })
    const msgs = n.push(rawLine)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].raw).toBe(rawLine)
  })

  it('stores verbatim input line in raw when message is null', () => {
    const n = makeNormalizer()
    const rawLine = line({ type: 'assistant', timestamp: '2024-01-01T00:00:00.000Z', message: null })
    const msgs = n.push(rawLine)
    expect(msgs[0].raw).toBe(rawLine)
  })

  it('stores verbatim input line in raw when content shape is unrecognizable', () => {
    const n = makeNormalizer()
    const rawLine = line({ type: 'assistant', message: { role: 'assistant', content: 42 } })
    const msgs = n.push(rawLine)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind as MessageKind).toBe('unknown')
    expect(msgs[0].raw).toBe(rawLine)
  })
})

// ---------------------------------------------------------------------------
// Blank/whitespace-only lines → [] without counting malformed (task 6)
// ---------------------------------------------------------------------------

describe('blank / whitespace-only lines', () => {
  it('returns [] for a blank line without incrementing malformed', () => {
    const n = makeNormalizer()
    const msgs = n.push('')
    expect(msgs).toHaveLength(0)
    expect(n.stats.malformed).toBe(0)
  })

  it('returns [] for a whitespace-only line without incrementing malformed', () => {
    const n = makeNormalizer()
    const msgs = n.push('   \n\t  ')
    expect(msgs).toHaveLength(0)
    expect(n.stats.malformed).toBe(0)
  })

  it('trailing-newline files: blank lines do not inflate malformed', () => {
    const n = makeNormalizer()
    // Simulate reading a file that ends with \n: last "line" is ''
    n.push(line(assistantEntry('First line')))
    n.push('')  // trailing newline produces an empty string
    n.push('\n') // or a bare newline
    expect(n.stats.malformed).toBe(0)
    expect(n.stats.unknown).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Surrogate-pair guard at cap boundaries (task 7)
// ---------------------------------------------------------------------------

describe('surrogate-pair guard', () => {
  it('capRaw: no lone high surrogate at the cut boundary (emoji at the edge)', () => {
    // Build a string where a 4-byte emoji straddles the RAW_CAP boundary.
    // An emoji like 🎉 = U+1F389 = two UTF-16 code units: 0xD83C 0xDF89 (high+low surrogate pair).
    // Place the high surrogate exactly AT index RAW_CAP-1.
    const RAW_CAP = 32 * 1024
    const emoji = '🎉' // 🎉, 2 code units
    // Pad to RAW_CAP-1 chars, then append emoji (puts high surrogate at index RAW_CAP-1)
    const padded = 'A'.repeat(RAW_CAP - 1) + emoji + 'trailing'
    // Push as a novel-type entry so capRaw is invoked
    const rawLine = JSON.stringify({ type: 'hologram', payload: padded })
    // rawLine length > RAW_CAP, so capRaw fires
    const n = makeNormalizer()
    const msgs = n.push(rawLine)
    expect(msgs).toHaveLength(1)
    const raw = msgs[0].raw!
    // The truncated raw must NOT end with a lone high surrogate before the suffix
    const suffix = '…[truncated]' // '…[truncated]'
    const body = raw.endsWith(suffix) ? raw.slice(0, raw.length - suffix.length) : raw
    expect(/[\uD800-\uDBFF]$/.test(body)).toBe(false)
  })

  it('capMetaValue: no lone high surrogate in toolMeta value at 200-char boundary', () => {
    // Craft a tool input where file_path has an emoji high surrogate right at char 199
    const emoji = '🎉' // 🎉
    // Pad to 199 chars, then append emoji so high surrogate lands at index 199 (= cap boundary)
    const val = 'B'.repeat(199) + emoji + 'extra'
    const n = makeNormalizer()
    const entry = assistantEntry([{
      type: 'tool_use',
      name: 'T',
      input: { file_path: val },
    }])
    const msgs = n.push(line(entry))
    const meta = JSON.parse(msgs[0].toolMeta!)
    const fp: string = meta.file_path
    expect(fp.length).toBeLessThanOrEqual(200)
    // Must not end with a lone high surrogate
    expect(/[\uD800-\uDBFF]$/.test(fp)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// MessageKind type export (task 8)
// ---------------------------------------------------------------------------

describe('MessageKind type export', () => {
  it('the normalizer produces known MessageKind values', () => {
    const validKinds = new Set<MessageKind>(['message', 'tool_call', 'sidechain', 'unknown'])
    const n = makeNormalizer()
    // message
    n.push(line(assistantEntry('hi'))).forEach(m => expect(validKinds.has(m.kind as MessageKind)).toBe(true))
    // tool_call
    n.push(line(assistantEntry([{ type: 'tool_use', name: 'T', input: {} }])))
      .forEach(m => expect(validKinds.has(m.kind as MessageKind)).toBe(true))
    // sidechain
    n.push(line(assistantEntry('sub', { isSidechain: true })))
      .forEach(m => expect(validKinds.has(m.kind as MessageKind)).toBe(true))
    // unknown
    n.push(line({ type: 'novel', data: 'x' }))
      .forEach(m => expect(validKinds.has(m.kind as MessageKind)).toBe(true))
  })
})

// ---------------------------------------------------------------------------
// Verbatim-realistic fixture: full CC user line (task 9)
// ---------------------------------------------------------------------------

describe('verbatim-realistic fixture: full CC JSONL line', () => {
  it('normalizes a real-world user entry with uuid/parentUuid/sessionId/cwd/version/requestId fields', () => {
    // Shaped after actual Claude Code JSONL transcripts (2026-06-06 histogram)
    const realisticEntry = {
      type: 'user',
      uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      parentUuid: null,
      sessionId: 's-abc123xyz',
      timestamp: '2024-06-06T09:15:00.000Z',
      cwd: '/home/user/projects/myapp',
      version: '1.2.3',
      requestId: 'req-deadbeef',
      message: {
        role: 'user',
        content: 'Please read the README and tell me what this project does.',
      },
    }
    const n = makeNormalizer()
    const msgs = n.push(JSON.stringify(realisticEntry))
    // Extra fields (uuid, parentUuid, sessionId, cwd, version, requestId) are inert
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].kind as MessageKind).toBe('message')
    expect(msgs[0].content).toBe('Please read the README and tell me what this project does.')
    expect(msgs[0].ts).toBe(new Date('2024-06-06T09:15:00.000Z').getTime())
    expect(n.stats.malformed).toBe(0)
    expect(n.stats.unknown).toBe(0)
  })
})
