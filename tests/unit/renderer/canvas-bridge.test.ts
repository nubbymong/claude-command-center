// @vitest-environment jsdom
// The in-page bridge script, evaluated for real in jsdom. In a top-level
// window, window.parent === window, so the bridge's replies (posted to the
// parent) arrive on this window's own message listeners — the test IS the
// host. Requests are dispatched as MessageEvents with source: window, which
// satisfies the bridge's only-my-parent gate.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import bridgeSource from '../../../src/main/canvas/bridge/canvas-bridge.js?raw'
import { CANVAS_BRIDGE_NS } from '../../../src/shared/canvas'

interface BridgeReply {
  ns: string
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

let nextId = 1

function request(type: string, extra: Record<string, unknown> = {}): Promise<BridgeReply> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${type}`)), 1000)
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as BridgeReply | undefined
      if (!msg || msg.ns !== CANVAS_BRIDGE_NS || msg.id !== id || typeof (msg as { type?: unknown }).type === 'string') return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(msg)
    }
    window.addEventListener('message', onMessage)
    window.dispatchEvent(
      new MessageEvent('message', { data: { ns: CANVAS_BRIDGE_NS, id, type, ...extra }, source: window }),
    )
  })
}

function collectEvents(kind: string, ms = 300): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const seen: Record<string, unknown>[] = []
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as { ns?: string; type?: string } | undefined
      if (msg?.ns === CANVAS_BRIDGE_NS && msg.type === kind) seen.push(msg as Record<string, unknown>)
    }
    window.addEventListener('message', onMessage)
    setTimeout(() => {
      window.removeEventListener('message', onMessage)
      resolve(seen)
    }, ms)
  })
}

beforeAll(() => {
  // jsdom has no layout: give every element a synthetic box so the bridge's
  // visibility filter (getClientRects().length && width/height > 0) passes.
  Element.prototype.getBoundingClientRect = function () {
    return { left: 10, top: 20, right: 110, bottom: 50, width: 100, height: 30, x: 10, y: 20, toJSON: () => ({}) } as DOMRect
  }
  Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  document.body.innerHTML = `
    <header><h1>Fixture</h1></header>
    <main>
      <div class="wrapper">
        <button data-ux-id="save-btn">Save draft</button>
        <a href="/about">About us</a>
        <input id="email" type="text" placeholder="you@example.com" />
        <label for="email">Email address</label>
        <img src="x.png" alt="Chart preview" />
        <span aria-label="Close dialog" role="button">×</span>
      </div>
    </main>`
  // The bridge is served as a plain classic script; evaluate it the same way.
  // eslint-disable-next-line no-eval
  ;(0, eval)(bridgeSource)
})

afterEach(() => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint
})

describe('lifecycle', () => {
  it('announced ready and an initial viewport, and is idempotent', async () => {
    expect((window as unknown as { __cccCanvasBridge?: boolean }).__cccCanvasBridge).toBe(true)
    // Drain the install-time ready (postMessage delivery is a queued task that
    // can land after the first listener attaches), THEN prove a re-eval stays
    // silent: the guard flag must prevent a second install/announce.
    await collectEvents('ready', 150)
    ;(0, eval)(bridgeSource)
    const after = await collectEvents('ready', 150)
    expect(after.length).toBe(0)
  })
})

describe('requests', () => {
  it('boxMap reports meaningful elements with roles, names, and boxes', async () => {
    const reply = await request('boxMap')
    expect(reply.ok).toBe(true)
    const rows = reply.result as Array<{ role: string; name: string; tag: string; uxId?: string }>
    const byTag = (tag: string) => rows.filter((r) => r.tag === tag)

    const button = rows.find((r) => r.uxId === 'save-btn')
    expect(button).toBeDefined()
    expect(button!.role).toBe('button')
    expect(button!.name).toBe('Save draft')

    expect(byTag('a')[0]?.role).toBe('link')
    expect(byTag('a')[0]?.name).toBe('About us')
    expect(byTag('img')[0]?.name).toBe('Chart preview')
    expect(byTag('span')[0]?.role).toBe('button') // explicit role attr
    expect(byTag('span')[0]?.name).toBe('Close dialog') // aria-label
    const input = byTag('input')[0]
    expect(input?.role).toBe('textbox')
    expect(input?.name).toBe('Email address') // label[for]
  })

  it('snapshot returns a rooted tree', async () => {
    const reply = await request('snapshot')
    expect(reply.ok).toBe(true)
    const root = reply.result as { role: string; tag: string; children: unknown[] }
    expect(root.tag).toBe('body')
    expect(root.role).toBe('document')
    expect(Array.isArray(root.children)).toBe(true)
    expect(JSON.stringify(root)).toContain('save-btn')
  })

  it('elementAtPoint walks to the nearest meaningful ancestor', async () => {
    const button = document.querySelector('[data-ux-id="save-btn"]')!
    ;(document as { elementFromPoint?: unknown }).elementFromPoint = () => button.firstChild?.parentElement ?? button
    const reply = await request('elementAtPoint', { x: 10, y: 10 })
    expect(reply.ok).toBe(true)
    expect((reply.result as { uxId?: string }).uxId).toBe('save-btn')
  })

  it('elementAtPoint tolerates a missing elementFromPoint (returns null hit)', async () => {
    ;(document as { elementFromPoint?: unknown }).elementFromPoint = () => {
      throw new Error('not implemented')
    }
    const reply = await request('elementAtPoint', { x: 5, y: 5 })
    expect(reply.ok).toBe(true)
    expect(reply.result).toBeNull()
  })

  it('answers unknown request types with an error reply', async () => {
    const reply = await request('formatHardDrive')
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('unknown request')
  })
})

describe('trust gate', () => {
  it('ignores messages whose source is not the parent window', async () => {
    let replied = false
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as BridgeReply | undefined
      // Replies carry ok and no type; the dispatched request itself (also
      // visible on this window) carries type and must not count.
      if (msg?.ns === CANVAS_BRIDGE_NS && msg.id === 999_999 && typeof (msg as { type?: unknown }).type !== 'string') replied = true
    }
    window.addEventListener('message', onMessage)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ns: CANVAS_BRIDGE_NS, id: 999_999, type: 'boxMap' },
        source: null, // a foreign/spoofed source
      }),
    )
    await new Promise((r) => setTimeout(r, 150))
    window.removeEventListener('message', onMessage)
    expect(replied).toBe(false)
  })

  it('ignores garbage payloads without throwing', () => {
    for (const data of [null, 'string', 42, { ns: 'wrong' }, { ns: CANVAS_BRIDGE_NS }, { ns: CANVAS_BRIDGE_NS, id: 'x', type: 'boxMap' }]) {
      expect(() =>
        window.dispatchEvent(new MessageEvent('message', { data, source: window })),
      ).not.toThrow()
    }
  })
})

describe('events', () => {
  it('mousemove produces throttled pointer events', async () => {
    const button = document.querySelector('[data-ux-id="save-btn"]')!
    ;(document as { elementFromPoint?: unknown }).elementFromPoint = () => button
    const eventsPromise = collectEvents('pointer', 400)
    for (let i = 0; i < 25; i++) {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    }
    const events = await eventsPromise
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events.length).toBeLessThan(25) // rAF-throttled, not per-event
    const hit = events[events.length - 1].hit as { uxId?: string } | null
    expect(hit?.uxId).toBe('save-btn')
  })

  it('scroll produces viewport events with the full shape', async () => {
    const eventsPromise = collectEvents('viewport', 400)
    window.dispatchEvent(new Event('scroll'))
    const events = await eventsPromise
    expect(events.length).toBeGreaterThanOrEqual(1)
    const viewport = events[0].viewport as Record<string, unknown>
    for (const key of ['scrollX', 'scrollY', 'width', 'height', 'dpr', 'scale']) {
      expect(typeof viewport[key], key).toBe('number')
    }
  })
})
