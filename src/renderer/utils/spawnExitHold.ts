// src/renderer/utils/spawnExitHold.ts
//
// WP2 commit 6 (docs/wp2/plan.md, "For commit 6 (renderer)"): which pty:exit
// events a terminal view may act on while it is starting the session's PTY.
//
// pty:exit is keyed by session id only, so a view that is about to start the
// session's next PTY also hears the end of the run it replaces: the old PTY's
// late exit (killPty dropped its entry before the process ended), or the
// synthetic exit killPty sends for a replaced spawn that was still being
// prepared. Acted on, either marked the LIVE session exited.
//
// A genuine exit of the PTY a view starts can only arrive AFTER its pty:spawn
// has resolved: main creates that PTY inside the handler just before it
// returns (a deferred start acts only after it returned), node-pty reports an
// exit on a later turn, and the handler's reply and pty:exit travel the same
// ordered IPC channel. So while the view's own spawn is pending or in flight
// an exit is HELD. When the spawn settles:
//   - it started a PTY: the held exit was the replaced run's, and is dropped;
//   - it started nothing (main answered { started: false }, or the user
//     declined the launch): the session has no PTY, so it ends;
//   - this view started nothing but might not be the only one (a spawn that
//     failed, a start left to another path): a held exit ends the session,
//     exactly as it would have before the hold.
// Pure: the view owns one per mount, and does what `settle` returns.

export type SpawnHoldState = 'none' | 'pending' | 'in-flight' | 'settled'

/** How this view's own start ended. */
export type SpawnOutcome =
  /** Its spawn started a PTY. */
  | 'started'
  /** Nothing started, and nothing else will: the session ends. */
  | 'nothing-started'
  /** This view started nothing (its spawn failed, or it left the start to
   *  another path): a held exit is the session's. */
  | 'no-spawn-here'

export interface SpawnExitHold {
  readonly state: SpawnHoldState
  /** An exit arrived: true = act on it now; false = it is held. */
  exit(code: number): boolean
  /** The view is calling pty:spawn. */
  begin(): void
  /** The view's own start ended. `end`: mark the session exited now (with
   *  the held exit's code, when there was one). A second settle does
   *  nothing. */
  settle(outcome: SpawnOutcome): { end: boolean; code: number | null }
}

/** `willSpawn`: this view is about to start the session's PTY (it is not
 *  remounting onto one that is already running). */
export function createSpawnExitHold(willSpawn: boolean): SpawnExitHold {
  let state: SpawnHoldState = willSpawn ? 'pending' : 'none'
  let held: number | null = null
  return {
    get state() { return state },
    exit(code) {
      if (state === 'pending' || state === 'in-flight') { held = code; return false }
      return true
    },
    begin() {
      if (state === 'pending' || state === 'none') state = 'in-flight'
    },
    settle(outcome) {
      if (state === 'settled') return { end: false, code: null }
      const code = held
      state = 'settled'
      held = null
      if (outcome === 'started') return { end: false, code: null }
      if (outcome === 'nothing-started') return { end: true, code }
      return { end: code !== null, code }
    },
  }
}
