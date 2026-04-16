import { useEffect } from 'react'
import { useSettingsStore, type ThemeMode } from '../stores/settingsStore'

function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return mode
}

export function useTheme(): { isDark: boolean; resolved: 'dark' | 'light' } {
  const mode = useSettingsStore((s) => s.settings.theme)
  const resolved = resolveTheme(mode || 'dark')
  return { isDark: resolved === 'dark', resolved }
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const mode = useSettingsStore((s) => s.settings.theme)

  useEffect(() => {
    const resolved = resolveTheme(mode || 'dark')
    const root = document.documentElement

    if (resolved === 'light') {
      root.classList.add('light')
    } else {
      root.classList.remove('light')
    }

    // Listen for system theme changes when in 'system' mode
    if (mode === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: light)')
      const handler = (e: MediaQueryListEvent) => {
        if (e.matches) {
          root.classList.add('light')
        } else {
          root.classList.remove('light')
        }
      }
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    }
  }, [mode])

  return <>{children}</>
}
