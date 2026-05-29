// Renderer capture-mode harness.
//
// The capture-training script (scripts/capture-training-screenshots.ts)
// needs to render the real React UI in known states that don't arise
// from a normal user flow -- e.g. a PermissionToast with a fake
// PendingPermission, because demo configs never spawn Claude and so
// no real PreToolUse hook ever fires.
//
// Driving these states from Playwright via direct
// `useChannelStore.getState().setPending(...)` was tried twice on the
// Mac build host and both runs crashed React 18 with `insertBefore`
// NotFoundError. Without flushSync, the setState fires while
// Playwright's evaluate microtask is still in flight; React then
// commits the mount in a different tick where the sibling fiber
// chain has been touched by other automatic renders. Wrapping the
// mutation in flushSync forces the commit to complete inside this
// call -- the toast is fully reconciled, in the DOM, and idle before
// the script's next action.
//
// SECURITY: this exposes Zustand store mutations on `window`. That
// surface is renderer-local React state only. The IPC layer
// (channel-permissions.ts main side) remains the only thing that
// gates real allow/deny actions on Claude sessions, and ignores any
// requestId that wasn't issued by the gateway. A fake injected
// PendingPermission has no effect on main-side state.

import { flushSync } from 'react-dom'
import { useChannelStore } from '../stores/channelStore'
import type { PendingPermission } from '../../shared/channel-types'

export interface CaptureHarness {
  showPermissionToast(p: PendingPermission): void
  clearPermissionToasts(): void
}

const harness: CaptureHarness = {
  showPermissionToast(p) {
    flushSync(() => {
      useChannelStore.getState().setPending([p])
    })
  },
  clearPermissionToasts() {
    flushSync(() => {
      useChannelStore.getState().setPending([])
    })
  },
}

;(window as unknown as { __captureHarness?: CaptureHarness }).__captureHarness = harness
