import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'
import { resolveResponder, _resetResponders, _responderCount } from '../../../src/main/permission-responders'

// Poll until the held-open path has registered its responder, instead of a fixed
// sleep (deterministic under CI load). Falls through after 2s as a safety net.
async function waitForResponder(): Promise<void> {
  const deadline = Date.now() + 2000
  while (_responderCount() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  // Fail loudly instead of silently falling through: otherwise a real
  // "responder never registered" bug turns into a 120s held-open hang.
  if (_responderCount() === 0) throw new Error('responder was never registered within 2s')
}

function post(port: number, sid: string, token: string, body: object, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port, path: `/hook/${sid}`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-ccc-hook-token': token } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })) },
    )
    req.on('error', reject)
    if (signal) signal.addEventListener('abort', () => req.destroy())
    req.end(data)
  })
}

describe('hooks gateway permission wire value', () => {
  let gw: HooksGateway
  afterEach(async () => { await gw?.stop(); _resetResponders() })

  it('writes permissionDecision "allow" (not "approved") when a Bash request is approved', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    gw.setPermissionGateActive(true)
    const { port } = await gw.start()
    const secret = gw.registerSession('sess-1')
    const respPromise = post(port!, 'sess-1', secret, {
      event: 'PreToolUse', tool_name: 'Bash',
      payload: { requestId: 'req-1', tool_input: { command: 'rm -rf build' } },
    })
    await waitForResponder()
    resolveResponder('req-1', 'approved')
    const res = await respPromise
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
  })

  it('writes an empty {} (no decision) on a defer outcome so Claude falls back to its own prompt', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    gw.setPermissionGateActive(true)
    const { port } = await gw.start()
    const secret = gw.registerSession('s-defer')
    const respPromise = post(port!, 's-defer', secret, {
      event: 'PreToolUse', tool_name: 'Bash',
      payload: { requestId: 'req-defer', tool_input: { command: 'rm -rf build' } },
    })
    await waitForResponder()
    resolveResponder('req-defer', 'defer')
    const res = await respPromise
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')
  })
})

describe('hold-open gating', () => {
  let gw: HooksGateway
  afterEach(async () => { await gw?.stop(); _resetResponders() })

  it('flag OFF: a non-Bash PreToolUse is fire-and-forget (returns promptly)', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const secret = gw.registerSession('s2')
    const res = await post(port!, 's2', secret, { event: 'PreToolUse', tool_name: 'Edit', payload: { requestId: 'e1' } })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')
  })

  // Regression lock for the v1.5.16 flood: Bash PreToolUse used to be held open
  // UNCONDITIONALLY (the old `isPreToolUseBash` path). With the genuine-only
  // un-gate, Bash must be fire-and-forget too while the flag is OFF -- otherwise
  // CCC is back to being the gate and the flood/stall returns. If someone
  // re-adds an unconditional Bash hold, this test fails (the post would hang).
  it('flag OFF: a Bash PreToolUse is ALSO fire-and-forget (no unconditional hold)', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const secret = gw.registerSession('s2b')
    const res = await post(port!, 's2b', secret, { event: 'PreToolUse', tool_name: 'Bash', payload: { requestId: 'b1', tool_input: { command: 'git status' } } })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')
    expect(_responderCount()).toBe(0)   // nothing registered -> nothing held
  })

  it('flag ON: a non-Bash PreToolUse is held open until resolved', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    gw.setPermissionGateActive(true)
    const { port } = await gw.start()
    const secret = gw.registerSession('s3')
    const ac = new AbortController()
    const respPromise = post(port!, 's3', secret, { event: 'PreToolUse', tool_name: 'Edit', payload: { requestId: 'e2' } }, ac.signal)
      .then(() => 'resolved').catch(() => 'aborted')
    const held = await Promise.race([respPromise, new Promise((r) => setTimeout(() => r('held'), 150))])
    expect(held).toBe('held')   // still open after 150ms
    ac.abort()                  // clean up; req.on('close') deregisters the responder
    await respPromise
  })

  // Claude Code's real PreToolUse hook carries no requestId. The gateway must
  // inject the SAME synthetic id it keyed the responder under into the ingested
  // payload, so the downstream tray card resolves to that exact responder (else
  // Allow/Deny no-ops and the call stalls 120s).
  it('injects a synthetic requestId into the ingested payload when CC sends none', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    gw.setPermissionGateActive(true)
    const { port } = await gw.start()
    const secret = gw.registerSession('s4')
    const ac = new AbortController()
    // high-risk Bash is held open (no response); ingest still runs first
    void post(port!, 's4', secret, { event: 'PreToolUse', sessionId: 's4', tool_name: 'Bash', payload: { tool_input: { command: 'rm -rf build' } } }, ac.signal).catch(() => {})
    const deadline = Date.now() + 2000
    while (gw.getBuffer('s4').length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    const entry = gw.getBuffer('s4')[0]
    expect(entry).toBeDefined()
    expect(typeof (entry.payload as { requestId?: unknown }).requestId).toBe('string')
    expect((entry.payload as { requestId: string }).requestId).toMatch(/^s4-\d+$/)
    ac.abort()
  })

  // Claude Code's real hook POST uses `hook_event_name` (not `event`) and
  // snake_case fields. Before this was handled, ingest dropped EVERY live hook
  // -> the events feed + tray were silently dead. Lock the real shape here since
  // the real-Claude integration test is opt-in and skipped in CI.
  it('ingests Claude real-shape payloads (hook_event_name + tool_name)', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const secret = gw.registerSession('s5')
    const res = await post(port!, 's5', secret, {
      session_id: 's5', hook_event_name: 'PostToolUse', tool_name: 'Read',
      tool_input: { file_path: 'F:/x/package.json' }, tool_use_id: 'toolu_abc',
    })
    expect(res.status).toBe(200)   // PostToolUse is fire-and-forget (not held open)
    const buf = gw.getBuffer('s5')
    expect(buf).toHaveLength(1)
    expect(buf[0].event).toBe('PostToolUse')
    expect(buf[0].toolName).toBe('Read')
  })
})

// Logs v2 (Task 8): the gateway is the earliest + exact transcript discovery
// source. Claude Code's real hook POSTs carry `transcript_path` on every event
// (incl. SessionStart). The gateway lifts it BEFORE redaction and forwards it via
// an injectable onTranscriptPath callback so the binder can tail the file.
describe('hooks gateway transcript discovery', () => {
  let gw: HooksGateway
  afterEach(async () => { await gw?.stop(); _resetResponders() })

  it('fires onTranscriptPath with the session id + transcript_path on a real-shape POST', async () => {
    const calls: Array<{ sid: string; path: string }> = []
    gw = new HooksGateway({
      emit: () => {},
      defaultPort: 0,
      onTranscriptPath: (sid, path) => calls.push({ sid, path }),
    })
    const { port } = await gw.start()
    const secret = gw.registerSession('t1')
    const res = await post(port!, 't1', secret, {
      session_id: 't1', hook_event_name: 'SessionStart',
      transcript_path: 'C:/Users/me/.claude/projects/F--proj/abc-uuid.jsonl',
    })
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ sid: 't1', path: 'C:/Users/me/.claude/projects/F--proj/abc-uuid.jsonl' }])
  })

  it('lifts the RAW transcript_path before redaction while still redacting other secrets', async () => {
    const calls: Array<{ sid: string; path: string }> = []
    let emitted: { payload?: Record<string, unknown> } = {}
    gw = new HooksGateway({
      emit: (_ch, payload) => { emitted = { payload: (payload as { payload?: Record<string, unknown> }).payload } },
      defaultPort: 0,
      onTranscriptPath: (sid, path) => calls.push({ sid, path }),
    })
    const { port } = await gw.start()
    const secret = gw.registerSession('t2')
    const res = await post(port!, 't2', secret, {
      session_id: 't2', hook_event_name: 'PreToolUse', tool_name: 'Bash',
      transcript_path: 'C:/Users/me/.claude/projects/F--proj/xyz.jsonl',
      tool_input: { command: 'curl -H "api_key: sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    })
    expect(res.status).toBe(200)
    // The path is forwarded raw (un-redacted, un-mutated).
    expect(calls).toEqual([{ sid: 't2', path: 'C:/Users/me/.claude/projects/F--proj/xyz.jsonl' }])
    // The stored/emitted payload still has secrets scrubbed (redaction untouched).
    const cmd = (emitted.payload?.tool_input as { command?: string } | undefined)?.command ?? ''
    expect(cmd).toContain('[REDACTED]')
    expect(cmd).not.toContain('sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('does not fire onTranscriptPath when transcript_path is absent', async () => {
    const calls: Array<{ sid: string; path: string }> = []
    gw = new HooksGateway({
      emit: () => {},
      defaultPort: 0,
      onTranscriptPath: (sid, path) => calls.push({ sid, path }),
    })
    const { port } = await gw.start()
    const secret = gw.registerSession('t3')
    await post(port!, 't3', secret, { session_id: 't3', hook_event_name: 'PostToolUse', tool_name: 'Read' })
    expect(calls).toHaveLength(0)
  })

  it('does not fire onTranscriptPath when transcript_path is a non-string', async () => {
    const calls: Array<{ sid: string; path: string }> = []
    gw = new HooksGateway({
      emit: () => {},
      defaultPort: 0,
      onTranscriptPath: (sid, path) => calls.push({ sid, path }),
    })
    const { port } = await gw.start()
    const secret = gw.registerSession('t4')
    await post(port!, 't4', secret, { session_id: 't4', hook_event_name: 'PostToolUse', transcript_path: 123 })
    expect(calls).toHaveLength(0)
  })
})
