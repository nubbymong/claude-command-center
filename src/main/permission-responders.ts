// src/main/permission-responders.ts
//
// Maps a hook requestId to the function that replies to the originating hook.
// Lives in its own module so the hook gateway can register a responder
// without pulling channel-permissions (which would create a circular import:
// channel-permissions -> hooks/index -> hooks-gateway -> permission-responders
// is a clean DAG; channel-permissions -> hooks/index back to channel-permissions
// is what the lazy `require` in the gateway used to dodge).

// 'defer' = close the held-open response with an empty body so Claude Code
// proceeds with its OWN permission flow (used when the tray is full and we
// cannot surface another card). It is NOT an allow and NOT a deny.
export type PermissionDecision = 'approved' | 'denied' | 'defer'
type Responder = (decision: PermissionDecision) => void

const responders = new Map<string, Responder>()

export function registerResponder(requestId: string, fn: Responder): void {
  responders.set(requestId, fn)
}

/** Remove a responder without invoking it (timeout, client abort, dedup). */
export function deregisterResponder(requestId: string): void {
  responders.delete(requestId)
}

/** Invoke the responder if present and drop it. Safe to call when missing. */
export function resolveResponder(requestId: string, decision: PermissionDecision): void {
  const fn = responders.get(requestId)
  responders.delete(requestId)
  fn?.(decision)
}

/** Test helper. Production callers should not need this. */
export function _resetResponders(): void {
  responders.clear()
}

/** Test helper -- size of the map for assertions. */
export function _responderCount(): number {
  return responders.size
}
