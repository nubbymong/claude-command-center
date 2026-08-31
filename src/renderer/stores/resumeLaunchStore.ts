import { create } from 'zustand'
import type { TerminalConfig } from './configStore'
import type { DetachedRemote } from '../../shared/types'

/**
 * SSH Persistent — "Resume a Running Session" (Phase 2): the one-slot UI store
 * for the resume prompt.
 *
 * A MANUAL config launch that finds one or more matching left-running remotes
 * parks the launch here (config + the candidate entries) instead of spawning, so
 * ResumeSessionDialog can offer Resume / Start fresh / Cancel. Mirrors
 * sshCloseStore's shape. Never persisted — purely ephemeral launch intent. No
 * default export (project convention).
 */
export interface PendingResumeLaunch {
  /** The config the user asked to launch. */
  config: TerminalConfig
  /** Matching, not-currently-live detached remotes to offer for reattach. */
  entries: DetachedRemote[]
}

interface ResumeLaunchState {
  pending: PendingResumeLaunch | null
  request: (p: PendingResumeLaunch) => void
  clear: () => void
}

export const useResumeLaunchStore = create<ResumeLaunchState>((set) => ({
  pending: null,
  request: (p) => set({ pending: p }),
  clear: () => set({ pending: null }),
}))
