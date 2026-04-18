import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  requestDeviceCode,
  pollForAccessToken,
} from '../../../src/main/github/auth/oauth-device-flow'

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

describe('requestDeviceCode', () => {
  it('POSTs and returns parsed body', async () => {
    globalThis.fetch = vi.fn(async (url: unknown, opts: unknown) => {
      expect(String(url)).toContain('login/device/code')
      const o = opts as { method: string; body: string }
      expect(o.method).toBe('POST')
      expect(o.body).toMatch(/client_id=/)
      return {
        ok: true,
        json: async () => ({
          device_code: 'D',
          user_code: 'UC',
          verification_uri: 'vu',
          expires_in: 900,
          interval: 5,
        }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const r = await requestDeviceCode('public_repo')
    expect(r.user_code).toBe('UC')
  })
  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch
    await expect(requestDeviceCode('x')).rejects.toThrow(/500/)
  })
})

describe('pollForAccessToken', () => {
  const fakeSleep = () => Promise.resolve()

  it('returns token when ready', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'authorization_pending' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_ok' }),
      } as unknown as Response) as unknown as typeof fetch
    const r = await pollForAccessToken('D', 5, fakeSleep)
    expect(r.access_token).toBe('gho_ok')
  })

  it('throws on access_denied', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ error: 'access_denied' }),
        }) as unknown as Response,
    ) as unknown as typeof fetch
    await expect(pollForAccessToken('D', 5, fakeSleep)).rejects.toThrow(/access_denied/)
  })

  it('respects slow_down interval bump', async () => {
    const sleeps: number[] = []
    const sleep = (ms: number) => {
      sleeps.push(ms)
      return Promise.resolve()
    }
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'slow_down', interval: 10 }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_' }),
      } as unknown as Response) as unknown as typeof fetch
    await pollForAccessToken('D', 5, sleep)
    expect(sleeps[0]).toBe(5_000)
    expect(sleeps[1]).toBe(10_000)
  })

  it('cancellable: onCancel signal returns cancelled', async () => {
    const controller = { cancelled: false }
    globalThis.fetch = vi.fn(async () => {
      controller.cancelled = true
      return {
        ok: true,
        json: async () => ({ error: 'authorization_pending' }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const r = await pollForAccessToken('D', 5, fakeSleep, () => controller.cancelled)
    expect(r.access_token).toBeUndefined()
    expect(r.error).toBe('cancelled')
  })
})
