import React from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import type { ThemeMode } from '../stores/settingsStore'

// Small icon-button that cycles dark → light → system → dark. Sits in
// the empty right slot of the tab header bar. We deliberately avoided
// a fancy three-state segmented control here — the tab header is
// already busy with status pills + window controls, so a single icon
// that shows the active mode and cycles on click reads as ambient
// chrome rather than a primary affordance.
const NEXT: Record<ThemeMode, ThemeMode> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
}

const LABEL: Record<ThemeMode, string> = {
  dark: 'Dark theme — click for Light',
  light: 'Light theme — click for System',
  system: 'System theme — click for Dark',
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  // Icons sized to match the existing 16x16 chrome buttons in TitleBar /
  // SidebarNav. Stroke 1.6 so they read at small size on both light and
  // dark surfaces without going chunky.
  if (mode === 'dark') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    )
  }
  if (mode === 'light') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    )
  }
  // system — half-moon-half-sun glyph signalling auto-follow
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18" />
      <path d="M12 7a5 5 0 0 1 0 10z" fill="currentColor" />
    </svg>
  )
}

export default function ThemeToggle() {
  const theme = useSettingsStore((s) => s.settings.theme)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const cycle = () => {
    void updateSettings({ theme: NEXT[theme] })
  }

  return (
    <button
      type="button"
      onClick={cycle}
      title={LABEL[theme]}
      aria-label={LABEL[theme]}
      className="text-overlay1 hover:text-text transition-colors p-1 rounded titlebar-no-drag"
    >
      <ThemeIcon mode={theme} />
    </button>
  )
}
