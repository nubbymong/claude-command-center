import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Point Excalidraw at locally-bundled fonts instead of its esm.sh CDN default.
// Excalidraw's font loader prepends this base to each "fonts/<Family>/…" path
// and only appends its esm.sh fallback after; a local hit means the browser
// never reaches that fallback — which the renderer CSP (font-src 'self') blocks
// anyway, and which would otherwise phone a third-party CDN on every canvas
// open. Resolved against document.baseURI so it is an absolute file:// (packaged)
// or http://localhost (dev) URL — not a "/"-rooted path, which Excalidraw would
// re-resolve against the (opaque on file://) origin. The Latin families live in
// public/excalidraw-assets/; the ~13MB CJK Xiaolai family is intentionally not
// bundled, so CJK text falls back to a system font (no crash, no fetch unless
// CJK glyphs are actually drawn). Must run before any Excalidraw import.
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH =
  new URL('./excalidraw-assets/', document.baseURI).href

// Renderer-wide backstop for unhandled promise rejections. IPC read surfaces
// (tokenomics / logs handlers) reject by design on worker crash / restart-backoff
// / query timeout; a store path that forgets to catch would otherwise raise a
// silent unhandled rejection. This SURFACES it to the console (recorded by the
// debug capture) — it does not swallow it (the rejection still logs), so a stuck
// loading state stays diagnosable. Store-level try/catch remains the primary fix.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer] unhandled promise rejection:', e.reason)
})

// Renderer event-loop jank detector. A self-rescheduling 250ms timer measures
// how late each tick lands vs its scheduled interval; a gap above 4x (~1s) means
// the renderer's main thread was blocked (a freeze). Kept inline rather than
// importing src/main/jank-detector.ts, which pulls in debug-logger (a main-only
// module). The warning lands in the renderer console, which the debug capture
// records.
const JANK_INTERVAL_MS = 250
const JANK_STALL_FACTOR = 4
let jankLast = performance.now()
const jankTick = () => {
  const t = performance.now()
  const gap = t - jankLast
  if (gap > JANK_INTERVAL_MS * JANK_STALL_FACTOR) {
    console.warn('[jank] renderer stalled ' + Math.round(gap) + 'ms')
  }
  jankLast = t
  setTimeout(jankTick, JANK_INTERVAL_MS)
}
setTimeout(jankTick, JANK_INTERVAL_MS)

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
