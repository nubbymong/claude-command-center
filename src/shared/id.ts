/**
 * Opaque identifier generation, shared by main and renderer.
 *
 * Every id in the app used to be `Date.now().toString(36) + Math.random()...`,
 * duplicated inline in ~15 places. `Math.random()` is not a CSPRNG: V8 seeds a
 * xorshift128+ stream whose internal state is recoverable from a handful of
 * outputs, so subsequent ids are predictable -- and `Date.now()` contributes no
 * entropy at all, it just makes the prefix look unique. CodeQL flagged the two
 * account add / re-auth login flows specifically (js/insecure-randomness, #151);
 * rather than harden two call sites and leave thirteen copies of the same
 * generator behind, all of them route here.
 *
 * `crypto.getRandomValues` (not `crypto.randomUUID`) is the primitive: it is a
 * WebCrypto global in both the Electron main process (Node 18+) and the
 * renderer, and unlike `randomUUID` it does not require a secure context, so it
 * cannot fail depending on how the renderer happens to be loaded.
 *
 * Output is lowercase hex, so an id is always safe to use as a path segment --
 * session ids reach the filesystem as `<resourcesDir>/status/<sessionId>.json`
 * (statusline-watcher.ts).
 */

/**
 * 12 bytes -> 24 hex chars, not the reflexive 16/32.
 *
 * Session ids become filenames at `<resourcesDir>/status/<sessionId>.json`, and
 * the resources dir is user-selected and can be deep. The old ids were 14 chars,
 * so 32 would have moved the legacy Windows MAX_PATH cliff 18 chars closer for a
 * user who has long paths disabled -- and the write that would fail is a bare
 * `catch {}` inside the emitted statusline bridge script, so the symptom is a
 * permanently blank ContextBar with nothing logged.
 *
 * 96 bits is not a compromise on the security property: it is ~7.9e28 values,
 * unguessable by any margin that matters locally, with a birthday bound around
 * 2^48 draws. The property CodeQL flagged is unpredictability, and 96 bits has
 * it; 128 would only have bought path length.
 */
const ID_BYTES = 12

/** A cryptographically random, path-safe opaque id, optionally prefixed. */
export function randomId(prefix = ''): string {
  const bytes = new Uint8Array(ID_BYTES)
  globalThis.crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return prefix + hex
}
