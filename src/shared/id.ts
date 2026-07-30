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

const ID_BYTES = 16 // 128 bits

/** A cryptographically random, path-safe opaque id, optionally prefixed. */
export function randomId(prefix = ''): string {
  const bytes = new Uint8Array(ID_BYTES)
  globalThis.crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return prefix + hex
}
