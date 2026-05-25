import React from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useResolvedTheme } from '../hooks/useThemeController'

// Light/Dark quick flip. The full Dark/Light/System selector lives in Settings.
// Reads the RESOLVED theme so every click produces a visible change (fixes the
// old cycle's invisible system->dark step). Writing an explicit mode also
// overrides a prior 'system' selection.
export default function ThemeToggle() {
  const resolved = useResolvedTheme()
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const isDark = resolved === 'dark'
  return (
    <button
      type="button"
      onClick={() => void updateSettings({ theme: isDark ? 'light' : 'dark' })}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="titlebar-no-drag w-7 h-7 flex items-center justify-center rounded hover:bg-surface0 text-overlay1 hover:text-text transition-colors focus-ring"
    >
      {isDark ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      )}
    </button>
  )
}
