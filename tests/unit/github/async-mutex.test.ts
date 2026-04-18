import { describe, it, expect } from 'vitest'
import { AsyncMutex } from '../../../src/main/github/async-mutex'

describe('AsyncMutex', () => {
  it('serializes concurrent critical sections (no interleaving)', async () => {
    const m = new AsyncMutex()
    const order: string[] = []
    const task = (name: string) =>
      m.run(async () => {
        order.push(`${name}-start`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`${name}-end`)
      })
    await Promise.all([task('A'), task('B'), task('C')])
    // Each task's start must be immediately followed by its own end — no interleave.
    expect(order).toEqual([
      'A-start',
      'A-end',
      'B-start',
      'B-end',
      'C-start',
      'C-end',
    ])
  })

  it('releases lock even when fn throws', async () => {
    const m = new AsyncMutex()
    await expect(m.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // If lock leaked, this call would hang forever — wrap with a timeout.
    const result = await Promise.race([
      m.run(async () => 'ok'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('hang')), 500)),
    ])
    expect(result).toBe('ok')
  })

  it('propagates return values', async () => {
    const m = new AsyncMutex()
    expect(await m.run(async () => 42)).toBe(42)
  })
})
