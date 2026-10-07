/**
 * [host] expandArtifactName gives the file name electron-builder makes from a
 * package.json build.*.artifactName template. The dev-only local installer
 * lookup (ipc/update-handlers.ts) and the updater tests share it, so the two
 * never disagree about a name. Pure: nothing is read but package.json.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { expandArtifactName } from '../../../src/main/artifact-name'

const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'))

describe('expandArtifactName', () => {
  it('substitutes ${version}, ${ext} and ${arch}, wherever and however often each appears', () => {
    expect(expandArtifactName('AICodeConductor-${version}-macos13.${ext}', { version: '2.1.1-beta.2', ext: 'dmg', arch: 'arm64' }))
      .toBe('AICodeConductor-2.1.1-beta.2-macos13.dmg')
    expect(expandArtifactName('AI-Code-Conductor-${version}-linux-${arch}.${ext}', { version: '2.1.1', ext: 'AppImage', arch: 'x86_64' }))
      .toBe('AI-Code-Conductor-2.1.1-linux-x86_64.AppImage')
    expect(expandArtifactName('${arch}-${version}-${arch}.${ext}.${ext}', { version: '1.0.0', ext: 'dmg', arch: 'x64' }))
      .toBe('x64-1.0.0-x64.dmg.dmg')
  })

  it('takes each value as text, never as a replacement pattern', () => {
    expect(expandArtifactName('a-${version}.${ext}', { version: "$&$1$'", ext: 'dmg', arch: 'x64' })).toBe("a-$&$1$'.dmg")
  })

  it('gives no name when another macro is left or the name holds a path separator', () => {
    for (const t of ['${productName}-${version}.${ext}', 'a-${version}-${os}.${ext}', 'dist/a-${version}.${ext}', 'dist\\a-${version}.${ext}']) {
      expect(expandArtifactName(t, { version: '1.0.0', ext: 'dmg', arch: 'x64' }), t).toBeNull()
    }
    for (const version of ['../1.0.0', '..\\1.0.0']) {
      expect(expandArtifactName('a-${version}.${ext}', { version, ext: 'dmg', arch: 'x64' }), version).toBeNull()
    }
  })

  it('package.json\'s Mac, Linux and Windows templates expand to plain names', () => {
    for (const [t, ext] of [[pkg.build.mac.artifactName, 'dmg'], [pkg.build.linux.artifactName, 'AppImage'], [pkg.build.nsis.artifactName, 'exe']]) {
      const name = expandArtifactName(String(t), { version: '2.1.1-beta.2', ext, arch: 'arm64' })
      expect(name, String(t)).toMatch(new RegExp(`^[A-Za-z][A-Za-z0-9.+_-]*\\.${ext}$`))
    }
  })
})
