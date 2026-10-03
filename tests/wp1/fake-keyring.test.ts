// WP1.11, WP1.72 -- keyring tests inject a fake keyring. The pinned Codex
// CLI owns the OS keyring (the app never touches one), so the fake sits on
// the CLI's side: an injected `run` whose credential store is an in-memory
// keyring keyed exactly as the pinned source keys it (tests/wp1/fixtures/
// codex-keyring-source.json, checked by codex-pinned-source-contract.test.ts):
//   Direct (macOS, Linux): service "Codex Auth", account `cli|` + the first 16
//     hex of sha256(canonical CODEX_HOME); sign-out deletes it.
//   Secrets (Windows): service "codex", account `secrets|<16 hex>` holds the
//     key of <CODEX_HOME>/secrets/codex_auth.age, where the credential lives.
//     Sign-out removes the credential from that file and the Direct entry
//     (storage.rs:403); the key entry itself stays (local.rs:122-129).
// This models a CLI configured to use the keyring (cli_auth_credentials_store
// = keyring); the CLI's default is a file in CODEX_HOME. Driven through the
// app's own Codex auth operations and the accounts service's archive, which
// signs out before it retires the folder. The native smoke on a real keyring,
// with an ephemeral identity and its own residue check, stays OR1's
// (docs/wp1/evidence/keyring-smoke.md).
//
// PURE: no process, no file written, no keyring touched.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createCodexAuthOperations } from '../../src/main/providers/codex'
import type { CodexCommand, CodexDiscovery, CodexRunOptions, CodexRunResult } from '../../src/main/providers/codex'
import { harness, addCodexAccount, managedHome, memoryFs } from './accounts-harness'
import type { CliScript } from './accounts-harness'

type Backend = 'direct' | 'secrets'
const BACKENDS: Backend[] = ['direct', 'secrets']
const sha16 = (p: string) => createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16)
/** The entries the pinned source names, for a canonical home. */
const DIRECT = (canonical: string) => `Codex Auth|cli|${sha16(canonical)}`
const KEY_ENTRY = (canonical: string) => `codex|secrets|${sha16(canonical)}`
/** Windows names compare case-insensitively: the fake filesystem's own name. */
const fold = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()

/** The pinned CLI's keyring store, in memory. `canonical`: what Rust's
 *  canonicalize gives for a home, or the path as given when it cannot
 *  resolve it (`unwrap_or_else`). */
function fakeKeyring(canonical: (home: string) => string) {
  const k = {
    backend: 'direct' as Backend,
    /** `<service>|<account>` -> value. */
    entries: new Map<string, string>(),
    /** canonical home -> the credential in its secrets/codex_auth.age. */
    secretFiles: new Map<string, string>(),
    load: (home: string) => (k.backend === 'direct' ? k.entries.get(DIRECT(canonical(home))) : k.secretFiles.get(canonical(home))),
    save: (home: string, auth: string) => {
      const c = canonical(home)
      if (k.backend === 'direct') return void k.entries.set(DIRECT(c), auth)
      if (!k.entries.has(KEY_ENTRY(c))) k.entries.set(KEY_ENTRY(c), 'generated key')
      k.secretFiles.set(c, auth)
    },
    remove: (home: string) => {
      const c = canonical(home)
      if (k.backend === 'secrets') k.secretFiles.delete(c)
      k.entries.delete(DIRECT(c))
    },
  }
  const status = (home: string): Partial<CodexRunResult> => {
    const v = k.load(home)
    if (v === undefined) return { exitCode: 1, stderr: 'Not logged in\n' }
    return { exitCode: 0, stderr: v === 'api-key' ? 'Logged in using an API key - sk-***0000\n' : 'Logged in using ChatGPT\n' }
  }
  const script: CliScript = {
    'login status': (r) => status(r.home),
    'logout': (r) => { k.remove(r.home); return { exitCode: 0, stdout: 'Successfully logged out\n' } },
    'login': (r) => { k.save(r.home, 'chatgpt'); return { exitCode: 0, stdout: 'Successfully logged in\n' } },
  }
  const run = async (cmd: CodexCommand, opts: CodexRunOptions): Promise<CodexRunResult> => {
    const f = script[cmd.args.join(' ')]
    const out = f ? await f({ args: cmd.args.join(' '), home: opts.env.CODEX_HOME ?? '', env: { ...opts.env }, opts }) : { exitCode: 64 }
    return { exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, ...out }
  }
  return Object.assign(k, { script, run })
}

// The auth operations alone, in a world whose inherited environment names the
// user's own Codex home in two spellings (it must never be the one used).
const RA = `realm-${'a'.repeat(16)}`
const RB = `realm-${'b'.repeat(16)}`
const OWN = 'C:\\Users\\u\\.codex'
const HOME = (id: string) => `C:\\res\\codex-realms\\${id}`
const IDENT = { path: 'C:\\Tools\\codex.exe', size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2' }
const PROVEN: CodexDiscovery = { state: 'found', executable: IDENT.path, identity: IDENT, version: '0.155.1', compatibility: 'supported', checkedAt: 1 }
const managed = (id: string) => ({ id, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'conductor-managed' as const, pathRef: `managed:${id}` })

function authWorld(backend: Backend) {
  const k = fakeKeyring(fold)
  k.backend = backend
  const ops = createCodexAuthOperations({
    lookupRealm: async (r) => (r.authRealmId === RA || r.authRealmId === RB
      ? { ok: true, realm: managed(r.authRealmId), roots: { resourcesDir: 'C:\\res', externalDefaultHome: OWN } } : { ok: false }),
    realmIdentity: (home) => ({ canonical: home, dev: '9', ino: String(parseInt(sha16(fold(home)).slice(0, 8), 16)), isDirectory: true }),
    proven: () => PROVEN,
    executablePorts: { resolve: () => IDENT.path, realpath: (p) => p, stat: () => ({ ...IDENT, isFile: true }), platform: 'win32' },
    baseEnv: async () => ({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', CODEX_HOME: OWN, codex_home: OWN }),
    run: k.run,
    envFilePresent: () => false,
  })
  return { k, ops }
}

describe('the fake is the pinned keyring (WP1.72)', () => {
  it('[host] its services, account prefixes and sign-out match the pinned source; one folder under two spellings is one entry', () => {
    const fixture = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures/codex-keyring-source.json'), 'utf8')) as { versions: Array<{ version: string; sources: Array<{ excerpt: Array<{ text: string }> }> }> }
    for (const v of fixture.versions) {
      const all = v.sources.flatMap((s) => s.excerpt.map((e) => e.text)).join('\n')
      for (const s of ['const KEYRING_SERVICE: &str = "Codex Auth";', 'format!("cli|{truncated}")', 'const KEYRING_SERVICE: &str = "codex";', 'format!("secrets|{short}")',
        'let direct_removed = self.direct_storage.delete()?;', 'let removed = file.secrets.remove(&canonical_key).is_some();']) expect(all, `${v.version}: ${s}`).toContain(s)
    }
    const k = fakeKeyring(fold)
    k.save('C:\\RES\\codex-realms\\x\\', 'chatgpt')
    expect(k.load('c:\\res\\codex-realms\\x')).toBe('chatgpt')
    expect([...k.entries.keys()]).toEqual([DIRECT('c:\\res\\codex-realms\\x')])
    // A Direct entry left from before the store switched to Secrets goes with a Secrets sign-out.
    k.backend = 'secrets'
    k.remove('C:\\res\\codex-realms\\x')
    expect(k.entries.size).toBe(0)
  })
})

describe('two managed realms, two keyring entries (WP1.11)', () => {
  it('[host] each sign-in writes its own realm\'s entry, never the inherited home\'s; status reads only its own', async () => {
    for (const b of BACKENDS) {
      const { k, ops } = authWorld(b)
      expect(await ops.login({ authRealmId: RA }, 'browser'), b).toMatchObject({ ok: true, state: 'signed-in' })
      expect(await ops.status({ authRealmId: RB }), b).toMatchObject({ ok: true, state: 'signed-out' })
      expect(await ops.login({ authRealmId: RB }, 'browser'), b).toMatchObject({ ok: true, state: 'signed-in' })
      const [a, c] = [fold(HOME(RA)), fold(HOME(RB))]
      if (b === 'direct') expect([...k.entries.keys()].sort(), b).toEqual([DIRECT(a), DIRECT(c)].sort())
      else {
        expect([...k.entries.keys()].sort(), b).toEqual([KEY_ENTRY(a), KEY_ENTRY(c)].sort())
        expect([...k.secretFiles.keys()].sort(), b).toEqual([a, c].sort())
      }
    }
  })

  it('[host] signing one realm out removes its credential only; the other stays signed in', async () => {
    for (const b of BACKENDS) {
      const { k, ops } = authWorld(b)
      await ops.login({ authRealmId: RA }, 'browser')
      await ops.login({ authRealmId: RB }, 'browser')
      expect(await ops.logout({ authRealmId: RA }), b).toEqual({ ok: true, state: 'signed-out' })
      expect(await ops.status({ authRealmId: RA }), b).toMatchObject({ ok: true, state: 'signed-out' })
      expect(await ops.status({ authRealmId: RB }), b).toMatchObject({ ok: true, state: 'signed-in' })
      const [a, c] = [fold(HOME(RA)), fold(HOME(RB))]
      if (b === 'direct') expect([...k.entries.keys()], b).toEqual([DIRECT(c)])
      // Secrets: realm A's key entry stays (upstream never deletes it), with no credential under it.
      else expect([[...k.secretFiles.keys()], [...k.entries.keys()].sort()], b).toEqual([[c], [KEY_ENTRY(a), KEY_ENTRY(c)].sort()])
    }
  })
})

describe('retiring an account leaves none of its credential (the residue check, WP1.72)', () => {
  it('[host] the archive signs out first: no credential of the archived account remains; the other account\'s does', async () => {
    for (const b of BACKENDS) {
      const folders = memoryFs()
      const k = fakeKeyring((home) => (folders.dirs.has(fold(home)) ? fold(home) : home))
      k.backend = b
      const h = await harness({ folders, script: k.script })
      const a = await addCodexAccount(h, 'A')
      const other = await addCodexAccount(h, 'B')
      const realmOf = (id: string) => h.doc().accounts.find((x) => x.id === id)!.authRealmId
      const [homeA, homeB] = [fold(managedHome(realmOf(a))), fold(managedHome(realmOf(other)))]
      expect([k.load(homeA), k.load(homeB)], b).toEqual(['chatgpt', 'chatgpt'])
      expect(await h.service.setDefault({ accountId: other }), b).toEqual({ ok: true })
      expect((await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).ok, b).toBe(true)
      expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' }), b).toEqual({ ok: true })
      expect(k.load(homeA), b).toBeUndefined()
      expect(k.entries.has(DIRECT(homeA)), b).toBe(false)
      expect(k.secretFiles.has(homeA), b).toBe(false)
      // What stays for the archived account is the Secrets key entry, which holds no credential.
      expect([...k.entries.keys()].filter((e) => e.endsWith(sha16(homeA))), b).toEqual(b === 'secrets' ? [KEY_ENTRY(homeA)] : [])
      expect(k.load(homeB), b).toBe('chatgpt')
    }
  })
})
