import React from 'react'
import { useSentinelStore } from '../../stores/sentinelStore'
import { useSettingsStore } from '../../stores/settingsStore'

interface Props {
  feature: string
}

export default function CompatBadge({ feature }: Props) {
  const snap = useSentinelStore((s) => s.snap)
  const sentinelEnabled = useSettingsStore((s) => s.settings.sentinelEnabled !== false)

  if (!sentinelEnabled || !snap) return null

  const matching = snap.findings.filter(
    (f) => f.status === 'open' && f.kind === 'compat' && f.affectedFeature === feature,
  )

  if (matching.length === 0) return null

  const first = matching[0]
  const label = first.badgeText ?? first.title
  const allTitles = matching.map((f) => f.title).join(' · ')

  return (
    <span
      className="inline-flex items-center rounded-full bg-yellow/15 text-yellow text-[10px] font-medium px-2 py-0.5 shrink-0"
      title={allTitles}
    >
      {label}
    </span>
  )
}
