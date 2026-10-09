import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { makeCodexRolloutNormalizer } from '../../../src/main/logging/codex-rollout-normalizer'

// Helper module is plain Node.js (CommonJS); use require() to import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as {
  parseRollout: (text: string) => null | { id: string; cwd: string; model: string; effort?: string; label: string }
  walkRollouts: (home: string, maxDays: number, cwd: string) => Array<{ id: string; cwd: string; model: string; effort?: string; label: string; mtime: number }>
  buildResumeArgs: (uuid: string | null, flags: string[]) => string[]
  shouldFallback: (resumeUuid: string | null, exitStatus: number | null | undefined) => boolean
  shouldUseShell: (cmd: string, platform: string) => boolean
  launchTarget: (cmd: string, args: string[], platform: string, env: Record<string, string | undefined>, cwd?: string) => null | { file: string; args: string[] }
  isResumeId: (id: unknown) => boolean
}

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'codex-rollouts')

describe('codex-resume-picker parseRollout', () => {
  it('returns id/cwd/model/effort/label for a matching-cwd rollout', () => {
    const text = readFileSync(join(FIXTURES, 'matching-cwd.jsonl'), 'utf-8')
    const r = lib.parseRollout(text)
    expect(r).not.toBeNull()
    expect(r!.id).toBe('019dd000-0001-7000-0000-000000000001')
    expect(r!.cwd).toBe('F:\\test\\fixture-cwd')
    expect(r!.model).toBe('gpt-5.5')
    expect(r!.effort).toBe('xhigh')
    expect(r!.label).toBe('refactor the auth module')
  })

  it('extracts cwd from session_meta even when turn_context is missing', () => {
    // Single-line file with only session_meta.
    const text = '{"type":"session_meta","payload":{"id":"u-1","cwd":"/some/cwd","cli_version":"0.128.0"}}\n'
    const r = lib.parseRollout(text)
    expect(r).not.toBeNull()
    expect(r!.cwd).toBe('/some/cwd')
    expect(r!.label).toBe('(continued session)')
  })

  it('returns null when first line is malformed', () => {
    const text = readFileSync(join(FIXTURES, 'malformed.jsonl'), 'utf-8')
    const r = lib.parseRollout(text)
    expect(r).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(lib.parseRollout('')).toBeNull()
  })

  it('extracts label from response_item / role=user / input_text (codex 0.133 format)', () => {
    // P9.7 regression: codex CLI's rollout format changed from
    // event_msg/user_message to response_item/message/role=user/input_text
    // between 0.128 and 0.133. Without this support every session showed
    // "(continued session)" in the picker.
    const text = readFileSync(join(FIXTURES, 'response-item-format.jsonl'), 'utf-8')
    const r = lib.parseRollout(text)
    expect(r).not.toBeNull()
    expect(r!.cwd).toBe('F:\\test\\fixture-cwd')
    expect(r!.model).toBe('gpt-5.5')
    expect(r!.effort).toBe('medium')
    // Skips the Codex-injected <environment_context> wrapper user-message and
    // picks the first real user input as the label.
    expect(r!.label).toBe('add a new auth endpoint with rate limiting')
  })

  it('skips XML-wrapped user content (environment_context, collaboration_mode, etc.)', () => {
    const lines = [
      '{"type":"session_meta","payload":{"id":"u-3","cwd":"/x","cli_version":"0.133"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>foo</environment_context>"}]}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<collaboration_mode>bar</collaboration_mode>"}]}}',
    ].join('\n')
    const r = lib.parseRollout(lines)
    expect(r).not.toBeNull()
    // Both user inputs are wrapper tags -- label stays the default.
    expect(r!.label).toBe('(continued session)')
  })

  it('caps very long user inputs at 200 chars', () => {
    const longText = 'a'.repeat(500)
    const lines = [
      '{"type":"session_meta","payload":{"id":"u-4","cwd":"/x","cli_version":"0.133"}}',
      `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"${longText}"}]}}`,
    ].join('\n')
    const r = lib.parseRollout(lines)
    expect(r).not.toBeNull()
    expect(r!.label.length).toBe(200)
  })

  it('finds turn_context even when not on line 2', () => {
    // session_meta on line 1, then noise, then turn_context on line 4
    const lines = [
      '{"type":"session_meta","payload":{"id":"u-2","cwd":"/x","cli_version":"0.1"}}',
      '{"type":"event_msg","payload":{"type":"task_started"}}',
      '{"type":"response_item","payload":{"type":"message"}}',
      '{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}',
    ].join('\n')
    const r = lib.parseRollout(lines)
    expect(r).not.toBeNull()
    expect(r!.model).toBe('gpt-5.4')
    expect(r!.effort).toBe('high')
  })
})

describe('codex-resume-picker walkRollouts', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ccc-codex-walk-'))
    // Layout under home/sessions/YYYY/MM/DD/rollout-*.jsonl
    const today = new Date()
    const y = String(today.getUTCFullYear())
    const m = String(today.getUTCMonth() + 1).padStart(2, '0')
    const d = String(today.getUTCDate()).padStart(2, '0')
    const dir = join(home, 'sessions', y, m, d)
    mkdirSync(dir, { recursive: true })
    // Two matching, one non-matching
    copyFileSync(join(FIXTURES, 'matching-cwd.jsonl'), join(dir, 'rollout-001-aaa.jsonl'))
    copyFileSync(join(FIXTURES, 'matching-cwd.jsonl'), join(dir, 'rollout-002-bbb.jsonl'))
    copyFileSync(join(FIXTURES, 'non-matching-cwd.jsonl'), join(dir, 'rollout-003-ccc.jsonl'))
  })

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  })

  it('filters to matching cwd only', () => {
    const out = lib.walkRollouts(home, 30, 'F:\\test\\fixture-cwd')
    expect(out).toHaveLength(2)
    for (const r of out) expect(r.cwd).toBe('F:\\test\\fixture-cwd')
  })

  it('returns empty array when no rollouts match', () => {
    const out = lib.walkRollouts(home, 30, 'F:\\unrelated\\cwd')
    expect(out).toHaveLength(0)
  })

  it('returns empty array when sessions dir does not exist', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ccc-codex-empty-'))
    try {
      const out = lib.walkRollouts(empty, 30, 'F:\\anything')
      expect(out).toHaveLength(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('codex-resume-picker buildResumeArgs', () => {
  const UUID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
  it('prepends `resume <uuid>` then forwards flags when uuid is given', () => {
    const flags = ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=xhigh', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
    const out = lib.buildResumeArgs(UUID, flags)
    expect(out[0]).toBe('resume')
    expect(out[1]).toBe(UUID)
    expect(out.slice(2)).toEqual(flags)
  })

  it('returns just the flags when uuid is null (fresh session)', () => {
    const flags = ['-m', 'gpt-5.5']
    const out = lib.buildResumeArgs(null, flags)
    expect(out).toEqual(flags)
  })

  it('an id that is not a UUID -- read from a transcript, so anything -- starts a fresh session, never an argument', () => {
    const flags = ['-m', 'gpt-5.5']
    for (const bad of ['uuid-abc', '--dangerously-bypass-approvals-and-sandbox', '-c', 'x & calc', UUID + 'x']) {
      expect(lib.buildResumeArgs(bad, flags), bad).toEqual(flags)
    }
  })
})

describe('codex-resume-picker shouldFallback', () => {
  it('returns true when resume was attempted and exited non-zero', () => {
    expect(lib.shouldFallback('uuid-abc', 1)).toBe(true)
    expect(lib.shouldFallback('uuid-abc', 127)).toBe(true)
  })

  it('returns false when resume was attempted and exited 0', () => {
    expect(lib.shouldFallback('uuid-abc', 0)).toBe(false)
  })

  it('returns false when resume was not attempted (uuid null), regardless of exitStatus', () => {
    expect(lib.shouldFallback(null, 1)).toBe(false)
    expect(lib.shouldFallback(null, 0)).toBe(false)
  })

  it('returns false when exitStatus is null (spawn failure -- fresh fallback would also fail)', () => {
    expect(lib.shouldFallback('uuid-abc', null)).toBe(false)
  })

  it('returns false when exitStatus is undefined (defensive, same reasoning as null)', () => {
    expect(lib.shouldFallback('uuid-abc', undefined)).toBe(false)
  })
})

describe('codex-resume-picker shouldUseShell', () => {
  it('returns false on linux for any cmd (including .exe paths)', () => {
    expect(lib.shouldUseShell('/usr/local/bin/codex.exe', 'linux')).toBe(false)
  })

  it('returns false on darwin for a bare command name', () => {
    expect(lib.shouldUseShell('codex', 'darwin')).toBe(false)
  })

  it('returns false on win32 when cmd ends with .exe', () => {
    expect(lib.shouldUseShell('C:\\path\\codex.exe', 'win32')).toBe(false)
  })

  it('returns true on win32 when cmd ends with .cmd', () => {
    expect(lib.shouldUseShell('C:\\path\\codex.cmd', 'win32')).toBe(true)
  })

  it('returns true on win32 with uppercase .CMD (case insensitive)', () => {
    expect(lib.shouldUseShell('C:\\path\\codex.CMD', 'win32')).toBe(true)
  })

  it('returns true on win32 when cmd ends with .bat', () => {
    expect(lib.shouldUseShell('C:\\path\\codex.bat', 'win32')).toBe(true)
  })
})

// WP2: the picker starts the executable the app proved, never through a
// shell option, and resumes only a conversation id that is a UUID.
describe('codex-resume-picker launchTarget', () => {
  const env = { SystemRoot: 'C:\\Windows' }
  // The folder the shim starts in (a drive folder; a network one is refused,
  // codex-resume-picker-network-folder.test.ts).
  const HERE = 'C:\\project'
  it('runs an executable directly, with its arguments untouched', () => {
    expect(lib.launchTarget('/usr/bin/codex', ['resume', 'x'], 'linux', env)).toEqual({ file: '/usr/bin/codex', args: ['resume', 'x'], verbatim: false })
    expect(lib.launchTarget('C:\\a\\codex.exe', ['-m', 'gpt-5.5'], 'win32', env)).toEqual({ file: 'C:\\a\\codex.exe', args: ['-m', 'gpt-5.5'], verbatim: false })
  })

  it('runs a .cmd shim through cmd.exe named by absolute path, in the /s form, as one verbatim line', () => {
    expect(lib.launchTarget('C:\\npm\\codex.cmd', ['-m', 'gpt-5.5'], 'win32', env, HERE)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\npm\\codex.cmd" -m gpt-5.5"'],
      verbatim: true,
    })
    // Spaces and parentheses in the shim's folder survive the /s form.
    expect(lib.launchTarget('C:\\Program Files (x86)\\nodejs\\codex.cmd', [], 'win32', env, HERE)?.args[4]).toBe('""C:\\Program Files (x86)\\nodejs\\codex.cmd""')
    // The parent's own spelling (Git Bash exports SYSTEMROOT).
    expect(lib.launchTarget('C:\\npm\\codex.cmd', [], 'win32', { SYSTEMROOT: 'C:\\WINDOWS' }, HERE)?.file).toBe('C:\\WINDOWS\\System32\\cmd.exe')
  })

  it('refuses what cmd.exe or the shim would reinterpret, and a cmd.exe it cannot name absolutely', () => {
    for (const bad of ['"', '%', '&', '^', '|', '<', '>', '!', '(', ')', ' ', '\n']) {
      expect(lib.launchTarget('C:\\npm\\codex.cmd', ['resume', `x${bad}y`], 'win32', env, HERE), JSON.stringify(bad)).toBeNull()
    }
    for (const bad of ['"', '%', '&', '^']) {
      expect(lib.launchTarget(`C:\\a${bad}b\\codex.cmd`, [], 'win32', env, HERE), JSON.stringify(bad)).toBeNull()
    }
    expect(lib.launchTarget('codex.cmd', [], 'win32', env, HERE)).toBeNull()
    for (const root of [undefined, '', 'Windows', 'C:Windows']) {
      expect(lib.launchTarget('C:\\npm\\codex.cmd', [], 'win32', { SystemRoot: root }, HERE), String(root)).toBeNull()
    }
  })
})

describe('codex-resume-picker isResumeId', () => {
  it('accepts a UUID and nothing else', () => {
    expect(lib.isResumeId('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe(true)
    for (const bad of ['uuid-abc', '', 'x & calc', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b&x', null, undefined, 42]) {
      expect(lib.isResumeId(bad), String(bad)).toBe(false)
    }
  })
})

// P3.12 round 1 (V3): the picker titles a conversation by its first user
// message as the conversation index reads it (codex-rollout-normalizer): the
// user's words from the events (legacy user_message of a plain kind,
// paginated item_completed UserMessage), never the response items that carry
// the context Codex injects (AGENTS.md, the environment). As Codex's own
// /resume does. Only a head with no such event falls back to the response
// items, skipping injected context there too.
describe('codex-resume-picker parseRollout: the first user message as the index reads it (P3.12 round 1, V3)', () => {
  const T = '2026-09-30T10:00:00.000Z'
  const L = (o: object) => JSON.stringify(o)
  const meta = L({ timestamp: T, type: 'session_meta', payload: { id: '019dd000-0001-7000-8000-00000000c0de', cwd: 'C:\\dev\\harbor' } })
  const AGENTS = '# AGENTS.md instructions for C:\\dev\\harbor\n\n<INSTRUCTIONS>\nAlways answer in French.\n</INSTRUCTIONS>'
  const injected = L({ timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: AGENTS }] } })
  const env = L({ timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>C:\\dev\\harbor</cwd></environment_context>' }] } })
  const said = (text: string) => L({ timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const paginated = (text: string) => L({ timestamp: T, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } } })
  const legacy = (message: string, kind?: string) => L({ timestamp: T, type: 'event_msg', payload: { type: 'user_message', message, ...(kind ? { kind } : {}) } })
  const firstUserOfIndex = (ls: string[]): string | undefined => {
    const n = makeCodexRolloutNormalizer()
    for (const l of ls) for (const r of n.push(l)) if (r.role === 'user' && r.kind === 'message') return r.content.replace(/[\r\n]+/g, ' ').trim()
    return undefined
  }

  const CASES: Record<string, string[]> = {
    'AGENTS.md then a paginated prompt (0.155.1 shape)': [meta, injected, env, said('fix the flaky test'), paginated('fix the flaky test')],
    'AGENTS.md then a legacy prompt': [meta, injected, env, said('fix the flaky test'), legacy('fix the flaky test')],
    'a legacy user_instructions event, then a plain one (B6)': [meta, legacy(AGENTS, 'user_instructions'), legacy('<environment_context>x</environment_context>', 'environment_context'), legacy('fix the flaky test', 'plain')],
  }

  it('an AGENTS.md-shaped first message is never the title; the real first prompt is', () => {
    for (const [name, ls] of Object.entries(CASES)) {
      const r = lib.parseRollout(ls.join('\n') + '\n')
      expect(r, name).not.toBeNull()
      expect(r!.label, name).toBe('fix the flaky test')
    }
  })

  it('the same title as the index\'s first user message, for the real rollouts and every case above (images too)', () => {
    const real = [
      join(__dirname, '..', '..', 'fixtures', 'codex', 'cli', '0.155.1', 'rollout-edit.jsonl'),
      join(__dirname, '..', '..', 'fixtures', 'codex', 'cli', '0.153.4', 'rollout-exec-then-resume.jsonl'),
      join(__dirname, '..', '..', 'fixtures', 'codex', 'rollout-sample.jsonl'),
    ].map((f) => readFileSync(f, 'utf-8').split(/\r?\n/).filter(Boolean))
    const images = [
      [meta, injected, L({ timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'what is this', images: ['data:image/png;base64,AA=='], local_images: [] } })],
      [meta, injected, L({ timestamp: T, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'and this' }, { type: 'local_image', path: 'a.png' }] } } })],
    ]
    for (const ls of [...real, ...Object.values(CASES), ...images]) {
      const expected = firstUserOfIndex(ls)
      expect(expected).toBeTruthy()
      expect(lib.parseRollout(ls.join('\n') + '\n')!.label).toBe(expected)
    }
  })

  it('a head with no user event falls back to the response items, skipping injected context (AGENTS.md too)', () => {
    const r = lib.parseRollout([meta, injected, env, said('fix the flaky test')].join('\n') + '\n')
    expect(r!.label).toBe('fix the flaky test')
    const only = lib.parseRollout([meta, injected, env].join('\n') + '\n')
    expect(only!.label).toBe('(continued session)')
  })
})

// P3.12 round 2 (Q2): the picker's title rule and the index read the same
// records alike: for every record list here, the title is the index's first
// user message; where the index has none, the title is never injected context.
describe('codex-resume-picker parseRollout and the index: the same records, the same first user message (P3.12 round 2, Q2)', () => {
  const L = (o: object) => JSON.stringify(o)
  const meta = L({ type: 'session_meta', payload: { id: '019dd000-0001-7000-8000-000000000301', cwd: '/w' } })
  const ri = (text: string) => L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const um = (message: string, extra: Record<string, unknown> = {}) => L({ type: 'event_msg', payload: { type: 'user_message', message, ...extra } })
  const uc = (content: unknown[]) => L({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content } } })
  const indexFirst = (ls: string[]): string | undefined => {
    const n = makeCodexRolloutNormalizer()
    for (const l of ls) for (const r of n.push(l)) if (r.role === 'user' && r.kind === 'message') return r.content.replace(/[\r\n]+/g, ' ').trim()
    return undefined
  }
  const CASES: Record<string, string[]> = {
    agents_ri_then_event: [ri('# AGENTS.md instructions for /w\n<INSTRUCTIONS>rules</INSTRUCTIONS>'), ri('<environment_context>x</environment_context>'), um('real prompt')],
    agents_as_event_no_kind: [um('# AGENTS.md instructions for /w <INSTRUCTIONS>rules</INSTRUCTIONS>')],
    agents_as_event_kind: [um('# AGENTS.md instructions for /w', { kind: 'user_instructions' }), um('real prompt 2')],
    env_event_kind: [um('<environment_context>x</environment_context>', { kind: 'environment_context' }), um('real 3')],
    plain_kind: [um('plain one', { kind: 'plain' })],
    blank_then_real: [um('   '), uc([{ type: 'text', text: '' }]), uc([{ type: 'text', text: 'second try' }])],
    images_only: [um('', { images: ['a', 'b'] })],
    text_and_image: [uc([{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'x' }])],
    multiline: [um('line one\r\nline two\n\nline three')],
    fallback_only_injected: [ri('# AGENTS.md instructions for /w'), ri('<environment_context>')],
  }

  it('the title is the index\'s first user message, record for record', () => {
    for (const [name, ls] of Object.entries(CASES)) {
      const lines = [meta, ...ls]
      const index = indexFirst(lines)
      const title = lib.parseRollout(lines.join('\n') + '\n')!.label
      if (index !== undefined) expect(title, name).toBe(index)
      else expect(title, name).toBe('(continued session)')
    }
  })
})
