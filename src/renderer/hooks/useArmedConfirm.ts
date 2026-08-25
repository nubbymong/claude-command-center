import { useCallback, useEffect, useRef } from 'react'

/**
 * How long a freshly-armed confirm ignores activation (#456). Windows' default
 * double-click window is 500ms; two clicks inside it are one gesture, not two
 * decisions, and the second must not land on a permanent delete.
 */
export const CONFIRM_GUARD_MS = 600

/**
 * The two-step in-place confirm, made double-click-proof (#456).
 *
 * All the two-step deletes swap the confirm button into the arm button's flex
 * slot, so the old button's footprint sits inside the new one and a fast
 * double-click (or a double Enter — arming moves focus onto the confirm) arms
 * and then fires in one gesture. `armedKey` is the component's own "which row
 * is armed" state; while it has been armed for less than CONFIRM_GUARD_MS,
 * `guarded` swallows activations. The stamp is taken during render, not in an
 * effect, so there is no first frame where the confirm is live.
 *
 * `confirmRef` goes on the confirm button: the arm→confirm element swap drops
 * focus to <body> (keyboard users had to re-tab), so arming moves focus onto
 * the confirm instead.
 */
export function useArmedConfirm(armedKey: string | null): {
  confirmRef: React.RefObject<HTMLButtonElement | null>
  guarded: (fire: () => void) => () => void
} {
  const armedAt = useRef(0)
  const prevKey = useRef<string | null>(null)
  if (prevKey.current !== armedKey) {
    prevKey.current = armedKey
    if (armedKey !== null) armedAt.current = Date.now()
  }

  const confirmRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (armedKey !== null) confirmRef.current?.focus()
  }, [armedKey])

  const guarded = useCallback(
    (fire: () => void) => () => {
      const now = Date.now()
      if (now - armedAt.current < CONFIRM_GUARD_MS) {
        // A blocked activation RE-ARMS the window. Focus sits on the confirm,
        // and a held Enter auto-repeats activation every ~32ms — anchored to
        // the arm moment alone, the repeat would ride the window out and fire.
        // The confirm goes live only after CONFIRM_GUARD_MS of quiet.
        armedAt.current = now
        return
      }
      fire()
    },
    [],
  )

  return { confirmRef, guarded }
}
