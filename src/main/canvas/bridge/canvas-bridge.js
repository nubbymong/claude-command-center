// Agent Canvas bridge — the in-page agent script (spec D8).
//
// Injected at serve time by the ccc-ux:// protocol into every HTML document it
// serves (design docs and UAT builds alike), as an external same-origin script.
// Plain page JS over window.postMessage — no CDP, no preload, no Node.
//
// READ-ONLY from the content side: this script reports what the page contains
// (snapshot / boxMap / elementAtPoint replies, ready / viewport / pointer
// events); it never mutates the page and is never commanded to draw.
//
// Trust model: requests are accepted ONLY from the direct parent window
// (event.source === window.parent). The parent's origin cannot be pinned —
// the packaged app renderer is a file:// document whose origin serializes to
// 'null' — so replies target '*'; everything sent is the page's own visible
// semantics, nothing secret. P2 swaps the role/name heuristics below for
// dom-accessibility-api + aria-query and adds the measurement/axe pass.
;(function () {
  'use strict'
  if (window.__cccCanvasBridge) return
  window.__cccCanvasBridge = true

  var NS = 'ccc-canvas'
  var MAX_SNAPSHOT_NODES = 4000
  var MAX_BOXMAP_NODES = 2000
  var NAME_MAX = 80

  // Real browsers always have rAF; the setTimeout fallback keeps the script
  // inert-safe in DOM-less harnesses.
  var raf = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : function (cb) { return setTimeout(cb, 16) }

  // ── semantics (P1 heuristics) ─────────────────────────────────────────────

  var IMPLICIT_ROLES = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'img',
    nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    aside: 'complementary', form: 'form', table: 'table', ul: 'list', ol: 'list',
    li: 'listitem', dialog: 'dialog', hr: 'separator', progress: 'progressbar',
    summary: 'button', p: 'paragraph', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading', article: 'article', fieldset: 'group',
    label: 'label', option: 'option'
  }
  var INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', button: 'button', submit: 'button', reset: 'button',
    image: 'button', file: 'button', hidden: ''
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role')
    if (explicit) return String(explicit).trim().split(/\s+/)[0].toLowerCase()
    var tag = el.tagName ? el.tagName.toLowerCase() : ''
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase()
      return Object.prototype.hasOwnProperty.call(INPUT_ROLES, type) ? INPUT_ROLES[type] : 'textbox'
    }
    if (tag === 'section') return namedBy(el) ? 'region' : ''
    return Object.prototype.hasOwnProperty.call(IMPLICIT_ROLES, tag) ? IMPLICIT_ROLES[tag] : ''
  }

  function namedBy(el) {
    return !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))
  }

  function squash(text) {
    if (!text) return ''
    var out = String(text).replace(/\s+/g, ' ').trim()
    return out.length > NAME_MAX ? out.slice(0, NAME_MAX - 1) + '…' : out
  }

  function labelledByText(el) {
    var ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    var parts = []
    for (var i = 0; i < ids.length; i++) {
      var ref = document.getElementById(ids[i])
      if (ref) parts.push(ref.textContent || '')
    }
    return parts.join(' ')
  }

  function nameOf(el) {
    var aria = el.getAttribute('aria-label')
    if (aria) return squash(aria)
    if (el.getAttribute('aria-labelledby')) {
      var ref = labelledByText(el)
      if (ref) return squash(ref)
    }
    var tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (el.id) {
        // htmlFor equality instead of a [for="…"] selector: exact, needs no
        // CSS.escape, and immune to hostile characters in page-authored ids.
        var labels = document.getElementsByTagName('label')
        for (var li = 0; li < labels.length; li++) {
          if (labels[li].htmlFor === el.id) return squash(labels[li].textContent)
        }
      }
      var wrap = el.closest ? el.closest('label') : null
      if (wrap) return squash(wrap.textContent)
      var type = (el.getAttribute('type') || '').toLowerCase()
      if ((type === 'submit' || type === 'button' || type === 'reset') && el.value) return squash(el.value)
      if (el.placeholder) return squash(el.placeholder)
    }
    if (tag === 'img') return squash(el.getAttribute('alt'))
    if (tag === 'a' || tag === 'button' || tag === 'summary' || /^h[1-6]$/.test(tag) ||
        tag === 'label' || tag === 'option' || tag === 'legend' || tag === 'caption') {
      return squash(el.textContent)
    }
    var title = el.getAttribute('title')
    if (title) return squash(title)
    // Small leaf elements read naturally by their text.
    if (el.children.length === 0) return squash(el.textContent)
    return ''
  }

  function meaningful(el) {
    if (!el || el.nodeType !== 1) return false
    var tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'meta' || tag === 'link') return false
    if (el.hasAttribute('data-ux-id')) return true
    if (el.hasAttribute('role') || el.hasAttribute('tabindex')) return true
    if (tag === 'a' && el.hasAttribute('href')) return true
    return Object.prototype.hasOwnProperty.call(IMPLICIT_ROLES, tag) || tag === 'input' || tag === 'section'
  }

  function visible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false
    var rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function boxOf(el) {
    var rect = el.getBoundingClientRect()
    return {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    }
  }

  function describe(el) {
    var info = {
      role: roleOf(el),
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      box: boxOf(el)
    }
    var uxId = el.getAttribute('data-ux-id')
    if (uxId) info.uxId = uxId
    return info
  }

  // ── request handlers ──────────────────────────────────────────────────────

  function hitAt(pageX, pageY) {
    var el = null
    try {
      el = document.elementFromPoint(pageX - window.scrollX, pageY - window.scrollY)
    } catch (err) {
      el = null
    }
    if (!el || el === document.documentElement || el === document.body) return null
    var cur = el
    while (cur && cur !== document.body && !meaningful(cur)) cur = cur.parentElement
    var target = cur && cur !== document.body ? cur : el
    return describe(target)
  }

  function snapshot() {
    var count = 0
    function walk(el) {
      if (count >= MAX_SNAPSHOT_NODES) return null
      var children = []
      for (var i = 0; i < el.children.length; i++) {
        var childEl = el.children[i]
        if (childEl.tagName === 'SCRIPT' || childEl.tagName === 'STYLE' || childEl.tagName === 'TEMPLATE') continue
        var walked = walk(childEl)
        if (walked === null) continue
        if (Array.isArray(walked)) children = children.concat(walked)
        else children.push(walked)
      }
      if (el === document.body) {
        return { role: 'document', name: squash(document.title), tag: 'body', box: boxOf(el), children: children }
      }
      if (meaningful(el) && visible(el)) {
        count++
        var node = describe(el)
        node.children = children
        return node
      }
      // Non-semantic wrapper: splice its children up a level.
      return children
    }
    return document.body ? walk(document.body) : null
  }

  function boxMap() {
    var out = []
    var all = document.querySelectorAll('*')
    for (var i = 0; i < all.length && out.length < MAX_BOXMAP_NODES; i++) {
      var el = all[i]
      if (meaningful(el) && visible(el)) out.push(describe(el))
    }
    return out
  }

  function viewportInfo() {
    var vv = window.visualViewport
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scale: vv && typeof vv.scale === 'number' ? vv.scale : 1
    }
  }

  // ── transport ─────────────────────────────────────────────────────────────

  function send(msg) {
    try {
      window.parent.postMessage(msg, '*')
    } catch (err) { /* parent gone — nothing to report to */ }
  }

  window.addEventListener('message', function (event) {
    // Only the embedding host may ask; anything else (siblings, the page's own
    // frames) is ignored. The reply goes to the asking source directly.
    if (event.source !== window.parent) return
    var msg = event.data
    if (!msg || msg.ns !== NS || typeof msg.id !== 'number' || typeof msg.type !== 'string') return
    var reply
    try {
      if (msg.type === 'snapshot') reply = { ns: NS, id: msg.id, ok: true, result: snapshot() }
      else if (msg.type === 'boxMap') reply = { ns: NS, id: msg.id, ok: true, result: boxMap() }
      else if (msg.type === 'elementAtPoint') reply = { ns: NS, id: msg.id, ok: true, result: hitAt(Number(msg.x) || 0, Number(msg.y) || 0) }
      else reply = { ns: NS, id: msg.id, ok: false, error: 'unknown request: ' + msg.type }
    } catch (err) {
      reply = { ns: NS, id: msg.id, ok: false, error: String(err && err.message ? err.message : err) }
    }
    send(reply)
  })

  // ── unsolicited events ────────────────────────────────────────────────────

  var rafPending = { viewport: false, pointer: false }
  var lastPointer = null

  function queueViewport() {
    if (rafPending.viewport) return
    rafPending.viewport = true
    raf(function () {
      rafPending.viewport = false
      send({ ns: NS, type: 'viewport', viewport: viewportInfo() })
    })
  }

  function queuePointer(pageX, pageY) {
    lastPointer = { x: pageX, y: pageY }
    if (rafPending.pointer) return
    rafPending.pointer = true
    raf(function () {
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
  document.addEventListener('mousemove', function (event) {
    queuePointer(event.pageX, event.pageY)
  }, { passive: true })
  document.addEventListener('mouseleave', function () {
    lastPointer = null
    queuePointer(0, 0)
    lastPointer = null
  }, { passive: true })

  function announceReady() {
    send({ ns: NS, type: 'ready' })
    send({ ns: NS, type: 'viewport', viewport: viewportInfo() })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady)
  } else {
    announceReady()
  }
})()
