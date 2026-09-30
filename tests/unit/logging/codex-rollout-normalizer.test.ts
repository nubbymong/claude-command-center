/**
 * P3.12 (row 31): the Codex rollout normalizer, beside Claude's
 * (transcript-normalizer.ts). What Codex shows as the conversation becomes the
 * same rows Claude's normalizer makes: the user's and the assistant's words, a
 * tool_call row per tool call with Claude's bounded preview, and an unknown
 * record type kept as an unsupported entry. Injected context, reasoning and tool
 * outputs are skipped, as Claude skips thinking and tool results.
 *
 * Fixtures: real rollouts recorded on the test VM (P3.1) for 0.153.4 and 0.155.1
 * (paginated history), and the older anonymised sample (legacy history).
 *
 * A plain vitest test: the normalizer has no runtime dependency.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  makeCodexRolloutNormalizer,
  readCodexRolloutLine,
  CODEX_PARSER_VERSION,
} from '../../../src/main/logging/codex-rollout-normalizer'
import type { NewMessage } from '../../../src/main/logging/transcripts-db'

const FIX = resolve(__dirname, '../../fixtures/codex')
const lines = (rel: string): string[] => readFileSync(resolve(FIX, rel), 'utf8').split(/\r?\n/)
const run = (ls: string[], opts?: { startIdx?: number; startTs?: number }) => {
  const n = makeCodexRolloutNormalizer(opts)
  const out: NewMessage[] = []
  for (const l of ls) out.push(...n.push(l))
  return { rows: out, stats: n.stats }
}
const L = (obj: object): string => JSON.stringify(obj)
const T = '2026-09-27T10:00:00.000Z'
const item = (payload: object, ts = T) => L({ timestamp: ts, type: 'response_item', payload })
const event = (payload: object, ts = T) => L({ timestamp: ts, type: 'event_msg', payload })
const completed = (it: object, ts = T) => event({ type: 'item_completed', thread_id: 't', turn_id: 'u', item: it }, ts)

describe('the Codex rollout normalizer (P3.12, row 31)', () => {
  it('has its own parser version', () => {
    expect(CODEX_PARSER_VERSION).toBe(1)
  })

  it('0.155.1 edit rollout: the user turn, the assistant turns and the edit as a tool call, in order; nothing injected, no reasoning, no tool output', () => {
    const { rows } = run(lines('cli/0.155.1/rollout-edit.jsonl'))
    const shape = rows.map((r) => [r.role, r.kind, r.kind === 'tool_call' ? r.toolName : r.content])
    expect(shape).toEqual([
      ['user', 'message', 'In note.txt, replace the line beta with two lines, delta and epsilon, and keep the other lines. Make one file edit and run no other commands. Then reply with the word done.'],
      ['assistant', 'message', 'I\u2019ll make the single edit to note.txt.'],
      ['assistant', 'tool_call', 'exec'],
      ['assistant', 'message', 'done'],
    ])
    // The edit's file, as Claude's Edit row carries file_path (and nothing of the patch body).
    const tool = rows.find((r) => r.kind === 'tool_call')!
    expect(JSON.parse(tool.toolMeta!)).toEqual({ file_path: 'C:/Users/alex/projects/edit-demo/note.txt' })
    const all = JSON.stringify(rows)
    for (const injected of ['skills_instructions', 'multi_agent_role', 'recommended_plugins', 'Script completed', '+delta']) {
      expect(all).not.toContain(injected)
    }
    // idx is dense from 0 and ts comes from each record.
    expect(rows.map((r) => r.idx)).toEqual([0, 1, 2, 3])
    for (const r of rows) expect(r.ts).toBeGreaterThan(0)
  })

  it('0.153.4 exec-then-resume rollout: both turns of the conversation, the resumed one after the first', () => {
    const { rows } = run(lines('cli/0.153.4/rollout-exec-then-resume.jsonl'))
    expect(rows.map((r) => [r.role, r.content.slice(0, 40)])).toEqual([
      ['user', 'Reply with exactly three lowercase words'],
      ['assistant', 'none none juniper'],
      ['user', 'Reply with exactly two lowercase words s'],
      ['assistant', 'none none'],
    ])
  })

  it('a legacy-history rollout: the user_message and agent_message events, never the response items that carry the same words again', () => {
    const { rows } = run(lines('rollout-sample.jsonl'))
    expect(rows.map((r) => [r.role, r.kind, r.content])).toEqual([
      ['user', 'message', '[anonymised]'],
      ['assistant', 'message', '[anonymised]'],
    ])
  })

  it('a shell call: its command as Claude\'s Bash preview carries it, the shell\'s own script when wrapped', () => {
    const cases: Array<[object, string, string]> = [
      [{ type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status'], workdir: '/w' }) }, 'shell', 'git status'],
      [{ type: 'function_call', name: 'shell', call_id: 'c2', arguments: JSON.stringify({ command: ['powershell.exe', '-NoProfile', '-Command', 'Get-ChildItem'] }) }, 'shell', 'Get-ChildItem'],
      [{ type: 'function_call', name: 'shell', call_id: 'c3', arguments: JSON.stringify({ command: ['rg', '-n', 'needle'] }) }, 'shell', 'rg -n needle'],
      [{ type: 'function_call', name: 'shell_command', call_id: 'c4', arguments: JSON.stringify({ command: 'npm test' }) }, 'shell_command', 'npm test'],
      [{ type: 'function_call', name: 'exec_command', call_id: 'c5', arguments: JSON.stringify({ cmd: 'ls -la' }) }, 'exec_command', 'ls -la'],
      [{ type: 'local_shell_call', call_id: 'c6', status: 'completed', action: { type: 'exec', command: ['bash', '-lc', 'cat README.md'] } }, 'local_shell', 'cat README.md'],
    ]
    for (const [payload, name, command] of cases) {
      const { rows } = run([item(payload)])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ role: 'assistant', kind: 'tool_call', content: '', toolName: name })
      expect(JSON.parse(rows[0].toolMeta!)).toEqual({ command })
    }
  })

  it('an apply_patch call names its files; a web search its query; other arguments ride Claude\'s preview keys only', () => {
    const patch = '*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n@@\n-a\n+b\n*** End Patch\n'
    const a = run([item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'p', input: patch })]).rows
    expect(a[0].toolName).toBe('apply_patch')
    expect(JSON.parse(a[0].toolMeta!)).toEqual({ file_path: 'src/new.ts' })
    const w = run([item({ type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'codex rollout' } })]).rows
    expect(w[0].toolName).toBe('web_search')
    expect(JSON.parse(w[0].toolMeta!)).toEqual({ query: 'codex rollout' })
    const f = run([item({ type: 'function_call', name: 'mcp__docs__fetch', call_id: 'm', arguments: JSON.stringify({ url: 'https://e.test', token: 'NOT-KEPT', body: 'NOT-KEPT' }) })]).rows
    expect(JSON.parse(f[0].toolMeta!)).toEqual({ url: 'https://e.test' })
    expect(f[0].toolMeta).not.toContain('NOT-KEPT')
  })

  it('bounds what a rollout can put in a row: the tool name, the arguments it parses, the files it names', () => {
    const long = run([item({ type: 'function_call', name: 'n'.repeat(500), call_id: 'c', arguments: '{}' })]).rows
    expect(long[0].toolName).toHaveLength(200)
    const huge = JSON.stringify({ command: 'ls', pad: 'p'.repeat(300 * 1024) })
    expect(run([item({ type: 'function_call', name: 'shell', call_id: 'c', arguments: huge })]).rows[0].toolMeta).toBe('{}')
    const many = '*** Begin Patch\n' + Array.from({ length: 30 }, (_, i) => `*** Update File: f${i}.ts\n@@\n-a\n+b\n`).join('') + '*** End Patch\n'
    const read = readCodexRolloutLine(item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'p', input: many }))!
    expect((read.entries[0] as { edits: unknown[] }).edits).toHaveLength(20)
    const longPath = '*** Begin Patch\n*** Update File: ' + 'd/'.repeat(600) + 'x.ts\n*** Update File: ok.ts\n*** End Patch\n'
    const lp = readCodexRolloutLine(item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'p', input: longPath }))!
    expect((lp.entries[0] as { edits: Array<{ path: string }> }).edits.map((e) => e.path)).toEqual(['ok.ts'])
    const changes = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${i}.ts`, { type: 'update', unified_diff: '' }]))
    const fc = readCodexRolloutLine(completed({ type: 'FileChange', id: 'f', changes }))!
    expect((fc.entries[0] as { files: unknown[] }).files).toHaveLength(20)
  })

  it('bounds each preview value at 200 characters, as Claude\'s does', () => {
    const long = 'x'.repeat(5000)
    const { rows } = run([item({ type: 'function_call', name: 'shell', call_id: 'c', arguments: JSON.stringify({ command: ['bash', '-lc', long] }) })])
    expect(JSON.parse(rows[0].toolMeta!).command).toHaveLength(200)
  })

  it('skips tool outputs, reasoning, injected context and every known metadata record', () => {
    const skipped = [
      item({ type: 'function_call_output', call_id: 'c', output: 'SECRET-OUTPUT' }),
      item({ type: 'custom_tool_call_output', call_id: 'c', output: 'SECRET-OUTPUT' }),
      item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'THINKING' }] }),
      item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'INJECTED' }] }),
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>INJECTED</environment_context>' }] }),
      item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DUPLICATE' }] }),
      completed({ type: 'Reasoning', id: 'r', summary_text: ['THINKING'], raw_content: [] }),
      completed({ type: 'FileChange', id: 'f', changes: { '/w/a.ts': { type: 'update', unified_diff: '+SECRET' } } }),
      event({ type: 'token_count', info: null }),
      event({ type: 'task_started', turn_id: 'u' }),
      L({ timestamp: T, type: 'session_meta', payload: { id: 'i', cwd: '/w', base_instructions: { text: 'INJECTED' } } }),
      L({ timestamp: T, type: 'turn_context', payload: { cwd: '/w' } }),
      L({ timestamp: T, type: 'world_state', payload: { full: true, state: { agents_md: 'INJECTED' } } }),
      L({ timestamp: T, type: 'token_usage_record', payload: {} }),
      L({ timestamp: T, type: 'compacted', payload: { message: 'SUMMARY' } }),
      L({ timestamp: T, type: 'retained_context', payload: {} }),
      L({ timestamp: T, type: 'security_risk_score', payload: {} }),
      L({ timestamp: T, type: 'inter_agent_communication', payload: {} }),
      L({ timestamp: T, type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }),
      L({ timestamp: T, type: 'realtime_item', payload: {} }),
    ]
    const { rows, stats } = run(skipped)
    expect(rows).toEqual([])
    expect(stats.malformed).toBe(0)
    expect(stats.unknown).toBe(0)
  })

  it('keeps an unknown record type as an unsupported entry with its line (Claude\'s rule), capped', () => {
    const raw = L({ timestamp: T, type: 'brand_new_record', payload: { big: 'y'.repeat(40_000) } })
    const { rows, stats } = run([raw])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ idx: 0, role: 'system', kind: 'unknown', content: '' })
    expect(rows[0].raw!.length).toBeLessThanOrEqual(32 * 1024 + 20)
    expect(stats.unknown).toBe(1)
  })

  it('images in a turn read [image], as Claude\'s do; empty turns make no row', () => {
    const legacy = run([event({ type: 'user_message', message: 'look', images: ['data:image/png;base64,AAAA'], local_images: ['/tmp/a.png'] })]).rows
    expect(legacy[0].content).toBe('look\n\n[image]\n\n[image]')
    const paged = run([completed({ type: 'UserMessage', id: 'm', content: [{ type: 'text', text: 'see this', text_elements: [] }, { type: 'local_image', path: '/tmp/b.png' }] })]).rows
    expect(paged[0].content).toBe('see this\n\n[image]')
    expect(run([event({ type: 'agent_message', message: '   ' })]).rows).toEqual([])
    expect(run([completed({ type: 'AgentMessage', id: 'a', content: [] })]).rows).toEqual([])
  })

  it('never throws; malformed lines count and make no row', () => {
    const { rows, stats } = run([
      '', '   ', '{not json', '[1,2]', 'null', '42',
      L({ timestamp: T, type: 'response_item', payload: null }),
      L({ timestamp: T, type: 'event_msg', payload: 'x' }),
      item({ type: 'function_call', name: 'shell', arguments: '{broken' }),
      completed(null as unknown as object),
      event({ type: 'item_completed' }),
      item({ type: 'custom_tool_call', name: 7, input: { not: 'a string' } }),
    ])
    expect(stats.malformed).toBe(4)
    // The broken-argument calls still make a row, with an empty preview.
    expect(rows.map((r) => [r.kind, r.toolName, r.toolMeta])).toEqual([
      ['tool_call', 'shell', '{}'],
      ['tool_call', '', '{}'],
    ])
  })

  it('carries idx and ts on from where the run already is (a worker restart), and inherits the last ts', () => {
    const { rows } = run([
      L({ type: 'event_msg', payload: { type: 'user_message', message: 'no timestamp' } }),
      event({ type: 'agent_message', message: 'dated' }, '2026-09-27T11:00:00.000Z'),
      L({ type: 'event_msg', payload: { type: 'agent_message', message: 'inherits' } }),
    ], { startIdx: 7, startTs: 1234 })
    expect(rows.map((r) => [r.idx, r.ts])).toEqual([[7, 1234], [8, Date.parse('2026-09-27T11:00:00.000Z')], [9, Date.parse('2026-09-27T11:00:00.000Z')]])
  })
})

describe('the rollout line reader the GitHub Session Context shares (P3.12, row 65)', () => {
  it('reads messages and tool calls, and the files an edit names from every record that names them', () => {
    expect(readCodexRolloutLine(event({ type: 'user_message', message: 'fix #12' }))).toEqual({ ts: Date.parse(T), entries: [{ kind: 'message', role: 'user', text: 'fix #12' }] })
    const fc = readCodexRolloutLine(completed({ type: 'FileChange', id: 'f', changes: { 'C:\\w\\a.ts': { type: 'update', unified_diff: '+x' }, 'C:\\w\\b.ts': { type: 'add', content: 'x' } } }))!
    expect(fc.entries).toEqual([{ kind: 'files', files: [{ path: 'C:\\w\\a.ts', op: 'update' }, { path: 'C:\\w\\b.ts', op: 'add' }] }])
    const legacy = readCodexRolloutLine(event({ type: 'patch_apply_end', call_id: 'c', success: true, changes: { '/w/c.ts': { type: 'delete', content: 'x' } } }))!
    expect(legacy.entries).toEqual([{ kind: 'files', files: [{ path: '/w/c.ts', op: 'delete' }] }])
    const code = readCodexRolloutLine(item({ type: 'custom_tool_call', name: 'exec', call_id: 'e', input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: C:/w/d.ts\\n@@\\n-a\\n+b\\n*** End Patch"));\n' }))!
    expect(code.entries).toEqual([{ kind: 'tool', name: 'exec', edits: [{ path: 'C:/w/d.ts', op: 'update' }] }])
    // A path a call's arguments name is not an edit.
    const read = readCodexRolloutLine(item({ type: 'function_call', name: 'view', call_id: 'v', arguments: JSON.stringify({ path: '/w/e.ts' }) }))!
    expect(read.entries).toEqual([{ kind: 'tool', name: 'view', filePath: '/w/e.ts' }])
    expect(readCodexRolloutLine('{bad')).toBeNull()
  })
})

// P3.12 round 1 (B6): a legacy user_message event carries a kind in some
// builds (user_instructions, environment_context: the context Codex injects);
// only a plain one (or one with no kind) is the user's words.
describe('the Codex rollout normalizer: user_message kinds (P3.12 round 1, B6)', () => {
  it('a user_message of a kind other than plain is not indexed as the user\'s words; plain or no kind is', () => {
    const { rows } = run([
      event({ type: 'user_message', kind: 'user_instructions', message: '# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>be brief</INSTRUCTIONS>' }),
      event({ type: 'user_message', kind: 'environment_context', message: '<environment_context>/w</environment_context>' }),
      event({ type: 'user_message', kind: 'plain', message: 'the real prompt' }),
      event({ type: 'user_message', message: 'a later prompt' }),
    ])
    expect(rows.map((r) => [r.role, r.kind, r.content])).toEqual([
      ['user', 'message', 'the real prompt'],
      ['user', 'message', 'a later prompt'],
    ])
    const read = readCodexRolloutLine(event({ type: 'user_message', kind: 'user_instructions', message: 'x' }))
    expect(read?.entries).toEqual([])
  })
})

describe('the Codex rollout normalizer: records left out by time (P3.12, Y1)', () => {
  it('skips each record the rule says; one divider goes before the next rows kept; a record with no time takes the one before it', () => {
    const at = (ms: number) => new Date(ms).toISOString()
    const n = makeCodexRolloutNormalizer({ skip: (ts) => ts !== null && ts >= 2000 && ts < 4000, skippedLabel: 'OFF' })
    const lines = [
      event({ type: 'user_message', message: 'kept-1' }, at(1000)),
      event({ type: 'user_message', message: 'skipped-1' }, at(2000)),
      L({ type: 'event_msg', payload: { type: 'user_message', message: 'skipped-no-time' } }),
      event({ type: 'user_message', message: 'kept-2' }, at(4000)),
      event({ type: 'user_message', message: 'kept-3' }, at(4100)),
      L({ type: 'event_msg', payload: { type: 'user_message', message: 'kept-no-time' } }),
    ]
    const rows = lines.flatMap((l) => n.push(l))
    expect(rows.map((r) => [r.kind, r.content])).toEqual([['message', 'kept-1'], ['clear', 'OFF'], ['message', 'kept-2'], ['message', 'kept-3'], ['message', 'kept-no-time']])
    expect(rows.map((r) => r.idx)).toEqual([0, 1, 2, 3, 4])
  })
})
