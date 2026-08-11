// Shared jsdom harness for the in-page bridge.
//
// The bridge under test is the BUNDLED artifact (virtual:canvas-bridge) — the
// same string ccc-ux:// serves into the content frame, so nothing here can pass
// while the shipped script is broken.
//
// In a top-level window, window.parent === window, so the bridge's replies
// (posted to the parent) arrive on this window's own message listeners: the test
// IS the host. Requests are dispatched as MessageEvents with source: window,
// which satisfies the bridge's only-my-parent gate.

import bridgeSource from 'virtual:canvas-bridge'
import { CANVAS_BRIDGE_NS } from '../../../src/shared/canvas'

export interface BridgeReply {
  ns: string
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

let nextId = 1

export function installBridge(): void {
  // Served as a plain classic script; evaluate it the same way.
  // eslint-disable-next-line no-eval
  ;(0, eval)(bridgeSource)
}

export function bridgeRequest(type: string, extra: Record<string, unknown> = {}, timeoutMs = 2000): Promise<BridgeReply> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${type}`)), timeoutMs)
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

export function collectEvents(kind: string, ms = 300): Promise<Record<string, unknown>[]> {
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

/**
 * jsdom has no layout engine, so geometry is declared per element and read back
 * from the stubs:
 *   data-test-box="x,y,w,h"                  → getBoundingClientRect
 *   data-test-scroll="sw,cw,sh,ch"           → scroll/client sizes (clipping)
 *
 * An element with no data-test-box measures 0×0, which the bridge treats as not
 * visible — so a fixture opts elements INTO the tree by giving them a box. Real
 * layout is a browser's job; what these tests pin is the logic on top of it.
 */
export function stubLayout(fallback?: { x: number; y: number; width: number; height: number }): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const spec = this.getAttribute?.('data-test-box')
    const [x, y, width, height] = spec
      ? spec.split(',').map(Number)
      : fallback
        ? [fallback.x, fallback.y, fallback.width, fallback.height]
        : [0, 0, 0, 0]
    return {
      x, y, width, height,
      left: x, top: y, right: x + width, bottom: y + height,
      toJSON: () => ({}),
    } as DOMRect
  }
  Element.prototype.getClientRects = function (this: Element): DOMRectList {
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  const SCROLL_PROPS: Array<[string, number]> = [
    ['scrollWidth', 0],
    ['clientWidth', 1],
    ['scrollHeight', 2],
    ['clientHeight', 3],
  ]
  for (const [prop, index] of SCROLL_PROPS) {
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      get(this: Element) {
        const spec = this.getAttribute?.('data-test-scroll')
        if (!spec) return 0
        return Number(spec.split(',')[index]) || 0
      },
    })
  }
}
