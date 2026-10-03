// WP1.11 -- keyring-backed Codex auth stays isolated by CODEX_HOME on the
// pinned CLI: the pinned-source contract. Two halves.
//
// The CLI's half, read from the upstream source at the release tags of the
// pinned and the minimum supported versions (tests/wp1/fixtures/
// codex-keyring-source.json: tag, commit, path, file sha256 and the verbatim
// lines). Both keyring backends name their OS keyring entry after a sha256 of
// the CANONICALISED codex_home -- `cli|<16 hex>` (Direct, the POSIX default)
// and `secrets|<16 hex>` (Secrets, the Windows default, whose encrypted file
// also lives in codex_home/secrets) -- the file store is codex_home/auth.json,
// and codex_home is CODEX_HOME when it is set. A pin bump without a re-read of
// that source fails here.
//
// The app's half: every CLI run's CODEX_HOME is the realm folder it was given,
// whatever the inherited environment says, and two realms never resolve to
// one canonical home. The same halves are covered without naming WP1.11 by
// tests/wp1/env-allowlist.test.ts (the allowlist, WP1.38),
// tests/wp1/codex-realm-folders.test.ts (canonical roots and the external
// overlap, WP1.28/WP1.30) and tests/wp1/codex-realm-isolation.test.ts (two
// real homes through a fake CLI; CI and VM only). The native keyring smoke on
// an ephemeral identity is docs/wp1/evidence/keyring-smoke.md, not this file.
//
// PURE: reads one fixture; every filesystem call goes to an in-memory fake.
// No file is written, no process started, no keyring touched.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CODEX_PINNED_CLI_VERSION, CODEX_MIN_SUPPORTED_VERSION, codexCliEnv, codexRealmHome, codexManagedRealmsRoot, resolveCodexRealmRoots,
} from '../../src/main/providers/codex'
import type { CodexRealmFsPort, CodexFsEntry } from '../../src/main/providers/codex'

interface Excerpt { line: number; text: string }
interface Source { role: string; path: string; sha256: string; what: string; excerpt: Excerpt[] }
interface PinnedVersion { version: string; tag: string; tagObjectSha: string; commitSha: string; fetchedAt: string; sources: Source[] }
const record = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures/codex-keyring-source.json'), 'utf8')) as { wp1: string; versions: PinnedVersion[] }

const ROLES = ['direct-keyring-key', 'secrets-keyring-account', 'secrets-file-and-key-lookup', 'keyring-backend-default', 'codex-home-from-env']
/** One source's excerpt as text, one line per entry. */
const text = (v: PinnedVersion, role: string): string => {
  const s = v.sources.find((x) => x.role === role)
  expect(s, `${v.version}: no ${role} excerpt`).toBeDefined()
  return s!.excerpt.map((e) => e.text).join('\n')
}

describe('the pinned Codex CLI source scopes its credentials by CODEX_HOME (WP1.11)', () => {
  it('[host] the record covers exactly the pinned and the minimum supported CLI, each read at its release tag', () => {
    expect(record.wp1).toBe('WP1.11')
    expect(record.versions.map((v) => v.version).sort()).toEqual([CODEX_PINNED_CLI_VERSION, CODEX_MIN_SUPPORTED_VERSION].sort())
    for (const v of record.versions) {
      expect(v.tag, v.version).toBe(`rust-v${v.version}`)
      expect(v.commitSha, v.version).toMatch(/^[0-9a-f]{40}$/)
      expect(v.tagObjectSha, v.version).toMatch(/^[0-9a-f]{40}$/)
      expect(v.fetchedAt, v.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(v.fetchedAt)), v.version).toBe(false)
      expect(v.sources.map((s) => s.role).sort(), v.version).toEqual([...ROLES].sort())
      for (const s of v.sources) {
        expect(s.path, `${v.version} ${s.role}`).toMatch(/^codex-rs\/[\w/.-]+\.rs$/)
        expect(s.sha256, `${v.version} ${s.role}`).toMatch(/^[0-9a-f]{64}$/)
        expect(s.excerpt.length, `${v.version} ${s.role}`).toBeGreaterThan(0)
        s.excerpt.forEach((e, i) => {
          expect(Number.isInteger(e.line) && e.line > 0, `${v.version} ${s.role} line ${e.line}`).toBe(true)
          if (i > 0) expect(e.line, `${v.version} ${s.role}: lines out of order`).toBeGreaterThan(s.excerpt[i - 1].line)
          expect(/^[\x20-\x7e]*$/.test(e.text), `${v.version} ${s.role} line ${e.line}`).toBe(true)
        })
      }
    }
  })

  it('[host] Direct: the keyring entry is a hash of the canonical CODEX_HOME, and load, save and delete all use it; the file store is inside it', () => {
    for (const v of record.versions) {
      const t = text(v, 'direct-keyring-key')
      expect(t, v.version).toMatch(/fn compute_store_key\(codex_home: &Path\)/)
      expect(t, v.version).toMatch(/let canonical = codex_home\s*\.canonicalize\(\)\s*\.unwrap_or_else\(\|_\| codex_home\.to_path_buf\(\)\);/)
      expect(t, v.version).toMatch(/let path_str = canonical\.to_string_lossy\(\);/)
      expect(t, v.version).toMatch(/hasher\.update\(path_str\.as_bytes\(\)\);/)
      expect(t, v.version).toMatch(/hex\.get\(\.\.16\)/)
      expect(t, v.version).toMatch(/format!\("cli\|\{truncated\}"\)/)
      expect(t.match(/let key = compute_store_key\(&self\.codex_home\)\?;/g), v.version).toHaveLength(3)
      expect(t, v.version).toMatch(/codex_home\.join\("auth\.json"\)/)
      // The Secrets backend is built on the same codex_home.
      expect(t, v.version).toMatch(/new_with_keyring_store_and_namespace\(\s*codex_home\.clone\(\),[\s\S]*LocalSecretsNamespace::CodexAuth,/)
    }
  })

  it('[host] Secrets (the Windows default): the key entry is a hash of the canonical CODEX_HOME too, and the encrypted file lives inside it', () => {
    for (const v of record.versions) {
      const lib = text(v, 'secrets-keyring-account')
      expect(lib, v.version).toMatch(/pub fn compute_keyring_account\(codex_home: &Path\)/)
      expect(lib, v.version).toMatch(/let canonical = codex_home\s*\.canonicalize\(\)\s*\.unwrap_or_else\(\|_\| codex_home\.to_path_buf\(\)\)/)
      expect(lib, v.version).toMatch(/hasher\.update\(canonical\.as_bytes\(\)\);/)
      expect(lib, v.version).toMatch(/hex\.get\(\.\.16\)/)
      expect(lib, v.version).toMatch(/format!\("secrets\|\{short\}"\)/)
      const local = text(v, 'secrets-file-and-key-lookup')
      expect(local, v.version).toMatch(/let account = compute_keyring_account\(&self\.codex_home\);/)
      expect(local, v.version).toMatch(/self\.codex_home\.join\("secrets"\)/)
      expect(text(v, 'keyring-backend-default'), v.version).toMatch(/if cfg!\(windows\) \{\s*Self::Secrets\s*\} else \{\s*Self::Direct\s*\}/)
    }
  })

  it('[host] codex_home is the CODEX_HOME variable when it is set, canonicalised', () => {
    for (const v of record.versions) {
      const t = text(v, 'codex-home-from-env')
      expect(t, v.version).toMatch(/std::env::var\("CODEX_HOME"\)/)
      expect(t, v.version).toMatch(/let canonical = path\.canonicalize\(\)/)
    }
  })
})

// ---------------------------------------------------------------------------
// The app's half.
// ---------------------------------------------------------------------------

const RA = `realm-${'a'.repeat(16)}`
const RB = `realm-${'b'.repeat(16)}`
const managed = (id: string) => ({ id, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'conductor-managed' as const, pathRef: `managed:${id}` })
const external = { ...managed(RA), ownership: 'external-default' as const, pathRef: 'external-default' }

/** An in-memory filesystem with one alias (a SUBST drive, a symlinked
 *  folder): realpath and lstat see through it, as the real ones do. */
function aliasFs(platform: NodeJS.Platform, alias: [string, string], dirs: string[]): CodexRealmFsPort {
  const api = platform === 'win32' ? path.win32 : path.posix
  const fold = (p: string) => (platform === 'win32' ? p.toLowerCase() : p)
  const real = (p: string) => {
    const n = api.normalize(p)
    return fold(n).startsWith(fold(alias[0])) ? alias[1] + n.slice(alias[0].length) : n
  }
  const known = new Map(dirs.map((d, i) => [fold(d), { d, ino: String(100 + i) }]))
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const find = (p: string) => {
    const hit = known.get(fold(real(p)))
    if (!hit) throw enoent()
    return hit
  }
  const unused = () => { throw new Error('not used by this test') }
  return {
    platform,
    realpath: (p) => find(p).d,
    lstat: (p): CodexFsEntry => ({ kind: 'dir', dev: '1', ino: find(p).ino, mode: 0o700 }),
    readdir: (dir) => {
      const base = fold(find(dir).d) + api.sep
      return dirs.filter((d) => fold(d).startsWith(base) && !d.slice(base.length).includes(api.sep)).map((d) => api.basename(d))
    },
    mkdirSecure: unused, mkdir: unused, chmod: unused, unlink: unused, rmdir: unused,
  }
}

const WORLDS = [
  { platform: 'win32' as const, api: path.win32, configured: 'S:\\res', alias: ['S:\\', 'C:\\data\\'] as [string, string], canonical: 'C:\\data\\res', ownHome: 'C:\\Users\\u\\.codex' },
  { platform: 'linux' as const, api: path.posix, configured: '/mnt/link/res', alias: ['/mnt/link/', '/data/'] as [string, string], canonical: '/data/res', ownHome: '/home/u/.codex' },
]
const worldFs = (w: (typeof WORLDS)[number]) => {
  const root = w.api.join(w.canonical, 'codex-realms')
  return aliasFs(w.platform, w.alias, [w.api.dirname(w.canonical), w.canonical, root, w.api.join(root, RA), w.api.join(root, RB)])
}

describe('the app side of the contract: one realm, one CODEX_HOME (WP1.11)', () => {
  it('[host] a CLI run\'s CODEX_HOME is the realm it is given: no inherited spelling, lookalike or prototype entry overrides it', () => {
    for (const w of WORLDS) {
      const home = w.api.join(w.canonical, 'codex-realms', RA)
      const inherited: Record<string, string> = {
        PATH: w.platform === 'win32' ? 'C:\\Windows' : '/usr/bin', CODEX_HOME: w.ownHome, codex_home: w.ownHome, Codex_Home: w.ownHome,
        CODEX_SQLITE_HOME: w.ownHome, 'CODEX_HOME ': w.ownHome,
      }
      const proto = Object.prototype as Record<string, unknown>
      proto.CODEX_HOME = w.ownHome
      try {
        const env = codexCliEnv(inherited, home, w.platform)
        expect(env.CODEX_HOME, w.platform).toBe(home)
        // Exactly one spelling: two would leave the child to pick one.
        expect(Object.keys(env).filter((k) => /^codex_/i.test(k)), w.platform).toEqual(['CODEX_HOME'])
        expect(Object.values(env), w.platform).not.toContain(w.ownHome)
      } finally {
        delete proto.CODEX_HOME
      }
    }
  })

  // The guarantee is the two homes: the pinned CLI keys each entry by its
  // canonical home (above), and these are canonical and distinct. Two keyring
  // entries driven through the app are tests/wp1/fake-keyring.test.ts.
  it('[host] two managed realms resolve to two different homes under the canonical managed root, each a CLI run\'s CODEX_HOME', () => {
    for (const w of WORLDS) {
      const r = resolveCodexRealmRoots({ resourcesDir: w.configured, env: {}, homeDir: '' }, worldFs(w))
      expect(r, w.platform).toMatchObject({ ok: true, roots: { resourcesDir: w.canonical } })
      if (!r.ok) continue
      const root = codexManagedRealmsRoot(w.canonical, w.api)
      const homes = [RA, RB].map((id) => codexRealmHome(managed(id), r.roots, w.api))
      const [a, b] = homes.map((h) => (h.ok ? h.home : null))
      expect(a, w.platform).toBe(w.api.join(root, RA))
      expect(b, w.platform).toBe(w.api.join(root, RB))
      expect(a!.toLowerCase(), w.platform).not.toBe(b!.toLowerCase())
      const env = { PATH: '/usr/bin', CODEX_HOME: w.ownHome }
      expect([codexCliEnv(env, a!, w.platform).CODEX_HOME, codexCliEnv(env, b!, w.platform).CODEX_HOME], w.platform).toEqual([a, b])
    }
  })

  it('[host] an inherited CODEX_HOME that is a managed home under another spelling blocks every realm: no two realms share a canonical home', () => {
    for (const w of WORLDS) {
      // The alias spelling of realm A's home: different text, one folder.
      const spelled = w.api.join(w.configured, 'codex-realms', RA)
      const r = resolveCodexRealmRoots({ resourcesDir: w.configured, env: { CODEX_HOME: spelled }, homeDir: '' }, worldFs(w))
      expect(r.ok, w.platform).toBe(true)
      if (!r.ok) continue
      expect(r.roots.externalConflict, w.platform).toBe(true)
      expect(codexRealmHome(managed(RA), r.roots, w.api).ok, `${w.platform} managed`).toBe(false)
      expect(codexRealmHome(external, r.roots, w.api).ok, `${w.platform} external`).toBe(false)
    }
  })
})
