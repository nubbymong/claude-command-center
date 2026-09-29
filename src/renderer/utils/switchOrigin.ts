// src/renderer/utils/switchOrigin.ts
//
// P3.6 (row 22; VM finding V3): the account a session was switched away from
// by Switch account, kept only until the switched launch starts or is
// declined. A launch that asks first (the sign-in already on this computer is
// confirmed at each launch) and is declined takes the tab back to that
// account, so a Cancel never leaves it half-moved. A Claude switch never asks
// (its restart is predetermined past the account gate), so it has no such
// case. Never persisted: a relaunch starts with none.

const origins = new Map<string, string | undefined>()

/** The switch of `sessionId` away from `from` (undefined: the provider's
 *  default account) has begun. */
export function noteSwitchOrigin(sessionId: string, from: string | undefined): void {
  origins.set(sessionId, from)
}

/** The account the session was switched away from, while its switched launch
 *  has not yet started or been declined; null when there is none. */
export function switchOrigin(sessionId: string): { from: string | undefined } | null {
  return origins.has(sessionId) ? { from: origins.get(sessionId) } : null
}

/** The switched launch started, or was declined: the origin is spent. */
export function forgetSwitchOrigin(sessionId: string): void {
  origins.delete(sessionId)
}
