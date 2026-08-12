// Agent Canvas bridge — the in-page agent script (spec D8).
//
// Injected at serve time by the ccc-ux:// protocol into every HTML document it
// serves (design docs and UAT builds alike), as an external same-origin script.
// Plain page JS over window.postMessage — no CDP, no preload, no Node.
//
// READ-ONLY from the content side: this script reports what the page contains
// (snapshot / boxMap / elementAtPoint replies, ready / viewport / pointer
// events); it never modifies the rendered document and is never commanded to
// draw. The analysis chunk arrives by dynamic import() rather than by planting a
// <script> tag — but be precise about what "read-only" means once it loads:
// axe-core assigns `window.axe` and installs an `elementsFromPoint` polyfill,
// and its contrast rule may briefly toggle inline styles while probing a hit
// stack. Nothing the page RENDERS is changed; page globals are.
//
// Trust model: requests are accepted ONLY from the direct parent window
// (event.source === window.parent). The parent's origin cannot be pinned —
// the packaged app renderer is a file:// document whose origin serializes to
// 'null' — so replies target '*'; everything sent is the page's own visible
// semantics, nothing secret.
//
// WHAT THIS BRIDGE IS NOT: an independent observer. It cannot be made into one.
// It is a classic script sharing a realm with the page it reports on, and the
// page runs first. A document that executes script can monkey-patch
// `getBoundingClientRect`, `getComputedStyle` or `querySelectorAll` — or skip
// this script entirely by setting the already-loaded flag and answering the host
// protocol itself — and thereby dictate what the agent is told. A forged
// snapshot showing a healthy page over an empty <body> was demonstrated in
// review. Design mode grants `script-src 'self' 'unsafe-inline'` and writes
// author HTML verbatim, so this is the expected shape, not an edge case.
//
// Capturing primordials at load time does not fix it — the page's inline script
// still runs first, and a capture happens much later — so nothing here pretends
// to. What follows is a DOCUMENTATION duty rather than a code one: downstream
// describes a snapshot as the page's own report of itself, and keeps treating it
// as untrusted input, which is what the sanitiser and the untrusted-content
// envelope already do. The cheap one-line bypasses are closed where closing them
// is free (see analysis.ts); the general case is a stated non-goal.
//
// Bundled by scripts/vite-plugin-canvas-bridge.mjs into a single IIFE.

import {
  CANVAS_BRIDGE_NS,
  CANVAS_REPORTED_KEYS,
  MAX_INSPECT_CHAIN,
  MAX_RESOLVE_ANCHORS,
  type AnchorRef,
  type CanvasHitInfo,
  type CanvasInspectEntry,
  type CanvasViewportInfo,
} from '../../../shared/canvas'
import { createAnchorContext, fingerprintOf, resolveAnchors } from './anchors'
import { boxOf, isVisible } from './measure'
import { isMeaningful, nameOf, parentOf, roleOf } from './semantics'
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

/** How many shadow boundaries a hit test will descend through. Bounded because
 *  each level is another engine call and components nest. */
const MAX_HIT_RETARGET = 8

/** The raw deepest element under a page point, descending into shadow roots. */
function elementAt(pageX: number, pageY: number): Element | null {
  const x = pageX - window.scrollX
  const y = pageY - window.scrollY
  let el: Element | null = null
  try {
    el = document.elementFromPoint(x, y)
  } catch {
    el = null
  }
  // `document.elementFromPoint` retargets to the shadow HOST, so hovering a
  // button inside a web component reported the component. Descend to what is
  // really under the pointer.
  for (let i = 0; i < MAX_HIT_RETARGET && el?.shadowRoot; i++) {
    let inner: Element | null = null
    try {
      inner = el.shadowRoot.elementFromPoint(x, y)
    } catch {
      inner = null
    }
    if (!inner || inner === el) break
    el = inner
  }
  if (!el || el === document.documentElement || el === document.body) return null
  return el
}

/** The meaningful element the hover chip names for a raw hit — the same walk
 *  hitAt and inspectAt must agree on, or a click would lock something other
 *  than what the hover showed. */
function meaningfulTargetOf(el: Element): Element {
  let cur: Element | null = el
  while (cur && cur !== document.body && !isMeaningful(cur)) cur = parentOf(cur)
  return cur && cur !== document.body ? cur : el
}

function hitAt(pageX: number, pageY: number): CanvasHitInfo | null {
  const el = elementAt(pageX, pageY)
  if (!el) return null
  return describe(meaningfulTargetOf(el))
}

/**
 * The selection ladder at a point (P3 focus): the meaningful element the hover
 * would have named, then each meaningful ancestor, deepest first, each with the
 * fingerprint it could later be re-found by. One reply carries everything
 * "expand to parent" will ever need for this click.
 */
function inspectAt(pageX: number, pageY: number): { chain: CanvasInspectEntry[] } {
  const el = elementAt(pageX, pageY)
  if (!el) return { chain: [] }
  const start = meaningfulTargetOf(el)
  const ctx = createAnchorContext()
  const chain: CanvasInspectEntry[] = []
  let cur: Element | null = start
  while (cur && cur !== document.body && cur !== document.documentElement && chain.length < MAX_INSPECT_CHAIN) {
    // `start` is included even when nothing meaningful was found (the raw hit
    // is then the only honest answer); above it only meaningful rungs count.
    if (cur === start || isMeaningful(cur)) {
      chain.push({ ...describe(cur), fingerprint: fingerprintOf(cur, ctx) })
    }
    cur = parentOf(cur)
  }
  return { chain }
}

/** Every element under `root`, descending into open shadow roots — which
 *  `querySelectorAll('*')` does not do, so a web component's contents had no
 *  boxes at all. */
function collectBoxes(root: ParentNode, out: CanvasHitInfo[]): void {
  const children = root.children
  for (let i = 0; i < children.length && out.length < MAX_BOXMAP_NODES; i++) {
    const el = children[i]
    if (isMeaningful(el) && isVisible(el)) out.push(describe(el))
    if (el.shadowRoot) collectBoxes(el.shadowRoot, out)
    collectBoxes(el, out)
  }
}

function boxMap(): CanvasHitInfo[] {
  const out: CanvasHitInfo[] = []
  if (document.documentElement) collectBoxes(document.documentElement, out)
  return out
}

/** Where a keystroke is the USER'S text entry rather than navigation. */
function isEditableTarget(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return (el as HTMLElement).isContentEditable === true
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
  anchors?: unknown
}

function handle(msg: IncomingRequest): Promise<unknown> {
  if (msg.type === 'snapshot') {
    const scope = Array.isArray(msg.scope) ? msg.scope.filter((s): s is string => typeof s === 'string') : undefined
    return captureSnapshot({ scope, analysis: msg.analysis !== false })
  }
  if (msg.type === 'boxMap') return Promise.resolve(boxMap())
  if (msg.type === 'elementAtPoint') return Promise.resolve(hitAt(Number(msg.x) || 0, Number(msg.y) || 0))
  if (msg.type === 'inspect') return Promise.resolve(inspectAt(Number(msg.x) || 0, Number(msg.y) || 0))
  if (msg.type === 'resolveAnchors') {
    const anchors = Array.isArray(msg.anchors) ? (msg.anchors.slice(0, MAX_RESOLVE_ANCHORS) as AnchorRef[]) : []
    return Promise.resolve({ results: resolveAnchors(anchors) })
  }
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

  // Click-to-lock (P3 focus): the host cannot see clicks inside this frame, so
  // the bridge REPORTS them. Capture phase, so a page handler that stops
  // propagation cannot make a click invisible to review; nothing is prevented
  // or retargeted — the page's own behaviour is untouched (D8).
  document.addEventListener(
    'click',
    (event: MouseEvent) => {
      send({ ns: NS, type: 'contentClick', pageX: event.pageX, pageY: event.pageY, hit: hitAt(event.pageX, event.pageY) })
    },
    { capture: true, passive: true },
  )

  // "One key expands to parent" (spec §6) has to work while the frame owns
  // keyboard focus. Only the closed CANVAS_REPORTED_KEYS list is ever relayed,
  // and never from an editable target — a page is full of real inputs, and
  // relaying those keystrokes would be a keylogger wearing a feature's name.
  document.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (!(CANVAS_REPORTED_KEYS as readonly string[]).includes(event.key)) return
      const target = event.target
      if (target instanceof Element && isEditableTarget(target)) return
      send({ ns: NS, type: 'contentKey', key: event.key })
    },
    { capture: true, passive: true },
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
