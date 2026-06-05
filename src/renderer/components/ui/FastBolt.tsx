import React from 'react'

// Fast Mode indicator for session cards. A small lightning bolt shown ONLY when
// a LIVE statusline tick reports fast_mode:true (verified per-session against
// real Claude 2.1.x payloads -- the flag flips true on /fast and stays scoped to
// the toggling session). Glyph + title/aria so it is not colour-only. Inline SVG
// per the project rule (no \u{...} escapes in JSX). Colour = the theme-aware
// --fast-mode token; smooth 150ms transition per the animation convention.
export function FastBolt() {
  return (
    <span
      data-testid="fast-bolt"
      title="Fast Mode"
      role="img"
      aria-label="Fast Mode"
      className="inline-flex items-center shrink-0 leading-none transition-opacity duration-150"
      style={{ color: 'var(--fast-mode)' }}
    >
      <svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M11.983 1.907a.75.75 0 0 0-1.292-.657l-8.5 9.5A.75.75 0 0 0 2.75 12h6.572l-1.305 6.093a.75.75 0 0 0 1.292.657l8.5-9.5A.75.75 0 0 0 17.25 8h-6.572l1.305-6.093Z" />
      </svg>
    </span>
  )
}
