import React from 'react'

// Shown on the SELECTED card only (spec section 6 line 1, far right). A small
// rounded square in the session identity colour -- a non-status, structural
// "this is the selected identity" marker. Square (not a dot) so it never reads
// as a health dot.
export function IdentityChip({ color, title }: { color: string; title?: string }) {
  return (
    <span
      className="w-2.5 h-2.5 rounded-[3px] shrink-0"
      style={{ backgroundColor: color, boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)` }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
    />
  )
}
