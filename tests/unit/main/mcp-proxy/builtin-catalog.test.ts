import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { builtinCatalog, type BuiltinCtx } from '../../../../src/main/mcp-proxy/builtin-catalog'
import { jsonSchemaToZodShape } from '../../../../src/main/mcp-proxy/proxy-tools'

function ctx(over: Partial<BuiltinCtx> = {}): BuiltinCtx {
  return {
    withVision: vi.fn(async (cmd) => ({ content: [{ type: 'text', text: JSON.stringify(cmd) }] })),
    getVisionManager: vi.fn(() => ({ executeCommand: vi.fn(async () => ({ ok: true })) })),
    imageFileToMcpContent: vi.fn((f: string) => ({ content: [{ type: 'image', data: f }] })),
    resultToMcpContent: vi.fn((r: any) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    visionUnavailable: vi.fn(() => ({ content: [{ type: 'text', text: 'unavailable' }], isError: true })),
    boundSessionId: 'sess-1',
    ...over,
  }
}

describe('catalog completeness', () => {
  it('carries the 19 built-ins (host transfer + vision), unique names', () => {
    const cat = builtinCatalog()
    const names = cat.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('fetch_host_screenshot')
    expect(names).toContain('vision_screenshot')
    expect(names).toContain('vision_setViewport')
    expect(cat.filter((c) => c.group === 'vision').length).toBe(18)
    expect(cat.filter((c) => c.group === 'hostTransfer').length).toBe(1)
  })
})

describe('JSON schema -> zod parity (no regression vs the old inline shapes)', () => {
  const shapeFor = (name: string) => {
    const b = builtinCatalog().find((c) => c.name === name)!
    return z.object(jsonSchemaToZodShape(b.jsonSchema, z))
  }

  it('required args are enforced', () => {
    expect(shapeFor('vision_navigate').safeParse({}).success).toBe(false)
    expect(shapeFor('vision_navigate').safeParse({ url: 'http://x' }).success).toBe(true)
    expect(shapeFor('vision_type').safeParse({ selector: '#a' }).success).toBe(false) // text required
    expect(shapeFor('vision_setViewport').safeParse({ width: 800 }).success).toBe(false) // height required
    expect(shapeFor('vision_setViewport').safeParse({ width: 800, height: 600 }).success).toBe(true)
  })

  it('optional args and enums behave', () => {
    expect(shapeFor('vision_wait').safeParse({ selector: '#a' }).success).toBe(true) // timeout optional
    expect(shapeFor('vision_scroll').safeParse({ direction: 'down' }).success).toBe(true)
    expect(shapeFor('vision_scroll').safeParse({ direction: 'sideways' }).success).toBe(false)
    expect(shapeFor('vision_scroll').safeParse({}).success).toBe(true)
  })

  it('no-arg tools accept an empty object', () => {
    expect(shapeFor('vision_status').safeParse({}).success).toBe(true)
    expect(shapeFor('vision_screenshot').safeParse({}).success).toBe(true)
  })
})

describe('run handlers preserve the original behavior', () => {
  const get = (name: string) => builtinCatalog().find((c) => c.name === name)!

  it('vision_navigate maps to a navigate VisionCommand', async () => {
    const c = ctx()
    await get('vision_navigate').run({ url: 'http://x' }, c)
    expect(c.withVision).toHaveBeenCalledWith({ command: 'navigate', args: ['http://x'] })
  })

  it('vision_setViewport appends deviceScaleFactor only when present', async () => {
    const c = ctx()
    await get('vision_setViewport').run({ width: 800, height: 600 }, c)
    expect(c.withVision).toHaveBeenLastCalledWith({ command: 'setViewport', args: ['800', '600'] })
    await get('vision_setViewport').run({ width: 800, height: 600, deviceScaleFactor: 2 }, c)
    expect(c.withVision).toHaveBeenLastCalledWith({ command: 'setViewport', args: ['800', '600', '2'] })
  })

  it('fetch_host_screenshot delegates to imageFileToMcpContent', () => {
    const c = ctx()
    get('fetch_host_screenshot').run({ filename: 'a.jpg' }, c)
    expect(c.imageFileToMcpContent).toHaveBeenCalledWith('a.jpg')
  })

  it('vision_status returns disconnected when no vision manager', async () => {
    const c = ctx({ getVisionManager: () => null })
    await get('vision_status').run({}, c)
    expect(c.resultToMcpContent).toHaveBeenCalledWith({ ok: true, data: { connected: false, browser: null } })
  })

  it('vision_screenshot returns unavailable when no vision manager', async () => {
    const c = ctx({ getVisionManager: () => null })
    const res = await get('vision_screenshot').run({}, c)
    expect(c.visionUnavailable).toHaveBeenCalled()
    expect(res.isError).toBe(true)
  })
})
