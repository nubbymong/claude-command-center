// WP2 PR 4 review fix pass (ADR-009 L3): Windows path names as Windows reads
// them when it starts a program, shared by the provider packages' PATH
// lookups and discovery. [host] Pure functions; no file is read.
import { describe, it, expect } from 'vitest'
import { windowsFolderAsRun, windowsPathHasTrailingDotOrSpace } from '../../../src/main/providers/windows-path-names'

describe('windowsFolderAsRun: a PATH folder named as Windows names it [host]', () => {
  it('drops one trailing dot after another character from each name; keeps a space, two dots, . and .. steps and a share root', () => {
    const cases: Array<[string, string]> = [
      ['C:\\tools.', 'C:\\tools'],
      ['C:\\b\\a.\\bin', 'C:\\b\\a\\bin'],
      ['C:\\b/a./bin', 'C:\\b/a/bin'],
      ['C:\\T..', 'C:\\T..'],
      ['C:\\npm ', 'C:\\npm '],
      ['C:\\a\\npm\\..', 'C:\\a\\npm\\..'],
      ['C:\\a\\.\\bin', 'C:\\a\\.\\bin'],
      ['\\\\srv.\\share.\\bin.', '\\\\srv.\\share.\\bin'],
      ['C:\\plain\\bin', 'C:\\plain\\bin'],
    ]
    for (const [dir, want] of cases) expect(windowsFolderAsRun(dir), dir).toBe(want)
  })
})

describe('windowsPathHasTrailingDotOrSpace [host]', () => {
  it('flags any name below the root that ends in a dot or a space', () => {
    const cases: Array<[string, boolean]> = [
      ['C:\\b\\a.\\bin\\claude.exe', true],
      ['C:\\b\\a \\bin\\claude.exe', true],
      ['C:\\b\\claude.exe.', true],
      ['C:\\b\\claude.exe ', true],
      ['C:\\a\\..\\claude.exe', true],
      ['C:\\Users\\u\\.local\\bin\\claude.exe', false],
      ['C:\\Program Files\\claude\\claude.exe', false],
    ]
    for (const [p, want] of cases) expect(windowsPathHasTrailingDotOrSpace(p), p).toBe(want)
  })
})
