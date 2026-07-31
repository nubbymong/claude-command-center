/**
 * #111 -- installer integrity verification.
 *
 * The updater hands a downloaded file to the OS to execute. Before this, no
 * platform did a client-side integrity check. `digestForAsset` is the parse
 * half of the control, and it is the half an attacker shapes input for: the
 * manifest is a text file fetched over the network.
 *
 * The critical property is FAIL CLOSED -- every ambiguous or malformed case
 * must return null, because the caller treats null as "discard the download".
 * A parser that returns a digest it is not sure about is worse than no parser.
 */
import { describe, it, expect } from 'vitest'
import { digestForAsset } from '../../../src/main/github-update'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ASSET = 'ClaudeCommandCenter-Beta-2.1.0.exe'

describe('digestForAsset -- accepts real sha256sum output', () => {
  it('parses the two-space form sha256sum emits', () => {
    expect(digestForAsset(`${A}  ${ASSET}`, ASSET)).toBe(A)
  })

  it('parses the binary-mode form (asterisk prefix)', () => {
    expect(digestForAsset(`${A} *${ASSET}`, ASSET)).toBe(A)
  })

  it('picks the right line out of a multi-asset manifest', () => {
    const manifest = [
      `${B}  ClaudeCommandCenter-Beta-2.1.0-mac.dmg`,
      `${A}  ${ASSET}`,
      `${B}  ClaudeCommandCenter-Beta-2.1.0.AppImage`,
    ].join('\n')
    expect(digestForAsset(manifest, ASSET)).toBe(A)
  })

  it('tolerates CRLF, blank lines and comments', () => {
    const manifest = `# generated\r\n\r\n${A}  ${ASSET}\r\n`
    expect(digestForAsset(manifest, ASSET)).toBe(A)
  })

  it('normalises an upper-case digest', () => {
    expect(digestForAsset(`${A.toUpperCase()}  ${ASSET}`, ASSET)).toBe(A)
  })

  it('strips a path prefix on the filename', () => {
    expect(digestForAsset(`${A}  ./artifacts/${ASSET}`, ASSET)).toBe(A)
  })
})

describe('digestForAsset -- fails closed', () => {
  const mustBeNull: [string, string][] = [
    ['empty manifest', ''],
    ['asset absent -- the one-line-deletion bypass', `${B}  some-other-file.dmg`],
    ['digest too short', `${'a'.repeat(63)}  ${ASSET}`],
    ['digest too long', `${'a'.repeat(65)}  ${ASSET}`],
    ['digest not hex', `${'z'.repeat(64)}  ${ASSET}`],
    ['no separator', `${A}${ASSET}`],
    ['filename only', ASSET],
    ['digest only', A],
    ['html error page served instead of the manifest', '<!DOCTYPE html><html>404</html>'],
  ]

  for (const [label, manifest] of mustBeNull) {
    it(`returns null: ${label}`, () => {
      expect(digestForAsset(manifest, ASSET)).toBeNull()
    })
  }

  it('returns null when the asset name is empty', () => {
    expect(digestForAsset(`${A}  ${ASSET}`, '')).toBeNull()
  })

  it('refuses a manifest listing the SAME asset twice with DIFFERENT digests', () => {
    // Injecting a second line is the cheapest way to attack a parser that
    // takes first-match or last-match. Ambiguous means refuse.
    const manifest = `${A}  ${ASSET}\n${B}  ${ASSET}`
    expect(digestForAsset(manifest, ASSET)).toBeNull()
  })

  it('accepts a benign exact duplicate line', () => {
    expect(digestForAsset(`${A}  ${ASSET}\n${A}  ${ASSET}`, ASSET)).toBe(A)
  })
})

describe('digestForAsset -- name matching is exact, not fuzzy', () => {
  it('does not match a filename that merely contains the asset name', () => {
    expect(digestForAsset(`${A}  evil-${ASSET}`, ASSET)).toBeNull()
  })

  it('does not match a filename the asset name is a prefix of', () => {
    expect(digestForAsset(`${A}  ${ASSET}.bak`, ASSET)).toBeNull()
  })

  it('is case-sensitive on the filename', () => {
    expect(digestForAsset(`${A}  ${ASSET.toUpperCase()}`, ASSET)).toBeNull()
  })
})
