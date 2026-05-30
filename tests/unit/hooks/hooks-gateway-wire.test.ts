import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'
import { resolveResponder, _resetResponders, _responderCount } from '../../../src/main/permission-responders'

// Poll until the held-open path has registered its responder, instead of a fixed
// sleep (deterministic under CI load). Falls through after 2s as a safety net.
async function waitForResponder(): Promise<void> {
  const deadline = Date.now() + 2000
  while (_responderCount() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
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
})
