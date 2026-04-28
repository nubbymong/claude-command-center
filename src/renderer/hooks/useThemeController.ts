import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'

// Resolve the user's chosen mode against OS preference and stamp the
// resulting attribute onto <html>. CSS in styles.css then rebinds the
// --color-* tokens; every Tailwind utility (bg-base, text-text, etc.)
// repaints automatically. Listens for OS prefers-color-scheme changes
// while in 'system' mode so the app follows the OS toggle without a
// reload.
export function useThemeController(): void {
  const theme = useSettingsStore((s) => s.settings.theme)

  useEffect(() => {
    const root = document.documentElement
    const apply = (mode: 'dark' | 'light') => {
      root.dataset.theme = mode
    }

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: light)')
      apply(mq.matches ? 'light' : 'dark')
      const onChange = (e: MediaQueryListEvent) => apply(e.matches ? 'light' : 'dark')
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }

    apply(theme)
    return undefined
  }, [theme])
}

// Read the resolved theme synchronously — used by the xterm bridge to
// pick its colour palette at terminal-init time without subscribing to
// the store from a non-React context.
export function getResolvedTheme(): 'dark' | 'light' {
  const t = useSettingsStore.getState().settings.theme
  if (t === 'dark' || t === 'light') return t
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

// Reactive variant — components that need to repaint when the theme
// flips (Excalidraw modal, etc.) subscribe via this hook so they get
// re-rendered on settings change AND on OS-level prefers-color-scheme
// change while in 'system' mode.
export function useResolvedTheme(): 'dark' | 'light' {
  const setting = useSettingsStore((s) => s.settings.theme)
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => getResolvedTheme())
  useEffect(() => {
    if (setting === 'dark' || setting === 'light') {
      setResolved(setting)
      return undefined
    }
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    setResolved(mq.matches ? 'light' : 'dark')
    const onChange = (e: MediaQueryListEvent) => setResolved(e.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [setting])
  return resolved
}
