// WP1.28 -- WP2 slice 3a (plan A5; design 5.4, 5.5): a Codex realm's home is
// derived only from the registry's closed grammar, never from anything
// joinable, and the external home may never overlap the managed homes. PURE
// path arithmetic, on both path flavours.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { codexRealmHome, codexExternalDefaultHome, codexManagedRealmsRoot, codexHomesOverlap, isFullyQualifiedPath, codexHomeDisplay, createCodexPackage } from '../../src/main/providers/codex'
import { memoryFs } from './accounts-harness'

const id = `realm-${'a'.repeat(24)}`
const managed = { id, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'conductor-managed' as const, pathRef: `managed:${id}` }
const external = { ...managed, ownership: 'external-default' as const, pathRef: 'external-default' }

// Upgrade walk D2: the Set up Codex page and Accounts name the folder the
// check used, which is the CODEX_HOME the app inherited when there is one.
describe('the external home as the user is shown it (display only)', () => {
  it('~/.codex for the default; the home shortened to ~ for a CODEX_HOME under it; the full path elsewhere', () => {
    expect(codexHomeDisplay('C:\\Users\\u\\.codex', 'C:\\Users\\u', path.win32)).toBe('~/.codex')
    expect(codexHomeDisplay('c:\\users\\U\\.codex\\', 'C:\\Users\\u', path.win32)).toBe('~/.codex')
    // Walk fix W6: under the home, `/` throughout (never `~\codex-alt`).
    expect(codexHomeDisplay('C:\\Users\\u\\codex-alt', 'C:\\Users\\u', path.win32)).toBe('~/codex-alt')
    expect(codexHomeDisplay('C:\\Users\\u\\work/codex\\', 'C:\\Users\\u', path.win32)).toBe('~/work/codex')
    // On POSIX a backslash is part of a name, and stays.
    expect(codexHomeDisplay('/home/u/we\\ird', '/home/u', path.posix)).toBe('~/we\\ird')
  })

  it('walk fix X4: matched only where certain, cut from the original string; never shortened wrongly', () => {
    const w = (home: string, homeDir: string) => codexHomeDisplay(home, homeDir, path.win32)
    // A dotted capital I (U+0130) in the username: full Unicode lower-casing
    // made it two characters and cut the wrong prefix (`~r/codex`).
    const dottedI = `C:\\Users\\${String.fromCodePoint(0x130)}r`
    expect(w(`${dottedI}\\codex`, dottedI)).toBe('~/codex')
    expect(w(`${dottedI}\\.codex`, dottedI)).toBe('~/.codex')
    // The Kelvin sign (U+212A) is not `K` to NTFS: a different folder, shown in full.
    const kelvin = `C:\\Users\\${String.fromCodePoint(0x212a)}ate\\x`
    expect(w(kelvin, 'C:\\Users\\kate')).toBe(kelvin)
    expect(w(kelvin, 'C:\\Users\\Kate')).toBe(kelvin)
    // ASCII case still folds, and either separator counts.
    expect(w('c:\\users\\U\\codex-alt', 'C:\\Users\\u')).toBe('~/codex-alt')
    expect(w('C:/Users/u/codex-alt', 'C:\\Users\\u')).toBe('~/codex-alt')
    // A trailing separator on the home is tolerated.
    expect(w('C:\\Users\\u\\codex-alt', 'C:\\Users\\u\\')).toBe('~/codex-alt')
    expect(w('C:\\Users\\u\\.codex', 'C:\\Users\\u\\')).toBe('~/.codex')
    expect(codexHomeDisplay('/home/u/codex', '/home/u/', path.posix)).toBe('~/codex')
    // Another spelling of the home stays as written; a sibling is not under it.
    expect(w('\\\\?\\C:\\Users\\u\\codex', 'C:\\Users\\u')).toBe('\\\\?\\C:\\Users\\u\\codex')
    expect(w('C:\\Users\\NICHOL~1\\codex', 'C:\\Users\\nicholas')).toBe('C:\\Users\\NICHOL~1\\codex')
    expect(w('C:\\Users\\u2\\codex', 'C:\\Users\\u')).toBe('C:\\Users\\u2\\codex')
    // A root home shortens nothing.
    expect(w('C:\\codex', 'C:\\')).toBe('C:\\codex')
    expect(codexHomeDisplay('/srv/codex', '/', path.posix)).toBe('/srv/codex')
    expect(codexHomeDisplay('D:\\codex', 'C:\\Users\\u', path.win32)).toBe('D:\\codex')
    expect(codexHomeDisplay('/home/u/.codex', '/home/u', path.posix)).toBe('~/.codex')
    expect(codexHomeDisplay('/home/u/work/codex', '/home/u', path.posix)).toBe('~/work/codex')
    expect(codexHomeDisplay('/srv/codex', '/home/u', path.posix)).toBe('/srv/codex')
    expect(codexHomeDisplay(null, '/home/u', path.posix)).toBeNull()
  })

  it('the Codex package names the folder the CLI finds: the inherited CODEX_HOME, else ~/.codex; none for a CODEX_HOME it cannot use', () => {
    // By the path rules of the folder code that checks it (its realm fs's
    // platform), whatever the host running this.
    const pkgWith = (env: Record<string, string>, platform: 'win32' | 'linux' = 'win32') => createCodexPackage({
      realms: { lookup: async () => ({ ok: false }), mkdirSecure: () => {} },
      realmFs: { ...memoryFs().fs, platform },
      hostHome: { env, homeDir: platform === 'win32' ? 'C:\\Users\\u' : '/home/u' },
    }).externalDefaultRealm!.displayHome!()
    expect(pkgWith({})).toBe('~/.codex')
    expect(pkgWith({ CODEX_HOME: 'C:\\Users\\u\\codex-alt' })).toBe('~/codex-alt')
    expect(pkgWith({ CODEX_HOME: 'D:\\codex' })).toBe('D:\\codex')
    expect(pkgWith({}, 'linux')).toBe('~/.codex')
    expect(pkgWith({ CODEX_HOME: '/home/u/codex-alt' }, 'linux')).toBe('~/codex-alt')
    // Walk fix W6: set but unusable (relative, or two spellings on Windows):
    // main names no folder, so no surface names ~/.codex for it.
    expect(pkgWith({ CODEX_HOME: 'codex-alt' })).toBeNull()
    expect(pkgWith({ CODEX_HOME: 'C:\\a', codex_home: 'C:\\b' })).toBeNull()
    expect(pkgWith({ CODEX_HOME: 'rel/codex' }, 'linux')).toBeNull()
  })
})

describe('managed realm homes', () => {
  it('sit exactly one level under <resources>/codex-realms, named by the realm id (win32 and posix)', () => {
    expect(codexRealmHome(managed, { resourcesDir: 'C:\\Res', externalDefaultHome: null }, path.win32)).toEqual({ ok: true, home: 'C:\\Res\\codex-realms\\' + id })
    expect(codexRealmHome(managed, { resourcesDir: '\\\\server\\share\\Res', externalDefaultHome: null }, path.win32)).toEqual({ ok: true, home: '\\\\server\\share\\Res\\codex-realms\\' + id })
    expect(codexRealmHome(managed, { resourcesDir: '/res', externalDefaultHome: null }, path.posix)).toEqual({ ok: true, home: `/res/codex-realms/${id}` })
    expect(codexManagedRealmsRoot('/res/', path.posix)).toBe('/res/codex-realms')
  })

  it("refuse anything but the realm's own managed reference", () => {
    const roots = { resourcesDir: '/res', externalDefaultHome: '/home/u/.codex' }
    for (const pathRef of [`managed:realm-${'b'.repeat(24)}`, 'managed:../../etc', `managed:${id}/..`, '/etc', `MANAGED:${id}`]) {
      expect(codexRealmHome({ ...managed, pathRef }, roots, path.posix).ok, pathRef).toBe(false)
    }
    expect(codexRealmHome({ ...managed, id: 'realm-../x', pathRef: 'managed:realm-../x' }, roots, path.posix).ok).toBe(false)
  })

  it('refuse a resources directory that is relative, missing, or (Windows) not anchored to a drive or share', () => {
    for (const resourcesDir of ['res', '']) expect(codexRealmHome(managed, { resourcesDir, externalDefaultHome: null }, path.posix).ok, resourcesDir).toBe(false)
    for (const resourcesDir of ['\\Res', '/Res', 'C:Res', '\\\\server', '\\\\.\\pipe\\x']) {
      expect(codexRealmHome(managed, { resourcesDir, externalDefaultHome: null }, path.win32).ok, resourcesDir).toBe(false)
    }
    expect(codexRealmHome({ ...managed, providerId: 'claude' as never }, { resourcesDir: '/res', externalDefaultHome: null }, path.posix).ok).toBe(false)
  })
})

describe('the external default home', () => {
  it('is the inherited CODEX_HOME when fully qualified, else <home>/.codex', () => {
    expect(codexExternalDefaultHome({ CODEX_HOME: '/opt/codex' }, '/home/u', path.posix)).toBe('/opt/codex')
    expect(codexExternalDefaultHome({ codex_home: 'D:\\codex' }, 'C:\\Users\\u', path.win32)).toBe('D:\\codex')
    expect(codexExternalDefaultHome({}, 'C:\\Users\\u', path.win32)).toBe('C:\\Users\\u\\.codex')
    expect(codexExternalDefaultHome({ CODEX_HOME: '' }, '/home/u', path.posix)).toBe('/home/u/.codex')
  })

  it('reads the name exactly as the CLI does: case-sensitively on POSIX', () => {
    expect(codexExternalDefaultHome({ codex_home: '/lower' }, '/home/u', path.posix)).toBe('/home/u/.codex')
  })

  it('never guesses: an unusable CODEX_HOME, two spellings of it, or an unanchored home gives no external home', () => {
    for (const v of ['relative/dir', '~/x', ' /opt/codex', '   ']) expect(codexExternalDefaultHome({ CODEX_HOME: v }, '/home/u', path.posix), JSON.stringify(v)).toBeNull()
    expect(codexExternalDefaultHome({ CODEX_HOME: '\\codex' }, 'C:\\Users\\u', path.win32)).toBeNull()
    expect(codexExternalDefaultHome({ CODEX_HOME: 'C:\\a', codex_home: 'C:\\b' }, 'C:\\Users\\u', path.win32)).toBeNull()
    expect(codexExternalDefaultHome({}, '', path.posix)).toBeNull()
    expect(codexExternalDefaultHome({}, 'rel', path.posix)).toBeNull()
  })

  it('resolves only for the external realm, and only when it is known and fully qualified', () => {
    expect(codexRealmHome(external, { resourcesDir: '/res', externalDefaultHome: '/home/u/.codex' }, path.posix)).toEqual({ ok: true, home: '/home/u/.codex' })
    expect(codexRealmHome(external, { resourcesDir: '/res', externalDefaultHome: null }, path.posix).ok).toBe(false)
    expect(codexRealmHome(external, { resourcesDir: '/res', externalDefaultHome: 'rel' }, path.posix).ok).toBe(false)
    expect(codexRealmHome({ ...external, pathRef: `managed:${id}` }, { resourcesDir: '/res', externalDefaultHome: '/h' }, path.posix).ok).toBe(false)
  })

  it('may never be, contain, or sit inside the managed homes (Windows compares case-insensitively)', () => {
    const win = { resourcesDir: 'C:\\Res', externalDefaultHome: '' }
    for (const home of ['C:\\Res\\codex-realms\\' + id, 'c:\\res\\CODEX-REALMS\\' + id, 'C:\\Res\\codex-realms', 'C:\\Res', 'C:\\', 'C:\\Res\\codex-realms\\x\\y']) {
      expect(codexRealmHome(external, { ...win, externalDefaultHome: home }, path.win32).ok, home).toBe(false)
    }
    expect(codexRealmHome(external, { resourcesDir: '/res', externalDefaultHome: '/res/codex-realms/' + id }, path.posix).ok).toBe(false)
    expect(codexHomesOverlap('/home/u/.codex', '/res', path.posix)).toBe(false)
    expect(codexHomesOverlap('C:\\Res-other\\x', 'C:\\Res', path.win32)).toBe(false)
  })

  it('sees through the spellings Windows treats as the same folder: \\\\?\\, \\\\?\\UNC\\ and trailing dots or spaces', () => {
    for (const home of [`\\\\?\\C:\\Res\\codex-realms\\${id}`, `\\\\?\\c:\\RES\\codex-realms`, `C:\\Res.\\codex-realms\\${id}`, `C:\\Res \\codex-realms.\\${id}. `]) {
      expect(codexHomesOverlap(home, 'C:\\Res', path.win32), home).toBe(true)
    }
    expect(codexHomesOverlap('\\\\?\\UNC\\srv\\share\\Res\\codex-realms', '\\\\srv\\share\\Res', path.win32)).toBe(true)
    // macOS disks usually ignore case: compare case-insensitively on POSIX too (fail closed).
    expect(codexHomesOverlap('/RES/codex-realms', '/res', path.posix)).toBe(true)
  })

  it('fully qualified means a drive or a share on Windows, never the current drive', () => {
    for (const p of ['C:\\x', 'c:/x', '\\\\server\\share', '\\\\?\\C:\\x']) expect(isFullyQualifiedPath(p, path.win32), p).toBe(true)
    for (const p of ['\\x', '/x', 'C:x', '\\\\server', '\\\\.\\pipe\\x', 'x']) expect(isFullyQualifiedPath(p, path.win32), p).toBe(false)
    expect(isFullyQualifiedPath('/x', path.posix)).toBe(true)
  })
})
