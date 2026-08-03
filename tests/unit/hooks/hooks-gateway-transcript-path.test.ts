/**
 * #180 -- the OTHER source path into the transcript binder.
 *
 * GHSA-hw7c-g5pw-w725 fixed `canonicalizeTranscriptPath`: `path.join` normalises
 * `..` rather than rejecting it, so a transcript path from an untrusted source
 * escaped `~/.claude/projects` and the binder opened whatever it named. The fix
 * put containment at the choke point and added a shape filter to the ONE source
 * traced at the time -- the SSH statusline sentinel.
 *
 * The hooks gateway lifts the same field out of a hook POST body, reaches the
 * same binder, and is read BEFORE redaction. It never got the same look.
 *
 * These tests drive the GATEWAY, not the helper. That distinction is the whole
 * point of the issue: a unit test on `canonicalizeTranscriptPath` cannot see
 * which callers exist, which is exactly how this source path went unexamined.
 * So every case below goes in as an HTTP-shaped request and is checked at the
 * far end -- what the discovery sink received, and what the real containment
 * helper then does with it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as path from 'path'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { HooksGateway, sanitiseTranscriptPath, tokensMatch } from '../../../src/main/hooks/hooks-gateway'
import { canonicalizeTranscriptPath } from '../../../src/main/logging/transcript-discovery'

let gw: HooksGateway | null = null
afterEach(async () => {
  await gw?.stop()
  gw = null
})

/** A started gateway plus the sink the binder would be behind. */
async function gateway(): Promise<{ sink: ReturnType<typeof vi.fn>; secret: string; sid: string }> {
  const sink = vi.fn()
  gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0, onTranscriptPath: sink })
  await gw.start()
  const sid = 'sid-a'
  const secret = gw.registerSession(sid)
  return { sink, secret, sid }
}

/** POST a hook body the way Claude Code does. */
async function post(secret: string, sid: string, body: Record<string, unknown>): Promise<number> {
  const r = await gw!._handleRequestForTest({
    remoteAddress: '127.0.0.1',
    url: `/hook/${sid}`,
    headers: { 'x-ccc-hook-token': secret },
    body: JSON.stringify(body),
  })
  return r.status
}

const REAL = path.join(homedir(), '.claude', 'projects', 'proj', 'conv.jsonl')

describe('transcript_path arriving on a hook POST', () => {
  it('forwards a legitimate path to the discovery sink unchanged', async () => {
    const { sink, secret, sid } = await gateway()
    expect(await post(secret, sid, { hook_event_name: 'SessionStart', transcript_path: REAL })).toBe(200)
    expect(sink).toHaveBeenCalledWith(sid, REAL)
  })

  it('containment holds from THIS entry point: a traversal path is refused downstream', async () => {
    // The gateway deliberately does not re-implement containment -- two copies
    // drift. So this asserts the real end-to-end property: whatever the gateway
    // forwards, the choke point refuses to canonicalise it into a readable file
    // outside the projects directory.
    const { sink, secret, sid } = await gateway()
    const escapes = [
      '/home/u/.claude/projects/../../../../etc/shadow',
      'C:\\Users\\u\\.claude\\projects\\..\\..\\..\\Windows\\win.ini',
      '/home/u/.claude/projects/proj/../../../.ssh/id_ed25519',
    ]
    for (const p of escapes) {
      sink.mockClear()
      expect(await post(secret, sid, { hook_event_name: 'SessionStart', transcript_path: p })).toBe(200)
      const forwarded = sink.mock.calls[0]?.[1] as string | undefined
      expect(forwarded, `gateway dropped ${p} before the binder could contain it`).toBeDefined()
      // The property that matters: the binder cannot turn it into a path outside
      // ~/.claude/projects.
      const canonical = canonicalizeTranscriptPath(forwarded!)
      if (canonical !== null) {
        const root = path.join(homedir(), '.claude', 'projects')
        expect(path.resolve(canonical).startsWith(path.resolve(root))).toBe(true)
      }
    }
  })

  it('drops a non-string transcript_path instead of typeof-checking it into the sink', async () => {
    const { sink, secret, sid } = await gateway()
    for (const v of [42, true, null, {}, [], { toString: () => REAL }]) {
      sink.mockClear()
      expect(await post(secret, sid, { hook_event_name: 'SessionStart', transcript_path: v })).toBe(200)
      expect(sink, `accepted ${JSON.stringify(v)}`).not.toHaveBeenCalled()
    }
  })

  it('drops a path carrying an embedded NUL or control character', async () => {
    // A NUL truncates the path for any native consumer while the JS string keeps
    // going -- two layers disagreeing about where a string ends.
    const { sink, secret, sid } = await gateway()
    for (const v of [`${REAL}\u0000.png`, `${REAL}\n/etc/shadow`, `${REAL}\r`, `\u0000${REAL}`, `${REAL}\u007f`]) {
      sink.mockClear()
      expect(await post(secret, sid, { hook_event_name: 'SessionStart', transcript_path: v })).toBe(200)
      expect(sink, `accepted ${JSON.stringify(v)}`).not.toHaveBeenCalled()
    }
  })

  it('drops an implausibly long path', async () => {
    const { sink, secret, sid } = await gateway()
    const long = `${path.join(homedir(), '.claude', 'projects')}/${'a'.repeat(5000)}.jsonl`
    expect(await post(secret, sid, { hook_event_name: 'SessionStart', transcript_path: long })).toBe(200)
    expect(sink).not.toHaveBeenCalled()
  })

  it('still ingests the event when the path is dropped', async () => {
    // Dropping the field must not drop the hook: the transcript is also
    // discovered heuristically, so a rejected value costs a slower discovery,
    // never a lost event.
    const emit = vi.fn()
    const sink = vi.fn()
    gw = new HooksGateway({ emit, defaultPort: 0, onTranscriptPath: sink })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    expect(await post(secret, 'sid-a', { hook_event_name: 'PreToolUse', tool_name: 'Bash', transcript_path: 12345 })).toBe(200)
    expect(sink).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalled()
  })

  it('a throwing discovery sink does not break ingestion', async () => {
    const emit = vi.fn()
    gw = new HooksGateway({
      emit,
      defaultPort: 0,
      onTranscriptPath: () => { throw new Error('binder exploded') },
    })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    expect(await post(secret, 'sid-a', { hook_event_name: 'SessionStart', transcript_path: REAL })).toBe(200)
    expect(emit).toHaveBeenCalled()
  })
})

describe('sanitiseTranscriptPath', () => {
  // The helper's own unit tests. Kept alongside the gateway ones rather than
  // instead of them -- the issue's point is that helper coverage is not caller
  // coverage.
  it('accepts a real path', () => {
    expect(sanitiseTranscriptPath(REAL)).toBe(REAL)
  })

  it('rejects a non-string, empty, oversized, or control-bearing value', () => {
    expect(sanitiseTranscriptPath(undefined)).toBeNull()
    expect(sanitiseTranscriptPath(null)).toBeNull()
    expect(sanitiseTranscriptPath(1)).toBeNull()
    expect(sanitiseTranscriptPath('')).toBeNull()
    expect(sanitiseTranscriptPath('a'.repeat(4097))).toBeNull()
    expect(sanitiseTranscriptPath('a\u0000b')).toBeNull()
    expect(sanitiseTranscriptPath('a\tb')).toBeNull()
  })

  it('accepts exactly at the bound', () => {
    expect(sanitiseTranscriptPath('a'.repeat(4096))).toHaveLength(4096)
  })

  it('does NOT try to do containment', () => {
    // Deliberate: containment lives at the choke point. A shape filter that also
    // half-implements containment is how the two copies drift apart.
    expect(sanitiseTranscriptPath('/etc/shadow')).toBe('/etc/shadow')
  })
})

describe('the hook token comparison', () => {
  it('accepts the right token and rejects a wrong one of the same length', async () => {
    const { secret, sid } = await gateway()
    expect(await post(secret, sid, { hook_event_name: 'SessionStart' })).toBe(200)
    const wrong = `${'0'.repeat(secret.length - 1)}1`
    expect(wrong).toHaveLength(secret.length)
    expect(await post(wrong, sid, { hook_event_name: 'SessionStart' })).toBe(404)
  })

  it('rejects tokens of a different length without throwing', async () => {
    // timingSafeEqual throws on unequal-length buffers, so the length guard has
    // to run first. Without it these are 500s, not 404s.
    const { secret, sid } = await gateway()
    for (const t of ['', 'x', `${secret}x`, secret.slice(0, -1)]) {
      expect(await post(t, sid, { hook_event_name: 'SessionStart' }), `token ${JSON.stringify(t)}`).toBe(404)
    }
  })

  it('rejects a missing token header', async () => {
    const { sid } = await gateway()
    const r = await gw!._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: `/hook/${sid}`,
      headers: {},
      body: '{}',
    })
    expect(r.status).toBe(404)
  })

  it('tokensMatch refuses an empty secret rather than authenticating on it', () => {
    // timingSafeEqual(<empty>, <empty>) is TRUE, so without the guard a session
    // whose secret failed to generate would accept an empty token. preBufferAuth
    // rejects a missing secret before this is reached, so it is defence in depth
    // -- which is exactly the kind of guard that gets deleted as "unreachable".
    expect(tokensMatch('', '')).toBe(false)
    expect(tokensMatch('anything', '')).toBe(false)
    expect(tokensMatch('', 'anything')).toBe(false)
  })

  it('tokensMatch is length-guarded and value-correct', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abd')).toBe(false)
    // Unequal lengths must not throw out of timingSafeEqual.
    expect(() => tokensMatch('abc', 'abcd')).not.toThrow()
    expect(tokensMatch('abc', 'abcd')).toBe(false)
  })

  it('compares the token in CONSTANT TIME, asserted at the source', () => {
    // A timing property cannot be observed from a unit test: `!==` returns the
    // same verdict, just not in constant time, so every behavioural test passes
    // against it. This repo already uses a source-level assertion for exactly
    // that situation (the `shell: false` check in the resume-picker tests), so
    // the same tool applies here.
    const src = readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'main', 'hooks', 'hooks-gateway.ts'),
      'utf-8',
    )
    // Scoped to code lines so the rationale comments -- which say the words
    // "token !== expected" while explaining why not to -- cannot trip it.
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(code).toContain('tokensMatch(token, expected)')
    expect(code).not.toMatch(/token\s*!==\s*expected/)
    expect(code).toContain('timingSafeEqual')
  })
})
