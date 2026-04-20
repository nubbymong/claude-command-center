import { useEffect } from 'react'
import { trackUsage } from '../../stores/tipsStore'

interface Props {
  resetAt: number
}

export default function RateLimitBanner({ resetAt }: Props) {
  // Mark the transparency tip as seen once the banner actually renders, so
  // the tip rotation doesn't double up on users who have hit a rate limit.
  useEffect(() => {
    trackUsage('github.rate-limit-seen')
  }, [])

  const valid = Number.isFinite(resetAt) && resetAt > 0
  // Format guards against NaN/Invalid Date for robustness when the sync
  // status arrives without a nextResetAt (e.g. 'error' state being misused
  // as 'rate-limited' during hot-reload).
  const label = valid ? new Date(resetAt).toLocaleTimeString() : 'soon'

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-yellow/10 text-yellow px-3 py-2 text-xs border-b border-yellow/30"
    >
      GitHub rate-limited. Resumes at {label}.
    </div>
  )
}
