import { useEffect } from 'react'
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
