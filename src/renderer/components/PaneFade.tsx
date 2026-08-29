// The terminal half of the canvas ⇄ terminal fade (W23).
//
// The canvas pane fades in on MOUNT — it is created and destroyed by the swap,
// so a class on its root is enough. The terminal container is not: it stays
// mounted the whole time and is merely hidden with `display`, because re-keying
// it would remount xterm and cost the user their scrollback. So the way back
// needs something that notices the cover coming OFF and animates only then.
//
// A component rather than an effect inside App: App renders these inside a
// `.map()` over sessions, where a hook cannot go. The wrapper keeps the div it
// replaces byte-for-byte (same className, same style), so nothing about the
// terminal's layout changes and its children are never re-created.

import React, { useEffect, useRef, useState } from 'react'

/** Belt for the reduced-motion case: `animation: none` fires no `animationend`
 *  at all, so a class waiting on that event would never come off. Comfortably
 *  past the 150ms animation. */
const FADE_CLEAR_MS = 400

export interface PaneFadeProps {
  /**
   * Is an alternative pane (the Agent Canvas) covering this container right
   * now? The fade plays when this goes from true to false — the moment the
   * user comes back — and never on the first render, which is the app starting
   * up rather than a swap.
   */
  covered: boolean
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
  'data-testid'?: string
}

export function PaneFade({ covered, className, style, children, ...rest }: PaneFadeProps): React.JSX.Element {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const wasCovered = useRef(covered)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    // Only the uncovering edge. Guarded by the ref rather than by the effect's
    // dependency alone so React's double-invoke in development cannot play it
    // twice, and so a first mount that starts covered stays quiet.
    if (wasCovered.current && !covered) setFading(true)
    wasCovered.current = covered
  }, [covered])

  useEffect(() => {
    if (!fading) return
    const node = nodeRef.current
    const done = () => setFading(false)
    // A direct listener rather than React's `onAnimationEnd`: the synthetic
    // handler resolves the event name through a feature probe (no global
    // `AnimationEvent` and it waits on the vendor-prefixed name instead), so it
    // is silent in environments where this component is exercised. This names
    // the event the DOM actually fires.
    node?.addEventListener('animationend', done)
    // ...and the timer, because `prefers-reduced-motion` nulls the animation
    // and an animation that never runs never ends. Without it the class would
    // stay on forever for exactly the users who asked for less motion.
    const timer = window.setTimeout(done, FADE_CLEAR_MS)
    return () => {
      node?.removeEventListener('animationend', done)
      window.clearTimeout(timer)
    }
  }, [fading])

  return (
    <div
      ref={nodeRef}
      className={`${className ?? ''}${fading ? ' pane-fade-in' : ''}`}
      style={style}
      data-testid={rest['data-testid']}
    >
      {children}
    </div>
  )
}
