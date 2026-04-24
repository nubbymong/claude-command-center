import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'

function post(port: number, path: string, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          'x-ccc-hook-token': token,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('integration: synthetic hooks path', () => {
  let gw: HooksGateway | null = null
  afterEach(async () => {
    await gw?.stop()
    gw = null
  })

  it('delivers a valid POST to the emit() callback', async () => {
    const emit = vi.fn()
    gw = new HooksGateway({ emit, defaultPort: 0 })
    await gw.start()
    const port = gw.status().port!
    expect(port).toBeGreaterThan(0)
    const secret = gw.registerSession('sid-x')

    const res = await post(port, '/hook/sid-x', secret, {
      event: 'PreToolUse',
      tool_name: 'Read',
      payload: { file: 'package.json' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')

    const eventCalls = emit.mock.calls.filter(([ch]) => ch === 'hooks:event')
    expect(eventCalls.length).toBe(1)
    expect(eventCalls[0][1].sessionId).toBe('sid-x')
    expect(eventCalls[0][1].event).toBe('PreToolUse')
  })

  it('rejects an unknown session id with 404', async () => {
    const emit = vi.fn()
    gw = new HooksGateway({ emit, defaultPort: 0 })
    await gw.start()
    const port = gw.status().port!

    const res = await post(port, '/hook/unregistered', 'any-token', {
      event: 'PreToolUse',
    })
    expect(res.status).toBe(404)
    expect(emit.mock.calls.filter(([ch]) => ch === 'hooks:event').length).toBe(0)
  })

  it('rejects a wrong secret with 404', async () => {
    const emit = vi.fn()
    gw = new HooksGateway({ emit, defaultPort: 0 })
    await gw.start()
    const port = gw.status().port!
    gw.registerSession('sid-y')

    const res = await post(port, '/hook/sid-y', 'wrong-secret', {
      event: 'PreToolUse',
    })
    expect(res.status).toBe(404)
  })

  it('unregisterSession causes subsequent requests to 404', async () => {
    const emit = vi.fn()
    gw = new HooksGateway({ emit, defaultPort: 0 })
    await gw.start()
    const port = gw.status().port!
    const secret = gw.registerSession('sid-z')

    const first = await post(port, '/hook/sid-z', secret, { event: 'PreToolUse' })
    expect(first.status).toBe(200)

    gw.unregisterSession('sid-z')

    const second = await post(port, '/hook/sid-z', secret, { event: 'PreToolUse' })
    expect(second.status).toBe(404)
  })
})
