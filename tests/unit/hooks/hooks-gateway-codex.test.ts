// P3.10 (row 63): the Hooks gateway takes a Codex session's hook events the way
// it takes Claude Code's (loopback only, the session's token, the same caps),
// with one difference: a request the Codex forwarder marks as its own is never
// held open. Codex runs the app's hooks asynchronously and reads no answer, so
// a held PermissionRequest could only tie up the forwarder and register a
// responder no decision can reach. The marker only takes that away; it grants
// nothing (the token is checked first).
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'
import { _resetResponders, _responderCount, resolveResponder } from '../../../src/main/permission-responders'
import type { HookEvent } from '../../../src/shared/hook-types'

function post(port: number, sid: string, token: string, body: object, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port, path: `/hook/${sid}`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-ccc-hook-token': token, ...extraHeaders } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, ms: Date.now() - t0 })) },
    )
    req.on('error', reject)
    req.end(data)
  })
}

const CODEX = { 'x-ccc-hook-client': 'codex' }
const codexPermission = {
  session_id: '01a0ef12-02ef-7fd2-93be-e5cbe9eaa3e6', hook_event_name: 'PermissionRequest', model: 'gpt-6-astra',
  permission_mode: 'default', turn_id: 't1', tool_name: 'shell', tool_input: { command: 'npm test' }, tool_use_id: 'call_1',
}

describe('HooksGateway: a Codex session\'s events', () => {
  let gw: HooksGateway
  afterEach(async () => { await gw?.stop(); _resetResponders() })

  it('a Codex PermissionRequest is answered at once, registers no responder, and is ingested for its subscribers', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const seen: HookEvent[] = []
    gw.subscribe((e) => seen.push(e))
    const { port } = await gw.start()
    const secret = gw.registerSession('codex-1')
    const res = await post(port!, 'codex-1', secret, codexPermission, CODEX)
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')
    expect(_responderCount()).toBe(0)
    expect(seen.map((e) => e.event)).toEqual(['PermissionRequest'])
    expect(seen[0].sessionId).toBe('codex-1')
  })

  it('without the marker the same request is held open for a decision (Claude\'s path, unchanged)', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const secret = gw.registerSession('claude-1')
    const pending = post(port!, 'claude-1', secret, codexPermission)
    const deadline = Date.now() + 2000
    while (_responderCount() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    expect(_responderCount()).toBe(1)
    // Released with no decision, so the held request ends.
    resolveResponder('call_1', 'defer')
    const res = await pending
    expect(res.status).toBe(200)
  })

  it('the marker grants nothing: a wrong token is refused and nothing is ingested', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const seen: HookEvent[] = []
    gw.subscribe((e) => seen.push(e))
    const { port } = await gw.start()
    gw.registerSession('codex-2')
    const res = await post(port!, 'codex-2', 'not-the-token-at-all-000000', codexPermission, CODEX)
    expect(res.status).toBe(404)
    expect(seen).toEqual([])
  })

  it('a Codex event hands its transcript_path to the transcript sink before redaction, as Claude\'s do', async () => {
    const paths: Array<[string, string]> = []
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0, onTranscriptPath: (sid, p) => paths.push([sid, p]) })
    const { port } = await gw.start()
    const secret = gw.registerSession('codex-3')
    const tp = 'C:\\Users\\User\\res\\codex-realms\\r1\\sessions\\2026\\09\\29\\rollout-2026-09-29T14-28-50-01a0ef12-02ef-7fd2-93be-e5cbe9eaa3e6.jsonl'
    await post(port!, 'codex-3', secret, { session_id: '01a0ef12-02ef-7fd2-93be-e5cbe9eaa3e6', hook_event_name: 'SessionStart', source: 'startup', transcript_path: tp, cwd: 'C:\\p' }, CODEX)
    expect(paths).toEqual([['codex-3', tp]])
  })
})
