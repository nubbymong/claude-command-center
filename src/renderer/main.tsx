import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { useHooksStore } from './stores/hooksStore'

// Hooks gateway IPC wiring. Ingest unconditionally — `paused` is a UI-side
// read filter, not a store gate. Gating here would drop events and break
// the "pause then scroll back" contract from spec §Expanded state.
window.electronAPI.hooks.onEvent((e) => {
  useHooksStore.getState().ingest(e)
})
window.electronAPI.hooks.onSessionEnded((sid) => {
  useHooksStore.getState().clearSession(sid)
})
window.electronAPI.hooks.onDropped((p) => {
  useHooksStore.getState().markDropped(p.sessionId)
})

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
