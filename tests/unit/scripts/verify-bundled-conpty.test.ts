import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// P3.15 (row 71), PR-level ADR-009 round 1 (D5): a Windows package must ship
// the conpty.dll and OpenConsole.exe a PTY runs under when it asks for
// node-pty's bundled ConPTY, in the `conpty` folder beside the conpty.node
// node-pty loads (src/main/bundled-conpty.ts
// looks there, in node-pty's loader order). `npm run verify:package`
// (scripts/verify-native-unpack.mjs) fails when either is missing. The check
// is a pure function of the unpacked node_modules folder and a file test, so
// these cases need no package build and touch no file.
import { bundledConptyProblems } from '../../../scripts/verify-bundled-conpty.mjs'

const NM = join('dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules')
const PRE = join(NM, 'node-pty', 'prebuilds', 'win32-x64')
const REL = join(NM, 'node-pty', 'build', 'Release')
const files = (...paths: string[]) => { const set = new Set(paths); return (p: string) => set.has(p) }

describe('verify:package checks the bundled ConPTY files (PR-level ADR-009 round 1, D5)', () => {
  it('passes when both files sit in the conpty folder beside the conpty.node node-pty loads', () => {
    expect(bundledConptyProblems(NM, 'win32', 'x64', files(join(PRE, 'conpty.node'), join(PRE, 'conpty', 'conpty.dll'), join(PRE, 'conpty', 'OpenConsole.exe')))).toEqual([])
  })

  it('fails, naming each, when conpty.dll or OpenConsole.exe is missing', () => {
    expect(bundledConptyProblems(NM, 'win32', 'x64', files(join(PRE, 'conpty.node'), join(PRE, 'conpty', 'conpty.dll')))).toEqual([`${join(PRE, 'conpty', 'OpenConsole.exe')} is missing`])
    expect(bundledConptyProblems(NM, 'win32', 'x64', files(join(PRE, 'conpty.node'), join(PRE, 'conpty', 'OpenConsole.exe')))).toEqual([`${join(PRE, 'conpty', 'conpty.dll')} is missing`])
    expect(bundledConptyProblems(NM, 'win32', 'x64', files(join(PRE, 'conpty.node')))).toHaveLength(2)
  })

  it('looks where node-pty\'s loader looks first: a build/Release conpty.node is the one loaded, and its folder must hold them', () => {
    const both = (d: string) => [join(d, 'conpty', 'conpty.dll'), join(d, 'conpty', 'OpenConsole.exe')]
    expect(bundledConptyProblems(NM, 'win32', 'x64', files(join(REL, 'conpty.node'), join(PRE, 'conpty.node'), ...both(PRE)))).toHaveLength(2)
    expect(bundledConptyProblems(NM, 'win32', 'x64', files(join(REL, 'conpty.node'), ...both(REL)))).toEqual([])
  })

  it('fails when no conpty.node is found for the arch at all; checks nothing off Windows', () => {
    expect(bundledConptyProblems(NM, 'win32', 'arm64', files(join(PRE, 'conpty.node')))).toEqual(["node-pty's conpty.node was not found for win32-arm64"])
    expect(bundledConptyProblems(NM, 'darwin', 'arm64', files())).toEqual([])
    expect(bundledConptyProblems(NM, 'linux', 'x64', files())).toEqual([])
  })

  it('verify-native-unpack.mjs runs the check for every unpacked node_modules folder and fails the package on a problem', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', 'scripts', 'verify-native-unpack.mjs'), 'utf8')
    expect(src).toMatch(/import \{ bundledConptyProblems \} from '\.\/verify-bundled-conpty\.mjs'/)
    expect(src).toMatch(/for \(const problem of bundledConptyProblems\(nm\)\) \{\s*ok = false/)
  })

  it('PR-level ADR-009 round 2 (K6): the release workflow runs verify:package right after each package it ships (Windows, macOS, Linux)', () => {
    // A Windows checkout may have CRLF line ends.
    const yml = readFileSync(resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n')
    for (const pkg of [/npx electron-builder --win --publish never/, /npx electron-builder --mac dmg --publish never/, /npx electron-builder --linux --publish never/]) {
      const at = yml.search(pkg)
      expect(at, String(pkg)).toBeGreaterThan(0)
      // The very next step after the package step is the verify step.
      const next = yml.slice(at).match(/\n\s+- name: ([^\n]+)((?:\n(?!\s+- )[^\n]*)*)/)
      expect(next?.[1], String(pkg)).toBe('Verify native modules unpacked')
      expect(next?.[2], String(pkg)).toMatch(/^\n\s+run: npm run verify:package(\n|$)/)
    }
  })
})
