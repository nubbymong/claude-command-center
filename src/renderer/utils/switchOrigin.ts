// src/renderer/utils/switchOrigin.ts
//
// P3.6 (row 22; VM finding V3): the account a session was switched away from
// by Switch account, and the account it was switched to, kept only until the
// switched launch starts or is declined. A launch on that account that asks
// first (the sign-in already on this computer is confirmed at each launch)
// and is declined takes the tab back, so a Cancel never leaves it half-moved.
// A Claude switch never asks (its restart is predetermined past the account
// gate), so it has no such case. Forgotten when the session's record goes
// (a close, or any restart: sessionStore.removeSession), when a switch's
// restart is refused, and at the switched launch. Never persisted.

/** Where a switch took the session from, and to. `from` undefined: the
 *  provider's default account. */
export interface SwitchOrigin {
  from: string | undefined
  to: string
}

const origins = new Map<string, SwitchOrigin>()

/** The switch of `sessionId` from `from` to `to` has begun (its restart has
 *  run). */
export function noteSwitchOrigin(sessionId: string, from: string | undefined, to: string): void {
  origins.set(sessionId, { from, to })
}

/** Where the session was switched from and to, while its switched launch has
 *  not yet started or been declined; null when there is none. */
export function switchOrigin(sessionId: string): SwitchOrigin | null {
  return origins.get(sessionId) ?? null
}

/** The switched launch started or was declined, the session's record went,
 *  or its switch's restart was refused: the origin is spent. */
export function forgetSwitchOrigin(sessionId: string): void {
  origins.delete(sessionId)
}
