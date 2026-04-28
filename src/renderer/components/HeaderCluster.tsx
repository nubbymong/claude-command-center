import React from 'react'
import ThemeToggle from './ThemeToggle'

/**
 * The right-edge cluster that lives inside both <TabBar> (session
 * surface) and <PageFrame> (global admin surface) so global controls
 * (theme toggle, future help-inspect) are reachable regardless of
 * which view the user is on.
 *
 * Keep this small — it's chrome, not a primary affordance. Avoid
 * adding anything session-specific here; that belongs in TabBar's
 * left scroller or PageFrame's `actions` slot.
 */
export default function HeaderCluster() {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <ThemeToggle />
    </div>
  )
}
