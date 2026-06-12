import { describe, it, expect } from 'vitest'
import { boundPayloadForFeed } from '../../../src/main/hooks/bound-feed-payload'

const isStub = (p: Record<string, unknown>): boolean =>
  typeof p.note === 'string' && p.note.includes('full detail in Logs')

describe('boundPayloadForFeed', () => {
  it('passes a small payload through unchanged', () => {
    const p = { tool: 'Glob', count: 3, ok: true }
    expect(boundPayloadForFeed(p)).toEqual(p)
  })

  it('truncates a single long top-level string in place (keeps shape)', () => {
    const long = 'x'.repeat(5000)
    const out = boundPayloadForFeed({ tool: 'Edit', content: long })
    expect(out.tool).toBe('Edit')
    const content = out.content as string
    expect(content.length).toBeLessThan(long.length)
    expect(content.endsWith('[truncated]')).toBe(true)
    expect(isStub(out)).toBe(false)
  })

  it('deep-truncates long strings in nested objects and arrays', () => {
    const long = 'y'.repeat(5000)
    const out = boundPayloadForFeed({
      meta: { note: long },
      items: [{ body: long }, 'short'],
    })
    const meta = out.meta as { note: string }
    const items = out.items as Array<{ body?: string } | string>
    expect(meta.note.endsWith('[truncated]')).toBe(true)
    expect((items[0] as { body: string }).body.endsWith('[truncated]')).toBe(true)
    expect(items[1]).toBe('short') // short string untouched
    expect(isStub(out)).toBe(false)
  })

  it('replaces a payload that is still oversize after truncation with a stub', () => {
    // Many medium strings, each under the per-string cap, sum well past 8 KiB.
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) big['k' + i] = 'z'.repeat(1000)
    const originalBytes = Buffer.byteLength(JSON.stringify(big), 'utf8')
    const out = boundPayloadForFeed(big)
    expect(isStub(out)).toBe(true)
    expect(out.originalBytes).toBe(originalBytes)
  })

  it('respects a custom maxBytes', () => {
    const out = boundPayloadForFeed({ a: 'hello', b: 'world' }, 4)
    expect(isStub(out)).toBe(true)
    expect((out.originalBytes as number)).toBeGreaterThan(0)
  })

  it('never throws on a cyclic payload — returns the stub', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    let out: Record<string, unknown> = {}
    expect(() => { out = boundPayloadForFeed(cyclic) }).not.toThrow()
    expect(isStub(out)).toBe(true)
    expect(out.originalBytes).toBe(0) // unserializable original -> 0, not Infinity
  })

  it('always returns a valid Record (renderer indexing a missing field sees undefined, not a crash)', () => {
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) big['k' + i] = 'z'.repeat(1000)
    const out = boundPayloadForFeed(big)
    // The renderer might index e.g. out.command — on the stub that is just undefined.
    expect((out as { command?: string }).command).toBeUndefined()
    expect(typeof out).toBe('object')
  })
})
