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
 *   data-test-rects="none"                   → getClientRects() is EMPTY
 *   data-test-text-box="x,y,w,h"             → where this element's own text ran
 *
 * An element with no data-test-box measures 0×0, which the bridge treats as not
 * visible — so a fixture opts elements INTO the tree by giving them a box. Real
 * layout is a browser's job; what these tests pin is the logic on top of it.
 *
 * `data-test-rects="none"` is the one distinction jsdom cannot express any other
 * way, and the bridge turns on it: a box of zero SIZE and NO box are different
 * states in a browser (`height: 0` versus `display: contents` or `display:
 * none`), while `getBoundingClientRect` reports zeros for both.
 *
 * `data-test-text-box` is read through a Range, because that is what the bridge
 * uses to find text that paints outside its element's box. It is declared on
 * the OWNER; every direct text node of that element measures there.
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
    if (this.getAttribute?.('data-test-rects') === 'none') return [] as unknown as DOMRectList
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
    const start = this.startContainer
    const owner = start?.parentElement
    const spec = owner?.getAttribute?.('data-test-text-box')
    // One box applies to every run; a `;`-separated list gives each run its own,
    // positionally over ALL the owner's text children — blank ones included, so
    // that a fixture can hand a whitespace run a box of its own and see whether
    // it was measured. That is the only way to tell a union of two runs from a
    // union of one, which is what bounds the number of runs measured.
    const runs = spec ? spec.split(';') : []
    let index = 0
    if (runs.length > 1 && owner) {
      for (let i = 0; i < owner.childNodes.length; i++) {
        const kid = owner.childNodes[i]
        if (kid === start) break
        if (kid.nodeType === 3) index++
      }
    }
    const chosen = runs.length > 1 ? runs[index] : runs[0]
    const [x, y, width, height] = chosen ? chosen.split(',').map(Number) : [0, 0, 0, 0]
    return {
      x, y, width, height,
      left: x, top: y, right: x + width, bottom: y + height,
      toJSON: () => ({}),
    } as DOMRect
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
