import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { useHooksStore } from './stores/hooksStore'

// Hooks gateway IPC wiring. Ingest unconditionally — `paused` is a UI-side
// read filter, not a store gate. Gating here would drop events and break
// the "pause then scroll back" contract from spec §Expanded state.
//
// HMR guard: electron-vite can re-execute main.tsx when renderer modules
// hot-reload. Without this one-shot flag each reload stacks another set of
// onEvent / onSessionEnded / onDropped listeners on the IPC bridge, and a
// single hook POST ends up ingested N times. The flag pins to `window` so
// it survives module re-evaluation (module-scoped `let` would reset).
type HooksWiringWindow = Window & { __claudeCommandCenterHooksWired?: boolean }
const w = window as HooksWiringWindow
if (!w.__claudeCommandCenterHooksWired) {
  w.__claudeCommandCenterHooksWired = true
  window.electronAPI.hooks.onEvent((e) => {
    useHooksStore.getState().ingest(e)
  })
  window.electronAPI.hooks.onSessionEnded((sid) => {
    useHooksStore.getState().clearSession(sid)
  })
  window.electronAPI.hooks.onDropped((p) => {
    useHooksStore.getState().markDropped(p.sessionId)
  })
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
