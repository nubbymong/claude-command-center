/**
 * [host] P4.11 recapture (review item P411-3): the training screenshot tool's
 * seed now turns Claude Code and Codex on, writes fictional accounts of each
 * and stand-in CLIs, and launches the app with its home, app data and temp
 * folders inside the throwaway data root and no real Claude or Codex on its
 * PATH. The tool itself launches the app, so it never runs here: this pins
 * the seed's files and the launch environment, and re-checks the host-safety
 * point P411-3 raised (a resources path with a space on Windows must not put
 * Codex's hook copies under the real %LOCALAPPDATA%).
 *
 * Also the README staging's data (scripts/readme-shots/stage): its Codex
 * accounts go through the same registry builder, and its seed refuses the VM
 * user's real state.
 *
 * Writes only inside folders this file makes (its own prefix, directly in the
 * temp folder), removed by that prefix and parent alone. Spawns nothing: the
 * stand-in CLIs are compiled, never run.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { basename, delimiter, dirname, join, relative, resolve, isAbsolute } from 'path'
import { tmpdir } from 'os'
import { Script } from 'vm'
import { createRequire } from 'module'
import {
  CAPTURE_CLAUDE_ACCOUNTS, CAPTURE_CODEX_ACCOUNTS, CAPTURE_CLAUDE_VERSION, CAPTURE_PROVIDER_SETTINGS,
  buildCaptureRegistry, buildCodexRegistry, captureAppMetaKeys, seedCaptureProviders, type CodexSeedAccount,
} from '../../../scripts/capture-seed'
import { captureFakeBinDir, captureHomeDir, captureLaunchEnv, captureTempDir, pathWithoutAssistantClis } from '../../../scripts/capture-env'
import { parseRegistryDoc, checkRegistryInvariants } from '../../../src/shared/providers'
import { CLAUDE_MIN_MANAGED_CLI_VERSION } from '../../../src/main/providers/claude/managed-launch'
import { compareVersions } from '../../../src/shared/version-order'
import { codexPlainWrapperDir } from '../../../src/main/providers/codex/hooks'

const PREFIX = 'ccc-test-capture-seed-'
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) if (dirname(d) === tmpdir() && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true })
})
const root = (extra = ''): string => {
  const d = mkdtempSync(join(tmpdir(), PREFIX + extra))
  made.push(d)
  return d
}
const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}
const seed = (r: string): string[] => seedCaptureProviders({
  dataRoot: r, resourcesDir: join(r, 'resources'), homeDir: captureHomeDir(r), fakeBinDir: captureFakeBinDir(r), now: 1_780_000_000_000,
})

describe('the capture seed (P4.11)', () => {
  it('[host] turns both assistants on, Codex\'s on/off answered, and marks this version\'s one-time pages seen', () => {
    expect(CAPTURE_PROVIDER_SETTINGS).toMatchObject({ claudeEnabled: true, codexEnabled: true, codexAnswered: true, loggingConsentSeen: true })
    const meta = captureAppMetaKeys('2.1.1-beta.2')
    expect(meta).toEqual({ lastSeenVersion: '2.1.1-beta.2', lastRunVersion: '2.1.1-beta.2', helloCodexSeenVersion: '2.1.1-beta.2', multiSpawnIntroVersion: '2.1.1-beta.2' })
  })

  it('[host] the Codex registry: two signed-in accounts, the first the default, the second the reviewer', () => {
    const doc = buildCaptureRegistry(1_780_000_000_000)
    expect(checkRegistryInvariants(doc)).toEqual([])
    expect(parseRegistryDoc(JSON.parse(JSON.stringify(doc))).ok).toBe(true)
    const codex = doc.accounts.filter((a) => a.providerId === 'codex')
    expect(codex.map((a) => a.id)).toEqual(CAPTURE_CODEX_ACCOUNTS.map((a) => a.accountId))
    expect(codex.map((a) => a.lastKnownAuthState)).toEqual(['signed-in', 'signed-in'])
    expect(codex.map((a) => a.isProviderDefault === true)).toEqual([true, false])
    expect(codex.map((a) => a.isReviewerDefault === true)).toEqual([false, true])
  })

  it('[host] writes the accounts, the memories and the stand-in CLIs inside the data root only', () => {
    const r = root()
    const written = seed(r)
    expect(written.length).toBeGreaterThan(0)
    for (const f of written) expect(inside(f, r)).toBe(true)
    // Nothing beside the data root's own folders.
    expect(readdirSync(r).sort()).toEqual(['fake-bin', 'resources'])

    const profiles = JSON.parse(readFileSync(join(r, 'resources', 'account-profiles', 'profiles.json'), 'utf8')).profiles
    expect(profiles.map((p: { id: string }) => p.id)).toEqual(CAPTURE_CLAUDE_ACCOUNTS.map((a) => a.id))
    expect(profiles.filter((p: { isPrimary?: boolean }) => p.isPrimary)).toHaveLength(1)
    for (const a of CAPTURE_CLAUDE_ACCOUNTS) {
      expect(a.email).toMatch(/@example\.(com|org|net)$/)
      const cj = JSON.parse(readFileSync(join(r, 'resources', 'account-profiles', a.id, '.claude.json'), 'utf8'))
      expect(cj.oauthAccount.emailAddress).toBe(a.email)
      // No credential file: the stand-in's `auth status` answers instead.
      expect(existsSync(join(r, 'resources', 'account-profiles', a.id, '.claude', '.credentials.json'))).toBe(false)
      // But the home's own .claude folder, or main reads the old layout at
      // start and clears the account (migrateProfilesToHomeLayout).
      expect(existsSync(join(r, 'resources', 'account-profiles', a.id, '.claude'))).toBe(true)
    }

    const reg = parseRegistryDoc(JSON.parse(readFileSync(join(r, 'resources', 'providers', 'registry.json'), 'utf8')))
    expect(reg.ok).toBe(true)
    const [work, review] = CAPTURE_CODEX_ACCOUNTS
    const realm = (id: string) => join(r, 'resources', 'codex-realms', id)
    expect(existsSync(join(realm(work.realmId), 'auth.fake'))).toBe(true)
    expect(existsSync(join(realm(review.realmId), 'auth.fake'))).toBe(true)
    expect(readdirSync(join(realm(work.realmId), 'memories')).sort()).toEqual(['MEMORY.md', 'raw_memories.md', 'rollout_summaries'])
    expect(existsSync(join(realm(review.realmId), 'memories'))).toBe(false)

    const bin = readdirSync(captureFakeBinDir(r))
    if (process.platform === 'win32') expect(bin).toEqual(expect.arrayContaining(['claude.cmd', 'codex.cmd', 'fake-claude.js', 'fake-codex.js']))
    else expect(bin).toEqual(expect.arrayContaining(['claude', 'codex', 'login-shell', 'fake-claude.js', 'fake-codex.js']))
  })

  it('[host] the stand-in CLIs compile, and the stand-in Claude reports a version the app supports', () => {
    const r = root()
    seed(r)
    for (const f of ['fake-claude.js', 'fake-codex.js']) {
      const src = readFileSync(join(captureFakeBinDir(r), f), 'utf8')
      expect(() => new Script(`(function (require, process) {${src}\n})`)).not.toThrow()
    }
    expect(compareVersions(CAPTURE_CLAUDE_VERSION, CLAUDE_MIN_MANAGED_CLI_VERSION)).toBeGreaterThanOrEqual(0)
    const claude = readFileSync(join(captureFakeBinDir(r), 'fake-claude.js'), 'utf8')
    expect(claude).toContain(`'${CAPTURE_CLAUDE_VERSION} (Claude Code)'`)
    // It reads only the profile home's .claude.json and calls no network.
    expect(claude).not.toMatch(/require\('(https?|net|child_process)'\)/)
  })

  it('[host] refuses to seed outside the data root, writing nothing there', () => {
    const r = root()
    const outside = root('outside-')
    expect(() => seedCaptureProviders({
      dataRoot: r, resourcesDir: join(outside, 'resources'), homeDir: captureHomeDir(r), fakeBinDir: captureFakeBinDir(r), now: 1,
    })).toThrow(/not inside the capture's data root/)
    expect(readdirSync(outside)).toEqual([])
    expect(readdirSync(r)).toEqual([])
  })
})

describe('the README staging (P4.11 recapture of the README images)', () => {
  const stage = resolve(__dirname, '..', '..', '..', 'scripts', 'readme-shots', 'stage')
  const C = createRequire(join(stage, 'content.js'))(join(stage, 'content.js')) as {
    CODEX_ACCOUNTS: Array<CodexSeedAccount & { key: string }>
    CONFIGS: Array<{ id: string; provider: string; codexAccountKey?: string; profileKey?: string }>
    SESSIONS: Array<{ provider?: string; codexAccountKey?: string }>
  }

  it('[host] its Codex accounts build a valid registry through the app\'s transitions: a default and a reviewer', () => {
    const doc = buildCodexRegistry(C.CODEX_ACCOUNTS, 1_780_000_000_000)
    expect(checkRegistryInvariants(doc)).toEqual([])
    const codex = doc.accounts.filter((a) => a.providerId === 'codex')
    expect(codex.filter((a) => a.isProviderDefault === true)).toHaveLength(1)
    expect(codex.filter((a) => a.isReviewerDefault === true)).toHaveLength(1)
    for (const a of C.CODEX_ACCOUNTS) expect(a.label).toMatch(/@example\.(com|org|net|io|co|dev)$/)
  })

  it('[host] its Codex config and session name a staged Codex account, not a Claude profile', () => {
    const keys = new Set(C.CODEX_ACCOUNTS.map((a) => a.key))
    const codexConfigs = C.CONFIGS.filter((c) => c.provider === 'codex')
    expect(codexConfigs.length).toBeGreaterThan(0)
    for (const c of codexConfigs) { expect(keys.has(c.codexAccountKey as string)).toBe(true); expect(c.profileKey).toBeUndefined() }
    for (const s of C.SESSIONS.filter((x) => x.provider === 'codex')) expect(keys.has(s.codexAccountKey as string)).toBe(true)
  })

  // The seed's staging-root guard and its C:\dev rules are behaviour-tested in
  // readme-stage.test.ts (P4.11 review C-5).
  it('[host] the fake Claude has no real default folder', () => {
    const fake = readFileSync(join(stage, 'fake-claude.js'), 'utf8')
    expect(fake).not.toMatch(/AppData\/Local\/AI Code Conductor/)
    expect(fake).not.toMatch(/C:\/Users\/User/)
  })
})

describe('the capture launch environment (P4.11, P411-3)', () => {
  it('[host] puts the app data and temp folders in the data root and the stand-in CLIs first on a PATH without any real Claude or Codex', () => {
    const r = root()
    const withClaude = join(r, 'pathdirs', 'npm')
    const withCodex = join(r, 'pathdirs', 'standalone')
    const plain = join(r, 'pathdirs', 'tools')
    for (const d of [withClaude, withCodex, plain]) mkdirSync(d, { recursive: true })
    writeFileSync(join(withClaude, 'claude.cmd'), '')
    writeFileSync(join(withCodex, 'codex.exe'), '')
    writeFileSync(join(plain, 'tool.exe'), '')
    const real = 'C:\\Users\\someone'
    const env = captureLaunchEnv(r, {
      Path: [withClaude, plain, withCodex, ''].join(delimiter), USERPROFILE: real, LOCALAPPDATA: `${real}\\AppData\\Local`, APPDATA: `${real}\\AppData\\Roaming`,
      TEMP: `${real}\\AppData\\Local\\Temp`, TMP: `${real}\\AppData\\Local\\Temp`, CODEX_HOME: `${real}\\.codex`,
    })
    const home = captureHomeDir(r)
    expect(env.LOCALAPPDATA).toBe(join(home, 'AppData', 'Local'))
    expect(env.APPDATA).toBe(join(home, 'AppData', 'Roaming'))
    expect(env.TEMP).toBe(captureTempDir(r))
    expect(env.TMP).toBe(captureTempDir(r))
    for (const k of ['LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) expect(inside(env[k], r)).toBe(true)
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toEqual(['PATH'])
    expect(env.PATH.split(delimiter)).toEqual([captureFakeBinDir(r), plain])
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'codex_home')).toEqual([])
    for (const d of [join(home, 'AppData', 'Local'), join(home, 'AppData', 'Roaming'), captureTempDir(r)]) expect(existsSync(d)).toBe(true)
  })

  it('[host] pathWithoutAssistantClis drops every folder holding a Claude or Codex, quoted or not', () => {
    const has = new Set(['/a/claude', '/b/codex.cmd', '/d/claude.exe'])
    const exists = (p: string) => has.has(p.replace(/\\/g, '/'))
    expect(pathWithoutAssistantClis('/a|/b||/c|"/d"', '|', exists)).toEqual(['/c'])
  })

  it('[host] P411-3: with a data root whose path has a space, Codex\'s hook copies never go under the real local app data folder', () => {
    for (const extra of ['plain-', 'with space-']) {
      const r = root(extra)
      const realLocal = process.env.LOCALAPPDATA
      const env = captureLaunchEnv(r)
      const resources = join(r, 'resources')
      const plainDir = codexPlainWrapperDir(env.LOCALAPPDATA, resources)
      // Either no plain copy at all (the path is not a plain word), or one
      // inside the data root -- never under the real folder.
      if (plainDir !== null) expect(inside(plainDir, r)).toBe(true)
      if (realLocal && plainDir !== null) expect(inside(plainDir, realLocal) && !inside(plainDir, r)).toBe(false)
      if (extra === 'with space-') expect(plainDir).toBeNull()
      // The hazard this guards: with the real folder (the environment before
      // P4.11), a data root with a space put the copies outside the root.
      if (extra === 'with space-' && process.platform === 'win32' && realLocal && !/\s/.test(realLocal)) {
        const before = codexPlainWrapperDir(realLocal, resources)
        expect(before).not.toBeNull()
        expect(inside(before as string, r)).toBe(false)
      }
    }
  })

  it('[host] the capture script seeds the providers and launches the app with Electron\'s user data and working folder in the data root', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', 'scripts', 'capture-training-screenshots.ts'), 'utf8')
    expect(src).toMatch(/seedCaptureProviders\(\{/)
    expect(src).toMatch(/args: \[BUILT_APP, `--user-data-dir=\$\{path\.join\(dataRoot, 'electron-userdata'\)\}`\]/)
    expect(src).toMatch(/cwd: dataRoot,/)
    expect(src).toMatch(/\.\.\.CAPTURE_PROVIDER_SETTINGS/)
    expect(src).toMatch(/\.\.\.captureAppMetaKeys\(APP_VERSION\)/)
    expect(src).not.toMatch(/lastSeenVersion: '99\.99\.99'/)
  })

  it('[host] the capture script edits and launches configs from the Saved tab, closes dialogs as a user does, and ends a hung app\'s whole tree', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', 'scripts', 'capture-training-screenshots.ts'), 'utf8')
    // The config rows live on the sidebar's Saved tab (it opens on Running).
    expect(src).toMatch(/panel-tab-\$\{t\}/)
    expect(src).toMatch(/\[data-testid="config-row"\]/)
    // Deleting every `.fixed` element took the app's dialog layer with it.
    expect(src).not.toMatch(/querySelectorAll\('\.fixed'\)/)
    // A plain kill of the main process left the Electron tree running on Windows.
    expect(src).toMatch(/execFileSync\('taskkill', \['\/pid', String\(pid\), '\/T', '\/F'\]/)
    expect(src).not.toMatch(/child\.kill\('SIGKILL'\)/)
  })
})
