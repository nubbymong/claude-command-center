/**
 * [host] The README capture's anonymisation scan
 * (scripts/readme-shots/stage/scan-text.js): a user folder is caught however
 * its path is spelled, a version number is not taken for an IP address, and
 * the deny list is refused anywhere inside the checkout, including in a folder
 * whose name starts with two dots.
 *
 * scanText runs on strings only. loadDenyList reads stand-in lists this file
 * writes; it is given its environment as an argument, so the real deny list is
 * never named or read. Writes only inside folders this file makes (its own
 * prefix, directly in the temp folder), removed by that prefix and parent alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'

const STAGE_DIR = resolve(__dirname, '..', '..', '..', 'scripts', 'readme-shots', 'stage')
const req = createRequire(join(STAGE_DIR, 'scan-text.js'))
const SCAN = req('./scan-text.js') as {
  scanText: (text: string, terms?: string[]) => Record<string, number>
  loadDenyList: (env: Record<string, string | undefined>, repoDir?: string | null) => { file: string; terms: string[] }
}
const hits = (text: string): string[] => Object.keys(SCAN.scanText(text, []))

const PREFIX = 'ccc-test-readme-scan-'
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) if (dirname(d) === tmpdir() && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true })
})
/** A checkout stand-in (`repo`) inside a folder of this test's own. */
const layout = (): { base: string; repo: string } => {
  const d = mkdtempSync(join(tmpdir(), PREFIX))
  made.push(d)
  const base = realpathSync.native(d)
  const repo = join(base, 'repo')
  mkdirSync(repo)
  return { base, repo }
}
const writeList = (file: string): string => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '# stand-in\nstand-in-term\n')
  return file
}

describe('user folders', () => {
  it('a Windows user folder is caught with either slash, and a macOS one too', () => {
    for (const s of ['C:\\Users\\alice\\proj', 'C:/Users/alice/proj', 'see D:/Users/bob/notes.md', '/Users/alice/proj', 'open file:///Users/alice/a.png', '"/Users/alice"']) {
      expect(hits(s), s).not.toEqual([])
    }
  })

  // The page text shows a path as the app holds it: in any case, escaped once
  // inside JSON, or as one entry of a colon-separated list.
  it.each([
    ['in lower case', 'c:\\users\\alice\\proj'],
    ['JSON-escaped', '{"cwd":"C:\\\\Users\\\\alice\\\\proj"}'],
    ['after a label and a colon', 'path:/Users/alice/proj'],
    ['inside a PATH list', '/usr/bin:/Users/alice/bin'],
  ])('a user folder %s is caught', (_how, s) => {
    expect(hits(s), s).not.toEqual([])
  })

  it('a project folder, a relative Users folder and a web path are not a user folder', () => {
    for (const s of ['C:\\dev\\web\\storefront', 'C:/dev/notes', '~/.claude.json', '/Applications/AI Code Conductor.app', 'src/components/Users/List.tsx', 'https://api.example.dev/Users/42']) {
      expect(hits(s), s).toEqual([])
    }
  })
})

describe('IPv4 addresses and version numbers', () => {
  it('a real address is caught', () => {
    for (const s of ['10.0.0.5', 'proxy at 192.168.1.20:8080', '(172.16.0.1)', 'it ends at 10.1.2.3.', '255.255.255.0']) {
      expect(hits(s), s).not.toEqual([])
    }
  })

  it('a four-part version number, a longer dotted run and an octet over 255 are not an address', () => {
    for (const s of ['v2.1.1.4', 'version 2.1.1.4', 'Version: 2.1.1.4', 'build 1.2.3.4.5', '999.1.1.1', '10.0.0.256']) {
      expect(hits(s), s).toEqual([])
    }
  })
})

describe('where the deny list may live', () => {
  it('is refused anywhere inside the checkout, a folder named with two dots included', () => {
    const { repo } = layout()
    for (const f of [join(repo, 'deny.txt'), join(repo, 'sub', 'deny.txt'), join(repo, '..foo', 'deny.txt')]) {
      writeList(f)
      expect(() => SCAN.loadDenyList({ CCC_SHOTS_DENYLIST: f }, repo), f).toThrow(/inside the checkout/)
    }
  })

  it('is read from outside the checkout, including a two-dot folder next to it', () => {
    const { base, repo } = layout()
    for (const f of [join(base, 'outside', 'deny.txt'), join(base, '..foo', 'deny.txt'), join(base, 'repo-other', 'deny.txt')]) {
      writeList(f)
      expect(SCAN.loadDenyList({ CCC_SHOTS_DENYLIST: f }, repo), f).toEqual({ file: f, terms: ['stand-in-term'] })
    }
  })

  it('is refused when unset, so a capture that scans cannot start without it', () => {
    const { repo } = layout()
    expect(() => SCAN.loadDenyList({}, repo)).toThrow(/CCC_SHOTS_DENYLIST is not set/)
  })
})
