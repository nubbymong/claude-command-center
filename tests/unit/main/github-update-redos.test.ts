/**
 * #111 -- the CHECKSUMS.txt parser must be LINEAR.
 *
 * READ THIS BEFORE CHANGING splitChecksumLine.
 *
 * The first version of this parser used `/^([0-9a-f]{64})\s+\*?(.+)$/i`, which
 * is quadratic. Adversarial review measured 1666 ms at 64k spaces and 27 s at
 * 256k; with the 1 MiB manifest cap the ceiling was around SEVEN MINUTES of a
 * fully blocked Electron main process, because the parse is synchronous and in
 * main. Every terminal frozen, force-kill required.
 *
 * The payload needs two ingredients, both non-obvious:
 *   1. U+2028 LINE SEPARATOR -- matches `\s` but NOT `.`, so the greedy `.+`
 *      fails and `\s+` must give back a character for every position in the run.
 *   2. a non-whitespace tail, so the caller's `line.trim()` cannot eat the run.
 *
 * This is the same shape as the Authorization-header bug fixed in #151 (see
 * conductor-mcp-auth-redos.test.ts) -- reintroduced four commits later in a
 * different file. It is WORSE here: that one was capped by llhttp and
 * http.maxHeaderSize, this one has no limiter and needs only CHECKSUMS.txt
 * bytes, which is strictly less access than the release-write compromise the
 * threat model already concedes.
 *
 * HOW A REGRESSION SHOWS UP: verified by reverting splitChecksumLine to the
 * regex -- this file then HANGS the whole vitest run rather than failing an
 * assertion (10 min, killed manually). That is inherent, not a flaw in the
 * test: a synchronous quadratic regex blocks the event loop, so the runner
 * cannot preempt it and the per-test timeout never fires. If CI ever stalls in
 * this file, the parser has gone non-linear -- that IS the signal.
 */
import { describe, it, expect } from 'vitest'
import { digestForAsset } from '../../../src/main/github-update'

const ASSET = 'ClaudeCommandCenter-Beta-2.1.0.exe'
const DIGEST = 'a'.repeat(64)
const LS = String.fromCharCode(0x2028) // LINE SEPARATOR: matches s, not .

/** The quadratic payload. Do not "simplify" this -- both parts are load-bearing. */
function redosLine(spaces: number): string {
  return DIGEST + ' '.repeat(spaces) + 'x' + LS + 'y'
}

function timeMs(fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('checksum parsing is linear (#111)', () => {
  it('handles the quadratic payload in well under the vulnerable time', () => {
    const line = redosLine(64_000)
    // Correctness first: this is not a valid entry for our asset.
    expect(digestForAsset(line, ASSET)).toBeNull()
    // Pre-fix measured 1666 ms at this size. Linear is sub-millisecond.
    expect(timeMs(() => digestForAsset(line, ASSET))).toBeLessThan(200)
  })

  it('does not blow up super-linearly as the run grows', () => {
    const small = redosLine(16_000)
    const large = redosLine(64_000)
    const tSmall = timeMs(() => digestForAsset(small, ASSET))
    const tLarge = timeMs(() => digestForAsset(large, ASSET))
    // 4x input. Linear ~4x; the vulnerable regex measured ~16x (102 -> 1666 ms).
    expect(tLarge).toBeLessThan(Math.max(tSmall * 10, 200))
  })

  it('stays linear on a full-size manifest at the 1 MiB cap', () => {
    const line = redosLine(500_000)
    expect(timeMs(() => digestForAsset(line, ASSET))).toBeLessThan(500)
  })

  it('a real entry hidden behind a hostile line is still found', () => {
    // The parser must not be made "safe" by bailing out of the whole manifest.
    const manifest = `${redosLine(20_000)}\n${'b'.repeat(64)}  ${ASSET}`
    expect(digestForAsset(manifest, ASSET)).toBe('b'.repeat(64))
  })
})

describe('U+2028 and friends do not confuse the separator (#111)', () => {
  it('rejects a line whose separator run contains a line separator', () => {
    expect(digestForAsset(`${DIGEST}${LS}${ASSET}`, ASSET)).toBeNull()
  })

  it('still accepts the ordinary two-space form', () => {
    expect(digestForAsset(`${DIGEST}  ${ASSET}`, ASSET)).toBe(DIGEST)
  })

  it('still accepts the binary-mode asterisk form', () => {
    expect(digestForAsset(`${DIGEST} *${ASSET}`, ASSET)).toBe(DIGEST)
  })

  it('rejects a digest that is not exactly 64 chars before the separator', () => {
    expect(digestForAsset(`${'a'.repeat(63)}  ${ASSET}`, ASSET)).toBeNull()
    expect(digestForAsset(`${'a'.repeat(65)}  ${ASSET}`, ASSET)).toBeNull()
  })
})
