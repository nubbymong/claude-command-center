import { describe, it, expect, vi } from 'vitest'
import { PasteQueue } from '../../../src/main/paste-queue'

const tick = () => new Promise((r) => setTimeout(r, 0))

// Unit 5 P1.5: cancel() drops pending envelopes + releases drain() waiters; the
// in-flight write self-terminates via writeEnvelopeChunked's identity guard.
describe('PasteQueue.cancel', () => {
  it('drops pending envelopes and refuses further writes after cancel', async () => {
    const written: string[] = []
    let releaseFirst!: () => void
    const writer = vi.fn((e: string) => {
      written.push(e)
      // 'a' hangs until released, so we can cancel while it's in-flight.
      return e === 'a' ? new Promise<void>((res) => { releaseFirst = res }) : Promise.resolve()
    })
    const q = new PasteQueue(writer, 16)
    q.enqueue('a') // in-flight (hangs)
    q.enqueue('b') // pending
    q.enqueue('c') // pending
    q.cancel()
    releaseFirst()  // resolve the in-flight write — pump must NOT proceed to b/c
    await tick()
    expect(written).toEqual(['a'])
    expect(q.length).toBe(0)
  })

  it('resolves outstanding drain() waiters on cancel', async () => {
    const writer = vi.fn(() => new Promise<void>(() => {})) // never resolves
    const q = new PasteQueue(writer, 16)
    q.enqueue('x')
    const drained = q.drain()
    q.cancel()
    await expect(drained).resolves.toBeUndefined()
  })
})
