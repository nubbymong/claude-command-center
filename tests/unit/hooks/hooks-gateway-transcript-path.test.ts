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
import { logWarn } from '../../../src/main/debug-logger'
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

  it('measures the bound in BYTES, so astral characters cannot quadruple it', async () => {
    // 4096 UTF-16 code units of astral characters is 16 KiB of UTF-8 — a
    // code-unit bound reads 4x tighter than it is.
    const { sink, secret, sid } = await gateway()
    const astral = '\u{1F600}'.repeat(2048)   // 4096 code units, 8192 bytes
    expect(astral.length).toBe(4096)
    expect(await post(secret, sid, { hook_event_name: 'SessionStart', transcript_path: astral })).toBe(200)
    expect(sink).not.toHaveBeenCalled()
  })

  it('logs the DROP by type and length, never the value', async () => {
    // The value is remote-influenced and this runs BEFORE redaction, so the log
    // line must not carry it. A silent drop is also wrong: it looks identical to
    // "Claude did not send one", and the two have different diagnoses.
    const { secret, sid } = await gateway()
    // logWarn is mocked globally in tests/unit/setup.ts and NOT reset between
    // tests here, so earlier drops in this file would otherwise be found first.
    vi.mocked(logWarn).mockClear()
    const marker = 'MARKER_THAT_MUST_NOT_BE_LOGGED'
    const rejected = `${path.join(homedir(), '.claude', 'projects')}/${marker}\u0000.jsonl`
    expect(await post(secret, sid, { hook_event_name: 'SessionStart', transcript_path: rejected })).toBe(200)
    const lines = vi.mocked(logWarn).mock.calls.map((c) => String(c[0]))
    const drop = lines.find((l) => l.includes('transcript_path'))
    expect(drop, 'the drop was not logged at all').toBeDefined()
    expect(drop).toContain('length=')
    expect(drop).toContain('type=string')
    expect(drop).not.toContain(marker)
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

  it('compares the token in CONSTANT TIME, asserted inside the function body', () => {
    // A timing property cannot be observed from a unit test: `===` returns the
    // same verdict, just not in constant time, so every behavioural test passes
    // against it. This repo already uses a source-level assertion for exactly
    // that situation (the `shell: false` check in the resume-picker tests).
    //
    // Scoped to the BODY of tokensMatch, not the file. A file-wide
    // `toContain('timingSafeEqual')` is satisfied by the IMPORT LINE alone — so
    // the first version of this assertion passed against a `return presented ===
    // expected` body, which the adversarial pass demonstrated across all 3191
    // tests. That is the exact "test that cannot fail" this repo keeps paying for.
    const src = readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'main', 'hooks', 'hooks-gateway.ts'),
      'utf-8',
    )
    const body = src.match(/export function tokensMatch[\s\S]*?\n}/)?.[0]
    expect(body, 'tokensMatch not found — did it get renamed?').toBeDefined()
    // Strip comments so the rationale text cannot satisfy or trip the assertions.
    const code = body!
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(code).toContain('timingSafeEqual(')
    // No short-circuit on the secret itself, in either direction.
    expect(code).not.toMatch(/presented\s*[!=]==\s*expected/)
    expect(code).not.toMatch(/expected\s*[!=]==\s*presented/)
    // ...and the call site actually goes through it.
    const callSite = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')
    expect(callSite).toContain('tokensMatch(token, expected)')
    expect(callSite).not.toMatch(/token\s*!==\s*expected/)
  })
})

describe('what else arrives unvalidated on this route (#180)', () => {
  it('bounds event, toolName and the derived summary', async () => {
    // hooks-types.ts documents a hard per-session ceiling: RING_BUFFER_CAP
    // entries times a ~8 KiB bounded payload. That was only true of `payload` --
    // these three sat OUTSIDE boundPayloadForFeed, and `summary` is built from
    // the UNbounded payload, so a 1 MiB body produced a ~2 MB ring entry and the
    // documented ceiling was off by three orders of magnitude.
    const { secret, sid } = await gateway()
    const huge = 'A'.repeat(500_000)
    expect(await post(secret, sid, {
      hook_event_name: huge,
      tool_name: huge,
      file_path: huge,
    })).toBe(200)

    const entry = gw!.getBuffer(sid)[0]
    expect(entry).toBeDefined()
    expect(entry.event.length).toBeLessThanOrEqual(128)
    expect(entry.toolName!.length).toBeLessThanOrEqual(128)
    expect(entry.summary.length).toBeLessThanOrEqual(256)
    // The whole entry, serialised — this is what crosses the utilityProcess
    // transport once per event.
    expect(JSON.stringify(entry).length).toBeLessThan(32_000)
  })

  it('leaves a normal event, tool name and summary untouched', async () => {
    const { secret, sid } = await gateway()
    expect(await post(secret, sid, { hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBe(200)
    const entry = gw!.getBuffer(sid)[0]
    expect(entry.event).toBe('PreToolUse')
    expect(entry.toolName).toBe('Bash')
  })
})
