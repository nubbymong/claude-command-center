import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import AppV2 from './AppV2'
import ThemeProvider from './components/ThemeProvider'
import './styles.css'

function Root() {
  const [useV2, setUseV2] = useState(true)

  // Ctrl+F12 toggles between v1 and v2 UI
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'F12') {
        e.preventDefault()
        setUseV2((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <ThemeProvider>
      {useV2 ? (
        <AppV2 onSwitchBack={() => setUseV2(false)} />
      ) : (
        <App />
      )}
    </ThemeProvider>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
