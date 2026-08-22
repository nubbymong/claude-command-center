import React from 'react'
import SessionGroupHeader from './SessionGroupHeader'

interface UngroupedSessionsHeaderProps {
  collapsed?: boolean
  onToggleCollapse: () => void
  onCloseAll: () => void
}

/** The "Ungrouped" pseudo-group heading over the loose running sessions (#363).
 *  Same look as a group heading, so the loose tail stops reading as the last
 *  group's tail; only the wording differs. Callers decide WHEN it shows — only
 *  when something organised (a group or a section) sits above the loose rows,
 *  so a sidebar of nothing but loose sessions stays clean. */
export default function UngroupedSessionsHeader(props: UngroupedSessionsHeaderProps) {
  return (
    <SessionGroupHeader
      {...props}
      name="Ungrouped"
      collapseLabel="Collapse ungrouped sessions"
      expandLabel="Expand ungrouped sessions"
      closeAllTitle="Close all ungrouped sessions"
      testId="ungrouped-sessions-header"
    />
  )
}
