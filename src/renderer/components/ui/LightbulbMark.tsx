import React from 'react'

/**
 * The tips mark: a stroked lightbulb.
 *
 * ONE mark, shared by the sidebar dock row and the tip dialog it opens (#361).
 * It used to live privately in `AskConductorDock` while the dialog drew a 💡
 * emoji, so the two surfaces of the same feature did not look related and the
 * dialog's glyph rendered in whatever the platform's emoji font decided.
 *
 * Inline SVG on purpose -- the project bans `\u{...}` escapes in JSX (esbuild)
 * and bans emoji in the UI, so a mark is drawn, never typed. `currentColor`
 * means the caller sets the accent (`--accent-tip`) once on a wrapper.
 */
export function LightbulbMark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z" />
    </svg>
  )
}
