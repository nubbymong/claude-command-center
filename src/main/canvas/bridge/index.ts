// Agent Canvas bridge — the in-page agent script (spec D8).
//
// Injected at serve time by the ccc-ux:// protocol into every HTML document it
// serves (design docs and UAT builds alike), as an external same-origin script.
// Plain page JS over window.postMessage — no CDP, no preload, no Node.
//
// READ-ONLY from the content side: this script reports what the page contains
// (snapshot / boxMap / elementAtPoint replies, ready / viewport / pointer
// events); it never mutates the page and is never commanded to draw. The one
// thing it pulls in — the axe-core analysis chunk — arrives by dynamic import(),
// not by planting a <script> in the document.
//
// Trust model: requests are accepted ONLY from the direct parent window
// (event.source === window.parent). The parent's origin cannot be pinned —
// the packaged app renderer is a file:// document whose origin serializes to
// 'null' — so replies target '*'; everything sent is the page's own visible
// semantics, nothing secret.
//
// Bundled by scripts/vite-plugin-canvas-bridge.mjs into a single IIFE.

import { CANVAS_BRIDGE_NS, type CanvasHitInfo, type CanvasViewportInfo } from '../../../shared/canvas'
import { boxOf, isVisible } from './measure'
import { isMeaningful, nameOf, roleOf } from './semantics'
import { captureSnapshot } from './snapshot'

declare global {
  interface Window {
    __cccCanvasBridge?: boolean
  }
}

const NS = CANVAS_BRIDGE_NS
const MAX_BOXMAP_NODES = 2000

// Real browsers always have rAF; the setTimeout fallback keeps the script
// inert-safe in DOM-less harnesses.
const raf: (cb: () => void) => unknown =
  typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (cb: () => void) => setTimeout(cb, 16)

function describe(el: Element): CanvasHitInfo {
  const info: CanvasHitInfo = {
    role: roleOf(el),
    name: nameOf(el),
    tag: el.tagName.toLowerCase(),
    box: boxOf(el),
  }
  const uxId = el.getAttribute('data-ux-id')
  if (uxId) info.uxId = uxId
  return info
}

function hitAt(pageX: number, pageY: number): CanvasHitInfo | null {
  let el: Element | null = null
  try {
    el = document.elementFromPoint(pageX - window.scrollX, pageY - window.scrollY)
  } catch {
    el = null
  }
  if (!el || el === document.documentElement || el === document.body) return null
  let cur: Element | null = el
  while (cur && cur !== document.body && !isMeaningful(cur)) cur = cur.parentElement
  const target = cur && cur !== document.body ? cur : el
  return describe(target)
}

function boxMap(): CanvasHitInfo[] {
  const out: CanvasHitInfo[] = []
  const all = document.querySelectorAll('*')
  for (let i = 0; i < all.length && out.length < MAX_BOXMAP_NODES; i++) {
    const el = all[i]
    if (isMeaningful(el) && isVisible(el)) out.push(describe(el))
  }
  return out
}

function viewportInfo(): CanvasViewportInfo {
  const vv = window.visualViewport
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    scale: vv && typeof vv.scale === 'number' ? vv.scale : 1,
  }
}

function send(msg: unknown): void {
  try {
    window.parent.postMessage(msg, '*')
  } catch {
    /* parent gone — nothing to report to */
  }
}

interface IncomingRequest {
  ns?: unknown
  id?: unknown
  type?: unknown
  x?: unknown
  y?: unknown
  scope?: unknown
  analysis?: unknown
}

function handle(msg: IncomingRequest): Promise<unknown> {
  if (msg.type === 'snapshot') {
    const scope = Array.isArray(msg.scope) ? msg.scope.filter((s): s is string => typeof s === 'string') : undefined
    return captureSnapshot({ scope, analysis: msg.analysis !== false })
  }
  if (msg.type === 'boxMap') return Promise.resolve(boxMap())
  if (msg.type === 'elementAtPoint') return Promise.resolve(hitAt(Number(msg.x) || 0, Number(msg.y) || 0))
  return Promise.reject(new Error('unknown request: ' + String(msg.type)))
}

function install(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    // Only the embedding host may ask; anything else (siblings, the page's own
    // frames) is ignored.
    if (event.source !== window.parent) return
    const msg = event.data as IncomingRequest | undefined
    if (!msg || msg.ns !== NS || typeof msg.id !== 'number' || typeof msg.type !== 'string') return
    const id = msg.id
    let work: Promise<unknown>
    try {
      work = handle(msg)
    } catch (err) {
      work = Promise.reject(err)
    }
    work.then(
      (result) => send({ ns: NS, id, ok: true, result }),
      (err: unknown) => send({ ns: NS, id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
  })

  // ── unsolicited events ────────────────────────────────────────────────────

  const rafPending = { viewport: false, pointer: false }
  let lastPointer: { x: number; y: number } | null = null

  function queueViewport(): void {
    if (rafPending.viewport) return
    rafPending.viewport = true
    raf(() => {
      rafPending.viewport = false
      send({ ns: NS, type: 'viewport', viewport: viewportInfo() })
    })
  }

  function queuePointer(pageX: number, pageY: number): void {
    lastPointer = { x: pageX, y: pageY }
    if (rafPending.pointer) return
    rafPending.pointer = true
    raf(() => {
      rafPending.pointer = false
      if (!lastPointer) {
        send({ ns: NS, type: 'pointer', pageX: 0, pageY: 0, hit: null })
        return
      }
      send({ ns: NS, type: 'pointer', pageX: lastPointer.x, pageY: lastPointer.y, hit: hitAt(lastPointer.x, lastPointer.y) })
    })
  }

  window.addEventListener('scroll', queueViewport, { passive: true })
  window.addEventListener('resize', queueViewport, { passive: true })
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', queueViewport, { passive: true })
    window.visualViewport.addEventListener('scroll', queueViewport, { passive: true })
  }
  document.addEventListener(
    'mousemove',
    (event: MouseEvent) => {
      queuePointer(event.pageX, event.pageY)
    },
    { passive: true },
  )
  document.addEventListener(
    'mouseleave',
    () => {
      lastPointer = null
      queuePointer(0, 0)
      lastPointer = null
    },
    { passive: true },
  )

  function announceReady(): void {
    send({ ns: NS, type: 'ready' })
    send({ ns: NS, type: 'viewport', viewport: viewportInfo() })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady)
  } else {
    announceReady()
  }
}

if (!window.__cccCanvasBridge) {
  window.__cccCanvasBridge = true
  install()
}
