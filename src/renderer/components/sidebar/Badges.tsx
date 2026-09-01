import React, { useState, useEffect, useRef } from 'react'
import type { TransportBadgeKind } from './transportBadge'

/** How long an exiting chip stays mounted for its fade-out. Slightly over the
 *  220ms CSS animation so the last frame always paints before unmount. */
export const FADE_OUT_MS = 240

/**
 * Soft enter/exit for the presence chips (moon + working pill, RC8): the flags
 * they key on flip abruptly (a silence latch, a 2.5s output window), and a
 * chip popping in/out of the badge row reads as flicker. The slot fades AND
 * collapses its width so neighbours slide rather than jump. On exit it keeps
 * the LAST-rendered child on screen for the fade — the store value backing the
 * chip (e.g. the moon's silentSince) is usually gone the frame the flag
 * clears. Reduced motion: the CSS disables the animations and snaps the exit
 * state, so chips appear/disappear instantly as before.
 */
export function FadeSlot({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [phase, setPhase] = useState<'in' | 'out' | 'gone'>(show ? 'in' : 'gone')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const lastChildren = useRef<React.ReactNode>(null)
  if (show) lastChildren.current = children
  useEffect(() => {
    if (show) {
      setPhase('in')
      return
    }
    if (phaseRef.current === 'gone') return
    setPhase('out')
    const t = setTimeout(() => setPhase('gone'), FADE_OUT_MS)
    return () => clearTimeout(t)
  }, [show])
  if (phase === 'gone') return null
  return (
    <span
      className={`fade-slot ${phase === 'out' ? 'fade-slot-out' : 'fade-slot-in'}`}
      data-testid="fade-slot"
      data-phase={phase}
    >
      {lastChildren.current}
    </span>
  )
}

export function ClaudeBadge({ needsAttention }: { needsAttention: boolean }) {
  const isWorking = !needsAttention
  return (
    <div
      className={`flex items-center justify-center w-4 h-4 rounded shrink-0 transition-colors ${
        isWorking ? 'bg-peach/20 text-peach' : 'bg-blue/20 text-blue'
      }`}
      title={isWorking ? 'Claude is working' : 'Waiting for input'}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none"/>
      </svg>
    </div>
  )
}

export function ShellBadge() {
  return (
    <div
      className="flex items-center justify-center w-4 h-4 rounded shrink-0 bg-sky/15 text-sky"
      title="Terminal only"
      data-testid="type-badge-shell"
    >
      {/* Prompt chevron + a solid block cursor (canvas review 2026-08-19,
          option C). Replaces the code-brackets glyph, which read as "code"
          rather than "a shell" and, in grey, as disabled next to the tinted
          Claude and Codex chips. Sky is the terminal's own hue: peach Claude,
          mauve Codex, sky terminal — SSH stays blue and tmux green, so the
          transport family never shares a colour with the type family. */}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polyline points="4 6 10 12 4 18" fill="none" />
        <rect x="12.5" y="14.5" width="8" height="4" rx="1" stroke="none" />
      </svg>
    </div>
  )
}

export function SshBadge() {
  return (
    <div
      className="flex items-center justify-center h-4 px-1 rounded shrink-0 bg-blue/15 text-blue"
      title="SSH session"
      style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.5px' }}
      data-testid="ssh-badge"
    >
      SSH
    </div>
  )
}

// SSH tmux enhancement (item 9): a distinct badge for a PERSISTENT SSH session
// (running inside a tmux wrapper that survives a dropped connection), so
// persistent vs. plain SSH is legible at a glance in the list. The chain-link
// glyph reads as "stays connected"; the green tint matches the header
// persistence indicator.
export function SshPersistentBadge() {
  return (
    <div
      className="flex items-center justify-center h-4 px-1 gap-0.5 rounded shrink-0 bg-green/15 text-green"
      title="Persistent SSH session — kept alive in tmux; a dropped connection reattaches"
      style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.5px' }}
      data-testid="ssh-persistent-badge"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
      SSH
    </div>
  )
}

// SSH Persistent (resume liveness): an AMBER counter of VERIFIED-live detached
// sessions re-attachable for this config — i.e. sessions the user left running on
// the host that a liveness probe has confirmed are still there. COMPOSES with the
// SshPersistentBadge (it does not replace it). Rendered only when count > 0.
export function SshReattachBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <div
      className="flex items-center justify-center h-4 px-1 gap-0.5 rounded shrink-0 bg-peach/15 text-peach"
      title={`${count} running session${count === 1 ? '' : 's'} left on the host — launch to reattach`}
      style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.5px' }}
      data-testid="ssh-reattach-badge"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5" />
      </svg>
      {count}
    </div>
  )
}

/** The tooltip a container transport chip carries everywhere. The engine's
 *  brand name is deliberately absent from every user-visible string (owner
 *  call, signed-off startup mockup): the app supports two engines and the
 *  badge states the HOP, not the vendor. */
export const CONTAINER_BADGE_TITLE = 'Container session over SSH'

export function containerBadgeTitle(container?: string): string {
  return container ? `${CONTAINER_BADGE_TITLE} — ${container}` : CONTAINER_BADGE_TITLE
}

/** The container mark, at the size each surface needs. Stroke-drawn cargo stack
 *  over a wave — the signed-off startup mockup's glyph (`row-rocky-podman`),
 *  which still reads at 11px where a filled whale silhouette mushed. */
export function ContainerGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="10" width="3.6" height="3.6" />
      <rect x="8.6" y="10" width="3.6" height="3.6" />
      <rect x="13.7" y="10" width="3.6" height="3.6" />
      <rect x="8.6" y="4.9" width="3.6" height="3.6" />
      <path d="M2 17.2c2.2 2.6 7 3.6 11 2.4 3.4-1 5.6-3 6.8-5.6 1 .2 1.9 0 2.2-.6" />
    </svg>
  )
}

// Container-over-SSH transport badge (phase 6; supersedes the composing
// DockerBadge of harmonise-remote Phase 3). A session whose effective runtime
// is a container REPLACES the SSH / SSH-Persistent chip with this one — it is a
// third transport, not an extra sticker: main never tmux-wraps a container
// session (pty-manager: `detachable !== false && !isContainerSession`), so the
// old pairing could only ever read "SSH" + "container", two chips for one fact.
// A 16px teal square, LOGO ONLY: teal keeps it clear of SSH's blue, tmux's
// green and the terminal's sky, and the engine name appears nowhere in the UI.
// The container name lives in the tooltip, not inline (row width).
export function SshContainerBadge({ container }: { container?: string }) {
  return (
    <div
      className="flex items-center justify-center w-4 h-4 rounded shrink-0 bg-teal/15 text-teal"
      title={containerBadgeTitle(container)}
      data-testid="ssh-container-badge"
    >
      <ContainerGlyph size={11} />
    </div>
  )
}

/**
 * The SSH row's ONE transport chip, chosen by `resolveTransportBadge`. Every
 * surface that shows transport renders this, so ConfigRow, Quick Start, the
 * running-session cards and the startup page cannot drift apart again.
 */
export function TransportBadge({ kind, container }: { kind: TransportBadgeKind; container?: string }) {
  if (kind === 'container') return <SshContainerBadge container={container} />
  if (kind === 'persistent') return <SshPersistentBadge />
  if (kind === 'ssh') return <SshBadge />
  return null
}

export function CodexBadge() {
  return (
    <div
      className="flex items-center justify-center w-4 h-4 rounded shrink-0 bg-mauve/20 text-mauve"
      title="Codex"
      data-testid="type-badge-codex"
    >
      {/*
        OpenAI-style mark: rounded lobed outline with a centred plus
        cross, drawn into the same 10x10 viewBox the Claude badge uses
        so layout stays identical. (Not the literal six-arc OpenAI
        rosette -- a simplified glyph that still reads as "OpenAI" at
        the 10px sidebar size where the rosette's detail would mush.)
        Mauve, not green: green is tmux's colour (canvas review 2026-08-19).
      */}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M12 2C9 2 6.5 4 6 7c-2.5 1-4 3.5-4 6.5C2 17 5 20 8.5 20c1.5 0 3-.5 4-1.5 1 1 2.5 1.5 4 1.5 3.5 0 6.5-3 6.5-6.5 0-3-1.5-5.5-4-6.5C18.5 4 15.5 2 12 2z" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    </div>
  )
}

/**
 * The session TYPE badge — exactly one per row, always in the same place.
 *
 * Before this a Claude Code session had no icon at all, Codex and Shell had
 * one inline after the name, and SSH/tmux was a separate text badge in the
 * same spot: four treatments across five cards, and the common case marked
 * by absence. Now every row shows its type here (canvas review 2026-08-19,
 * "one home, every type"); SSH/tmux stay separate badges — they are the
 * transport, not the type — and sit immediately left of this.
 */
export function SessionTypeBadge({ kind }: { kind: 'claude' | 'codex' | 'shell' }) {
  if (kind === 'shell') return <ShellBadge />
  if (kind === 'codex') return <CodexBadge />
  return <ClaudeTypeBadge />
}

/** Claude Code, as a TYPE mark: fixed peach, never attention-coloured. The
 *  older ClaudeBadge above flips colour with attention state and is kept for
 *  the callers that want that. */
export function ClaudeTypeBadge() {
  return (
    <div
      className="flex items-center justify-center w-4 h-4 rounded shrink-0 bg-peach/20 text-peach"
      title="Claude Code"
      data-testid="type-badge-claude"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
        <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" />
      </svg>
    </div>
  )
}

/**
 * Sleeping session (canvas "Session sleep indicator", 2026-08-27): the
 * Watchdog reports the session silent and no attention outranks it. Sits
 * BESIDE the type badge (owner pick: variant B) — the type mark stays, the
 * moon is additional state. Lavender: not an alarm, not the transport/type
 * families' colours. The minute label self-ticks like the watchdog countdown:
 * the store only changes on silent flips, not per minute.
 */
export function MoonBadge({ sinceMs }: { sinceMs: number }) {
  const [, forceTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  const mins = Math.max(1, Math.floor((Date.now() - sinceMs) / 60_000))
  const label = mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m`
  return (
    <div
      className="flex items-center gap-0.5 h-4 px-1 rounded shrink-0 bg-lavender/20 text-lavender"
      title={`Asleep ${label} — no output. Wakes when the Watchdog sees activity; opening the session does not wake it.`}
      data-testid="moon-badge"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.6 14.2A8.8 8.8 0 0 1 9.8 3.4a8.8 8.8 0 1 0 10.8 10.8Z" />
      </svg>
      <span style={{ fontSize: '8px', fontWeight: 700 }}>{label}</span>
    </div>
  )
}

/**
 * Working session (owner call, 2026-08-27): the Claude session's PTY output is
 * MOVING — the inverse of the moon, in the same slot (variant B) and at the
 * same chip weight as every other badge (tinted, not bold). A green play glyph
 * with a gentle pulse; the motion is what says "live". Gated in SessionRow
 * (Claude-only, suppressed by attention and sleep — it can never co-occur with
 * the moon). Pairs with the context-bar sweep, which stays.
 */
export function WorkingBadge() {
  return (
    <div
      className="flex items-center justify-center h-4 px-1 rounded shrink-0 bg-green/20 text-green working-pill"
      title="Claude is working — output is moving"
      data-testid="working-badge"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M8 5v14l11-7z" />
      </svg>
    </div>
  )
}

function formatWatchdogCountdown(totalSeconds: number): string {
  if (totalSeconds >= 3600) return `${Math.round(totalSeconds / 3600)}h`
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}m`
  return `${Math.max(0, totalSeconds)}s`
}

/**
 * Session Watchdog (#235) indicator: hourglass + countdown while a
 * rate-limit/overload/safeguard backoff is in progress, a red badge once the
 * watchdog gives up, nothing while merely monitoring (or when the feature is
 * off / never started for this session — watchdog is then undefined).
 */
export function WatchdogBadge({ watchdog }: { watchdog?: { status: string; waitUntil: number | null; gaveUp: boolean } }) {
  // Self-ticking countdown: the session store only updates on a watchdog
  // STATE CHANGE (waiting entered/cleared/retry sent), not every second, so a
  // local 1s tick is what keeps the displayed countdown from going stale.
  const [, forceTick] = useState(0)
  const waiting = !!watchdog && watchdog.status !== 'monitoring'
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [waiting])

  if (!watchdog) return null

  if (watchdog.gaveUp) {
    return (
      <div
        className="flex items-center justify-center h-4 px-1 rounded shrink-0 bg-red/20 text-red"
        title="Session Watchdog gave up retrying — check the session"
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="7" x2="12" y2="13" />
          <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
        </svg>
      </div>
    )
  }

  if (!waiting) return null

  const secsLeft = watchdog.waitUntil != null ? Math.round((watchdog.waitUntil - Date.now()) / 1000) : null
  const label = secsLeft != null ? formatWatchdogCountdown(secsLeft) : ''

  return (
    <div
      className="flex items-center gap-0.5 h-4 px-1 rounded shrink-0 bg-yellow/20 text-yellow"
      title={`Session Watchdog: ${watchdog.status}${label ? ` — retry in ${label}` : ''}`}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2h12M6 22h12M8 2c0 4 4 6 4 8s-4 4-4 8M16 2c0 4-4 6-4 8s4 4 4 8" />
      </svg>
      {label && <span style={{ fontSize: '8px', fontWeight: 700 }}>{label}</span>}
    </div>
  )
}
