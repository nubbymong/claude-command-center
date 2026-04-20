import type { AuthProfile } from '../../../shared/github-types'

interface Props {
  profile: AuthProfile
  onRenew: () => void
}

// Static className map — Tailwind's class scanner cannot resolve dynamic
// `bg-${tone}/10` strings, so we ship the complete class strings here.
const TONE_CLASSES = {
  red: 'bg-red/10 text-red border-red/30',
  peach: 'bg-peach/10 text-peach border-peach/30',
  yellow: 'bg-yellow/10 text-yellow border-yellow/30',
} as const

const DAY_MS = 86_400_000

export default function ExpiryBanner({ profile, onRenew }: Props) {
  if (!profile.expiryObservable || typeof profile.expiresAt !== 'number') return null
  const daysLeft = (profile.expiresAt - Date.now()) / DAY_MS
  if (!Number.isFinite(daysLeft) || daysLeft > 7) return null
  const expired = daysLeft <= 0
  const tone: keyof typeof TONE_CLASSES = expired || daysLeft < 2 ? 'red' : daysLeft < 7 ? 'peach' : 'yellow'
  const whole = Math.max(Math.ceil(daysLeft), 0)
  const message = expired
    ? `${profile.label}: PAT has expired.`
    : `${profile.label}: PAT expires in ${whole} ${whole === 1 ? 'day' : 'days'}.`
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${TONE_CLASSES[tone]} px-3 py-2 text-xs border-b flex items-center gap-2`}
    >
      <span>{message}</span>
      <button
        onClick={onRenew}
        className="bg-surface0 hover:bg-surface1 transition-colors px-2 py-0.5 rounded"
      >
        Renew
      </button>
    </div>
  )
}
