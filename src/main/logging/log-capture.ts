/**
 * log-capture.ts — main-side per-session capture buffer on the hot PTY onData path.
 *
 * Design goals:
 *  - O(1) per record() call: push onto a pre-allocated array, bump a counter, done.
 *  - One coalesced postBatch() call per flush tick (not per session, not per chunk).
 *  - Global byte cap with drop-NEWEST semantics + a visible `dropped` counter that
 *    rides the batch so the worker can turn it into an honest gap marker.
 *  - Session lifecycle forwarded via the CaptureSupervisor surface only — no DB,
 *    no better-sqlite3, no native imports.
 *
 * No default export (project convention).
 */

// ---------------------------------------------------------------------------
// Minimal supervisor surface (structural typing — LogSupervisor satisfies this)
// ---------------------------------------------------------------------------

/** The subset of the logging supervisor that log-capture needs.
 *  Defined here so tests can fake it without importing the full supervisor. */
export interface CaptureSupervisor {
  postBatch(batch: {
    sessions: {
      sessionId: string
      chunks: {
        ts: number
        type: 'start' | 'data' | 'restart' | 'switch' | 'end'
        raw: Uint8Array
      }[]
      dropped?: number
    }[]
  }): void

  startSession(meta: {
    sessionId: string
    configId?: string
    configLabel: string
    projectCwd?: string
    accountEmail?: string
    profileId?: string
    provider: string
    startedAt: number
  }): void

  endSession(sessionId: string, ts: number, status: string): void
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface LogCapture {
  /** Call on session spawn. Forwards to sup.startSession with startedAt=now(). */
  start(
    sessionId: string,
    meta: {
      configId?: string
      configLabel: string
      projectCwd?: string
      accountEmail?: string
      profileId?: string
      provider: string
    }
  ): void

  /** O(1) record of a PTY data chunk. Triggers an immediate flush if global
   *  pending bytes >= the 64 KB size trigger. Applies the global byte cap
   *  (drop-newest) — dropped bytes accumulate on the session's dropped counter
   *  and ride the next batch. */
  record(sessionId: string, data: string | Buffer | Uint8Array): void

  /** Coalesce ALL pending session buffers into ONE postBatch call.
   *  No-ops if nothing is pending. Resets per-session pending arrays + the
   *  global pending-byte counter + per-session dropped counters. */
  flushNow(): void

  /** Flush that session's pending chunks then call sup.endSession.
   *  Drops all per-session state so subsequent flushNow does not include it. */
  end(sessionId: string, status: string): void

  /** Clear the periodic flush timer (call at app/worker shutdown). */
  stop(): void
}

// ---------------------------------------------------------------------------
// Internal per-session state
// ---------------------------------------------------------------------------

interface Chunk {
  ts: number
  type: 'data'
  raw: Uint8Array
}

interface SessionState {
  chunks: Chunk[]
  dropped: number   // accumulated dropped bytes since last flush
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CAP_BYTES  = 12 * 1024 * 1024   // 12 MB global pending cap
const DEFAULT_FLUSH_MS   = 250
const SIZE_TRIGGER_BYTES = 64 * 1024            // flush immediately at 64 KB pending

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LogCapture bound to the given supervisor.
 *
 * @param sup   The logging supervisor (or any fake that satisfies CaptureSupervisor).
 * @param opts  Optional overrides for capBytes, flushMs, now clock.
 */
export function makeCapture(
  sup: CaptureSupervisor,
  opts?: {
    capBytes?: number
    flushMs?: number
    now?: () => number
  }
): LogCapture {
  const capBytes  = opts?.capBytes  ?? DEFAULT_CAP_BYTES
  const flushMs   = opts?.flushMs   ?? DEFAULT_FLUSH_MS
  const now       = opts?.now       ?? (() => Date.now())
  // Size trigger: flush immediately at 64 KB of pending data regardless of capBytes.
  // The cap (capBytes) and the size trigger are orthogonal: the cap guards against
  // unbounded memory growth; the size trigger prevents batches from growing too large.
  const sizeTrigger = SIZE_TRIGGER_BYTES

  // Per-session pending state map.
  const sessions = new Map<string, SessionState>()

  // Global pending byte counter (sum of raw.byteLength for all buffered chunks).
  let globalPendingBytes = 0

  // ---------------------------------------------------------------------------
  // Flush timer — setInterval re-arms automatically.
  // .unref() so it cannot keep the Node/Electron process alive on its own.
  // ---------------------------------------------------------------------------

  const timer = setInterval(() => {
    if (globalPendingBytes > 0) flushNow()
  }, flushMs)
  // Electron / Node setInterval returns a Timeout object with unref().
  ;(timer as unknown as { unref?: () => void }).unref?.()

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  function flushNow(): void {
    // Both guards are needed: globalPendingBytes === 0 is the fast path for the
    // common case (no data at all), but a session with only dropped > 0 and zero
    // buffered chunks has globalPendingBytes === 0 yet MUST still surface its
    // dropped count in the batch (so the worker can insert an honest gap marker).
    // hasPendingSessions() catches that case without iterating further when the
    // fast-path guard fires.
    if (globalPendingBytes === 0 && !hasPendingSessions()) return

    // Build the batch in a single pass over the sessions map.
    const batchSessions: {
      sessionId: string
      chunks: Chunk[]
      dropped?: number
    }[] = []

    for (const [sessionId, state] of sessions.entries()) {
      if (state.chunks.length === 0 && state.dropped === 0) continue
      const entry: { sessionId: string; chunks: Chunk[]; dropped?: number } = {
        sessionId,
        // Live-array handoff: we assign state.chunks and immediately replace
        // state.chunks with a fresh array. postBatch MUST NOT synchronously call
        // back into record() — if it did, the new record() call would push onto
        // the NEW state.chunks array (safe), but a re-entrant flushNow() inside
        // postBatch would observe the stale in-flight array still referenced by
        // `entry.chunks`. postBatch is async / queued today; this note is a
        // guard-rail against future callers making it synchronous-with-re-entry.
        chunks: state.chunks,
      }
      if (state.dropped > 0) entry.dropped = state.dropped
      batchSessions.push(entry)
      // Reset this session's pending state in-place (keep the session alive).
      state.chunks = []
      state.dropped = 0
    }

    // Reset global counter.
    globalPendingBytes = 0

    if (batchSessions.length > 0) {
      sup.postBatch({ sessions: batchSessions })
    }
  }

  /** True if any session has pending chunks or a non-zero dropped count. */
  function hasPendingSessions(): boolean {
    for (const state of sessions.values()) {
      if (state.chunks.length > 0 || state.dropped > 0) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function start(
    sessionId: string,
    meta: {
      configId?: string
      configLabel: string
      projectCwd?: string
      accountEmail?: string
      profileId?: string
      provider: string
    }
  ): void {
    // Initialise per-session state (idempotent: overwrite if session restarts).
    sessions.set(sessionId, { chunks: [], dropped: 0 })
    sup.startSession({ sessionId, ...meta, startedAt: now() })
  }

  function record(sessionId: string, data: string | Buffer | Uint8Array): void {
    // Guard: only buffer data for sessions that are currently active (i.e. have
    // been start()-ed and not yet end()-ed).  A record() for an unknown or already-
    // ended session would otherwise create a ghost SessionState entry.  Downstream,
    // the logging worker's appendBatch inserts events with a FK to the sessions
    // table; a ghost session has no matching startSession row, so its batch entry
    // would violate the FK and roll back the ENTIRE tick's batch for ALL sessions.
    // Early-return here is O(1) and prevents that class of corruption entirely.
    const state = sessions.get(sessionId)
    if (!state) return

    // Normalise to Uint8Array — O(1): Buffer.from(str) allocates once, Uint8Array
    // and Buffer are both already Uint8Array-compatible (no extra copy for binary).
    let raw: Uint8Array
    if (typeof data === 'string') {
      raw = Buffer.from(data, 'utf8')
    } else {
      // Buffer is a subclass of Uint8Array — accept it as-is.
      raw = data instanceof Uint8Array ? data : new Uint8Array(data)
    }

    const byteLen = raw.byteLength

    // Apply global cap (drop-newest).
    if (globalPendingBytes + byteLen > capBytes) {
      // Drop this chunk; accumulate on the (confirmed-active) session's dropped counter.
      state.dropped += byteLen
      return
    }

    // O(1) push.
    state.chunks.push({ ts: now(), type: 'data', raw })
    globalPendingBytes += byteLen

    // Size-trigger: flush immediately (synchronous) when threshold crossed.
    if (globalPendingBytes >= sizeTrigger) {
      flushNow()
    }
  }

  function end(sessionId: string, status: string): void {
    // Flush this session's pending chunks first (as part of a full flush so the
    // global counter stays consistent — other sessions' chunks flush too, which
    // is fine and avoids partial-state complexity).
    if (globalPendingBytes > 0 || hasPendingSessions()) {
      flushNow()
    }
    sessions.delete(sessionId)
    sup.endSession(sessionId, now(), status)
  }

  function stop(): void {
    clearInterval(timer)
  }

  return { start, record, flushNow, end, stop }
}
