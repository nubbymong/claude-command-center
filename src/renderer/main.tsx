import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

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
