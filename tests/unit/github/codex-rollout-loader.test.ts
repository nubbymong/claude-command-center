/**
 * P3.12 (row 65): the GitHub Session Context of a Codex session reads the
 * rollout its own watcher holds, in its own realm, as Claude's reads the newest
 * transcript of its project folder: the user's and the assistant's words (for
 * the opt-in issue-reference scan) and the tool calls (for the file-signal
 * inspector: a shell command as `Bash`, a file an edit names as `Edit` or
 * `Write`). The same bounded tail as Claude's loader. The rollout is checked
 * again before it is read: inside that realm's sessions folder, every folder a
 * real one, a plain `rollout-*.jsonl`, the file opened the one looked at.
 * Real files in a fresh temp folder that only this test removes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCodexRolloutEvents, loadSessionTranscriptEvents } from '../../../src/main/github/session/codex-rollout-loader'
import { extractFileSignals } from '../../../src/main/github/session/tool-call-inspector'
import { scanTranscriptMessages } from '../../../src/main/github/session/transcript-scanner'

let root: string
let sessions: string
let day: string
const ID = '019dd000-0001-7000-8000-00000000000a'
const now = () => new Date().toISOString()
const L = (o: object) => JSON.stringify(o)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccc-p312-ghctx-'))
  sessions = join(root, 'sessions')
  day = join(sessions, '2026', '09', '29')
  mkdirSync(day, { recursive: true })
})
afterEach(() => {
  if (basename(root).startsWith('ccc-p312-ghctx-') && dirname(root) === tmpdir()) rmSync(root, { recursive: true, force: true })
})

function writeRollout(lines: string[], dir = day): string {
  const f = join(dir, `rollout-2026-09-29T10-00-00-${ID}.jsonl`)
  writeFileSync(f, lines.join('\n') + '\n')
  return f
}
const conversation = () => [
  L({ timestamp: now(), type: 'session_meta', payload: { id: ID, cwd: '/w' } }),
  L({ timestamp: now(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>see #999</environment_context>' }] } }),
  L({ timestamp: now(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'please fix #42' }] } } }),
  L({ timestamp: now(), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c', arguments: JSON.stringify({ command: ['bash', '-lc', 'git add src/app.ts'] }) } }),
  L({ timestamp: now(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p', input: '*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** End Patch\n' } }),
  L({ timestamp: now(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f', changes: { 'src/old.ts': { type: 'update', unified_diff: '+SECRET-DIFF' } } } } }),
  L({ timestamp: now(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'SECRET-OUTPUT #777' } }),
  L({ timestamp: now(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: 'done, see GH-7' }] } } }),
]

describe('the GitHub Session Context of a Codex session (P3.12, row 65)', () => {
  it('reads the conversation and tool calls of the session\'s rollout; never injected context, tool output or a diff', async () => {
    const f = writeRollout(conversation())
    const ev = await loadCodexRolloutEvents({ path: f, sessionsDir: sessions })
    expect(ev.messages.map((m) => [m.role, m.text])).toEqual([['user', 'please fix #42'], ['assistant', 'done, see GH-7']])
    expect(ev.toolCalls.map((t) => [t.tool, t.args])).toEqual([
      ['Bash', { command: 'git add src/app.ts' }],
      ['Write', { file_path: 'src/new.ts' }],
      ['Edit', { file_path: 'src/old.ts' }],
    ])
    const all = JSON.stringify(ev)
    for (const hidden of ['#999', 'SECRET-DIFF', 'SECRET-OUTPUT', '#777']) expect(all).not.toContain(hidden)
    // Through the unchanged scanner and inspector.
    expect(scanTranscriptMessages(ev.messages).map((r) => r.number)).toEqual([42, 7])
    expect(extractFileSignals(ev.toolCalls).map((s) => [s.filePath, s.tool]).sort()).toEqual([['src/app.ts', 'Bash'], ['src/new.ts', 'Write'], ['src/old.ts', 'Edit']])
  })

  it('reads nothing without a rollout, or from anything that is not a rollout of that realm\'s own real folders', async () => {
    const empty = { messages: [], toolCalls: [] }
    expect(await loadCodexRolloutEvents(null)).toEqual(empty)
    const f = writeRollout(conversation())
    // Another realm's sessions folder than the rollout's.
    const other = join(root, 'other', 'sessions')
    mkdirSync(other, { recursive: true })
    expect(await loadCodexRolloutEvents({ path: f, sessionsDir: other })).toEqual(empty)
    // Not a rollout file name.
    const notes = join(day, 'notes.jsonl')
    writeFileSync(notes, conversation().join('\n') + '\n')
    expect(await loadCodexRolloutEvents({ path: notes, sessionsDir: sessions })).toEqual(empty)
    // Not in a YYYY/MM/DD day folder.
    const shallow = join(sessions, `rollout-2026-09-29T10-00-00-${ID}.jsonl`)
    writeFileSync(shallow, conversation().join('\n') + '\n')
    expect(await loadCodexRolloutEvents({ path: shallow, sessionsDir: sessions })).toEqual(empty)
    // In folders that are not a YYYY/MM/DD day folder.
    const notDay = join(sessions, 'notes', 'aa', 'bb')
    mkdirSync(notDay, { recursive: true })
    const odd = join(notDay, `rollout-2026-09-29T10-00-00-${ID}.jsonl`)
    writeFileSync(odd, conversation().join('\n') + '\n')
    expect(await loadCodexRolloutEvents({ path: odd, sessionsDir: sessions })).toEqual(empty)
    // A relative sessions folder, or a path that climbs out.
    expect(await loadCodexRolloutEvents({ path: f, sessionsDir: 'sessions' })).toEqual(empty)
    expect(await loadCodexRolloutEvents({ path: join(day, '..', '..', '..', '..', 'x', basename(f)), sessionsDir: sessions })).toEqual(empty)
    // A folder, not a file.
    const asDir = join(day, `rollout-2026-09-29T11-00-00-${ID}.jsonl`)
    mkdirSync(asDir)
    expect(await loadCodexRolloutEvents({ path: asDir, sessionsDir: sessions })).toEqual(empty)
  })

  it('a day folder that is a junction or link to another folder is not followed', async () => {
    const real = join(root, 'elsewhere', '29')
    mkdirSync(real, { recursive: true })
    const linked = join(sessions, '2026', '10', '01')
    mkdirSync(dirname(linked), { recursive: true })
    symlinkSync(real, linked, 'junction')
    const f = writeRollout(conversation(), real)
    const viaLink = join(linked, basename(f))
    expect(await loadCodexRolloutEvents({ path: viaLink, sessionsDir: sessions })).toEqual({ messages: [], toolCalls: [] })
  })

  it('reads at most the last 1 MB, whole lines only: a turn further back than that is not read, however few lines follow it', async () => {
    const big = L({ timestamp: now(), type: 'world_state', payload: { pad: 'x'.repeat(20_000) } })
    const lines = [conversation()[2]]
    for (let i = 0; i < 80; i++) lines.push(big)
    lines.push(L({ timestamp: now(), type: 'event_msg', payload: { type: 'agent_message', message: 'last' } }))
    const f = writeRollout(lines)
    const ev = await loadCodexRolloutEvents({ path: f, sessionsDir: sessions })
    expect(ev.messages.map((m) => m.text)).toEqual(['last'])
  })

  it('reads the same bounded tail as Claude\'s loader: at most the last 1 MB, whole lines only, the last 500 of them', async () => {
    const filler = L({ timestamp: now(), type: 'world_state', payload: { pad: 'x'.repeat(2000) } })
    const lines = [conversation()[2]]
    for (let i = 0; i < 700; i++) lines.push(filler)
    for (let i = 0; i < 600; i++) lines.push(L({ timestamp: now(), type: 'event_msg', payload: { type: 'agent_message', message: `m${i}` } }))
    const f = writeRollout(lines)
    const ev = await loadCodexRolloutEvents({ path: f, sessionsDir: sessions })
    // The early user turn is past the tail; the last 500 lines are the last 500 messages.
    expect(ev.messages.some((m) => m.text === 'please fix #42')).toBe(false)
    expect(ev.messages.length).toBe(500)
    expect(ev.messages.at(-1)!.text).toBe('m599')
    expect(ev.messages[0].text).toBe('m100')
  })
})

describe('which transcript a session\'s context reads (P3.12, row 65)', () => {
  it('a Codex session: the rollout its watcher holds, never Claude\'s project folder; none held: nothing', async () => {
    const f = writeRollout(conversation())
    const claude = vi.fn(async () => ({ messages: [{ role: 'user', text: 'CLAUDE', ts: 0 }], toolCalls: [] }))
    const ev = await loadSessionTranscriptEvents({ id: 's1', provider: 'codex', workingDirectory: '/w' }, (sid) => (sid === 's1' ? { path: f, sessionsDir: sessions } : null), claude)
    expect(ev.messages.map((m) => m.text)).toEqual(['please fix #42', 'done, see GH-7'])
    const none = await loadSessionTranscriptEvents({ id: 's2', provider: 'codex', workingDirectory: '/w' }, () => null, claude)
    expect(none).toEqual({ messages: [], toolCalls: [] })
    expect(claude).not.toHaveBeenCalled()
  })

  it('a Claude session (or one with no provider recorded): Claude\'s loader with its folder, as before', async () => {
    const claude = vi.fn(async () => ({ messages: [], toolCalls: [] }))
    const codexFor = vi.fn(() => null)
    await loadSessionTranscriptEvents({ id: 's1', provider: 'claude', workingDirectory: '/w' }, codexFor, claude)
    await loadSessionTranscriptEvents({ id: 's2', workingDirectory: '/v' }, codexFor, claude)
    await loadSessionTranscriptEvents(undefined, codexFor, claude)
    expect(claude.mock.calls).toEqual([['/w'], ['/v'], [undefined]])
    expect(codexFor).not.toHaveBeenCalled()
  })
})
