/**
 * Containment regression guard for canonicalizeTranscriptPath.
 *
 * The input to this function is NOT trusted. It arrives from an SSH host's
 * statusline sentinel and from hook payloads, so a remote party chooses it.
 * `path.join` NORMALISES `..` rather than rejecting it, so a crafted suffix
 * walked out of `~/.claude/projects` and resolved to an arbitrary file on the
 * same drive, which the binder would then open and tail.
 *
 * Every case below returns a real, resolvable path under the pre-fix code --
 * that is what makes them repros rather than smoke tests.
 */
import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { canonicalizeTranscriptPath } from '../../../src/main/logging/transcript-discovery'

const HOME = os.homedir()
const ROOT = path.join(HOME, '.claude', 'projects')

describe('canonicalizeTranscriptPath containment', () => {
  const escapes = [
    ['climbs out to a sibling of HOME', '/x/.claude/projects/../../../../../../Windows/win.ini'],
    ['reaches a dotfile beside the projects root', '/x/.claude/projects/../../.ssh/id_rsa'],
    ['reaches the credential store', '/x/.claude/projects/../.credentials.json'],
    ['escapes with backslash separators', 'C:\\x\\.claude\\projects\\..\\..\\..\\secrets.jsonl'],
    ['escapes after a legitimate-looking prefix', '/x/.claude/projects/proj/../../../../etc/passwd'],
    ['escapes with a mixed separator run', '/x/.claude/projects/a/..\\../..//../id_rsa'],
  ] as const

  for (const [label, input] of escapes) {
    it(`returns null when the path ${label}`, () => {
      expect(canonicalizeTranscriptPath(input)).toBeNull()
    })
  }

  it('is not fooled by a sibling directory sharing the root prefix', () => {
    // A bare startsWith(root) check passes this; the separator-terminated
    // comparison does not.
    const input = '/x/.claude/projects/../projects-evil/conv.jsonl'
    const result = canonicalizeTranscriptPath(input)
    expect(result).toBeNull()
  })

  // NOTE: no extension filter is asserted here. An earlier draft of the fix
  // rejected anything not ending `.jsonl`; that broke two documented cases --
  // the function returns the bare projects root when the input ends exactly at
  // the `.claude/projects` segment. Containment is the security control, and
  // narrowing what a contained path may point at belongs to the caller.
  it('still returns the bare projects root, which is contained', () => {
    expect(canonicalizeTranscriptPath('/x/.claude/projects')).toBe(ROOT)
    expect(canonicalizeTranscriptPath('/x/.claude/projects/')).toBe(ROOT)
  })

  it('every accepted path resolves inside the projects root', () => {
    const accepted = [
      '/x/.claude/projects/f--x/a.jsonl',
      'F:\\RES\\p1\\.claude\\projects\\f--x\\a.jsonl',
      path.join(ROOT, 'F--MY-PROJECT', 'conv-uuid.jsonl'),
      // `..` that stays inside the root is fine -- containment, not a ban on dots.
      '/x/.claude/projects/a/../b/conv.jsonl',
    ]
    for (const input of accepted) {
      const result = canonicalizeTranscriptPath(input)
      expect(result, `expected a path for ${input}`).not.toBeNull()
      expect(path.resolve(result!).startsWith(path.resolve(ROOT) + path.sep)).toBe(true)
    }
  })

  it('still canonicalises the ordinary case correctly', () => {
    expect(canonicalizeTranscriptPath('/x/.claude/projects/a/../b/conv.jsonl')).toBe(
      path.join(ROOT, 'b', 'conv.jsonl'),
    )
  })
})
