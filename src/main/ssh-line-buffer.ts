/**
 * #242 finding I1: per-session buffer for the not-yet-terminated tail of
 * the `setup ok` completion sentinel line, mirroring `sshOscBuffers`/
 * `extractSshOscSentinels` (in `pty-manager.ts`) -- same per-session map shape, same
 * accumulate-then-clear discipline, same size cap. A real SSH link
 * routinely segments a single logical line across multiple PTY chunks
 * (`setup ok <nonce> tmux=pa` | `th\r\n`); `parseTmuxSentinel`'s
 * chunk-boundary discipline (require the captured token be immediately
 * followed by a line terminator) correctly refuses to match a truncated
 * read off the FIRST chunk alone, but nothing re-parsed the SECOND chunk
 * once the (pre-fix) bare-substring completion latch had already fired off
 * the first one -- the tmux probe was then lost silently for the rest of
 * the session on every segmented line, which is exactly the shape a real
 * SSH connection produces (live-test repro, #242 finding I1). Buffering the
 * accumulated text (not just the latest chunk) and re-testing the SAME
 * nonce-bearing regex against it on every chunk, until it actually
 * resolves, closes that gap.
 */
const MAX_SETUP_LINE_BUFFER = 4096

/**
 * ROUND-3 CORRECTION. The first cut of this buffer covered only the two
 * setup-ok latches, leaving the tier-3/4 stage sentinel and the tier-4 arch
 * probe parsing the raw chunk -- so I1 stayed live on exactly the tiers a
 * tmux-less remote depends on. Proven in review by driving the real flow: a
 * stage `ok path=` split across two chunks never resolves, the flow stalls to
 * the 20s STAGE_TIMEOUT and silently loses tmux; an arch probe split across
 * two chunks leaves detectedArch null, so tier 4 is unreachable on any
 * segmenting link.
 *
 * Each sentinel gets its OWN buffer rather than sharing one, because they can
 * interleave: the arch probe and the stage result are emitted by the same
 * remote fragment and may arrive in one chunk, in either order, or split.
 * Sharing a buffer would let one sentinel's resolve-and-clear discard the
 * other's partial line.
 */
export type SshLineBufferKind = 'setup' | 'stage' | 'arch' | 'runtime'

const sshLineBuffers = new Map<string, string>()
const sshLineBufferKey = (sessionId: string, kind: SshLineBufferKind): string => `${sessionId}:${kind}`

/**
 * Accumulate `chunk` onto session `sessionId`'s setup-line buffer and return
 * the FULL combined text callers should parse against instead of `chunk`
 * alone -- mirroring `extractSshOscSentinels` (in `pty-manager.ts`), which parses the
 * complete combined text first and caps only what it RETAINS for next time.
 * ROUND-2 CORRECTION: an earlier version capped the RETURNED value at
 * `MAX_SETUP_LINE_BUFFER` too, not just what got stored -- so a genuine,
 * correctly-nonced sentinel followed by more than the cap's worth of trailing
 * bytes in the SAME chunk was silently dropped from the text actually
 * parsed, and the session never latched setupDone at all (regression proven
 * in review). The sentinel is not guaranteed to be near the end of the
 * combined text -- trailing output in the same chunk is exactly the failure
 * mode this correction closes -- so only the STORED copy (what the next
 * chunk will be appended to) is capped, keeping its tail. A remote that
 * never emits the line's terminating `\r`/`\n` (hostile, or simply chatty
 * pre-setup output) must not grow the stored buffer without bound for the
 * rest of the session.
 */
export function bufferSshLine(sessionId: string, kind: SshLineBufferKind, chunk: string): string {
  const key = sshLineBufferKey(sessionId, kind)
  const combined = (sshLineBuffers.get(key) ?? '') + chunk
  sshLineBuffers.set(
    key,
    combined.length > MAX_SETUP_LINE_BUFFER ? combined.slice(combined.length - MAX_SETUP_LINE_BUFFER) : combined
  )
  return combined
}

/** Back-compat alias for the setup-ok latches, which read more clearly named. */
export function bufferSetupLine(sessionId: string, chunk: string): string {
  return bufferSshLine(sessionId, 'setup', chunk)
}

/** Drop one of `sessionId`'s sentinel buffers once that sentinel has resolved --
 *  nothing left to accumulate for it for the rest of the session. */
export function clearSshLineBuffer(sessionId: string, kind: SshLineBufferKind): void {
  sshLineBuffers.delete(sshLineBufferKey(sessionId, kind))
}

export function clearSetupLineBuffer(sessionId: string): void {
  clearSshLineBuffer(sessionId, 'setup')
}

/** Teardown: drop EVERY sentinel buffer for the session. Called from
 *  cleanupSessionResources -- a per-kind clear on resolve is not enough,
 *  because a session can die with a sentinel still unresolved. */
export function clearAllSshLineBuffers(sessionId: string): void {
  for (const kind of ['setup', 'stage', 'arch', 'runtime'] as const) clearSshLineBuffer(sessionId, kind)
}

/** Test-only: read the current length of `sessionId`'s setup-line buffer
 *  (mirrors `_getSshNonceForTest`'s role) -- `undefined` once cleared/never
 *  populated. Lets tests assert the buffer is actually bounded and actually
 *  torn down, rather than just asserting on end-to-end launch behaviour that
 *  a leak/unbounded-growth mutation would leave unchanged. */
export function _getSetupLineBufferLenForTest(
  sessionId: string,
  kind: SshLineBufferKind = 'setup',
): number | undefined {
  return sshLineBuffers.get(sshLineBufferKey(sessionId, kind))?.length
}
