// tests/unit/paste-pty.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PasteQueue } from '../../src/main/paste-queue'

describe('PasteQueue', () => {
  it('writes envelopes in FIFO order, one in-flight at a time', async () => {
    const written: string[] = []
    const q = new PasteQueue(async (d) => { await Promise.resolve(); written.push(d) }, 16)
    q.enqueue('A'); q.enqueue('B'); q.enqueue('C')
    await q.drain()
    expect(written).toEqual(['A', 'B', 'C'])
  })
  it('drops the OLDEST when the queue exceeds the cap and reports overflow', async () => {
    let resolveFirst!: () => void
    const written: string[] = []
    const q = new PasteQueue((d) => new Promise<void>(res => {
      written.push(d)
      if (d === 'in-flight') resolveFirst = res; else res()
    }), 2)
    const overflows: number = (() => {
      q.enqueue('in-flight')           // starts immediately, stays in-flight
      q.enqueue('q1'); q.enqueue('q2') // queue now full (2)
      return q.enqueue('q3')           // overflow -> drops oldest queued (q1)
    })()
    expect(overflows).toBe(1)          // enqueue returns count of dropped envelopes
    resolveFirst()
    await q.drain()
    expect(written).toEqual(['in-flight', 'q2', 'q3'])  // q1 was dropped
  })
})
