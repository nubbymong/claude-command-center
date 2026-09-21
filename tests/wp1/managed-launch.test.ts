// WP1.38 (slice 2): the managed-launch hardening.
//
// WP1.38 is "the selected binding is converted to the exact realm env on every
// launch; ambient poisoning cannot override it". The owner's ruling of
// 2026-09-20 widened what "ambient poisoning" has to mean: the environment is
// not the only source that can override a bound realm. Claude Code also reads
// SETTINGS files, and the app writes one of them into every managed profile.
// So this suite covers the environment and the settings sources together.
//
// Four layers, and this suite covers the security property of each:
//   1. ambient authority variables are stripped from every managed launch;
//   2. the app-owned settings copy is sanitised, and ONLY where it should be;
//   3. CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 is applied LAST and cannot be
//      overwritten -- by a provider, by the inherited environment, or by case;
//   4. the preflight makes a missing control loud without blocking a launch
//      over settings the proven mechanism already suppresses.
//
// The behaviour under test is proven, not assumed: see
// docs/wp1/evidence/claude-settings-isolation-2026-09-21.md for the probe
// matrix against Claude Code 2.1.278 that established the control.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path, { resolve } from 'node:path'
import { applyRealmEnvPatch } from '../../src/shared/providers'
import {
  CLAUDE_AUTHORITY_VARIABLES, CLAUDE_AUTHORITY_ENV_VARIABLES, CLAUDE_HOST_MANAGED_ENV,
  CLAUDE_COMMAND_HELPER_SETTINGS_KEYS, CLAUDE_MIN_MANAGED_CLI_VERSION,
  sanitizeClaudeManagedSettings, claudeManagedCliCompatibility, claudeManagedLaunchPreflight,
  createClaudePackage,
} from '../../src/main/providers/claude'
import { createCodexPackage } from '../../src/main/providers/codex'
import {
  registerProviderPackage, packageRegistrationProblem, _resetProviderRegistryForTest,
  realmEnvForProvider, hostManagedEnvForProvider,
  sanitizeManagedSettingsFor, managedLaunchPreflightFor, minimumManagedCliVersionFor,
} from '../../src/main/providers/core'
import * as providerCore from '../../src/main/providers/core'
import { composeProviders } from '../../src/main/providers/compose'

const HOST_KEY = 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'

/** Production files that compose a profile-home environment WITHOUT going
 *  through the managed-launch choke point, one entry per offending line.
 *
 *  Pure, so the self-test below can feed it synthetic violations -- a
 *  source-scanning guard nobody has seen fail is decoration.
 *
 *  Two things make it hard to buy your way out of:
 *   1. the exemption is a PATH allowlist plus a PER-LINE check, never a
 *      whole-file "does this file mention withProfileHome". That earlier form
 *      exempted every file that CALLS the choke point -- including
 *      claude-cli-auth.ts, the exact file the guard was written to catch -- so
 *      a second hand-built env in one of them passed silently, and a comment
 *      naming the function bought the exemption outright;
 *   2. it matches HOME as well as USERPROFILE (the POSIX sibling selects the
 *      same realm on Linux) and property assignment as well as object
 *      literals, so `env.HOME = profileDir` is not a way around it. */
export function profileHomeEnvOffenders(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const ALLOWED = new Set(['src/main/account-profiles.ts'])   // the choke point itself
  const LITERAL = /(^|[^%\w])(USERPROFILE|HOME)\s*:/               // { USERPROFILE: home }
  const ASSIGN = /(\.|\['|\[")(USERPROFILE|HOME)('\]|"\])?\s*=[^=]/ // env.HOME = home
  const offenders: string[] = []
  for (const f of files) {
    if (ALLOWED.has(f.path)) continue
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (!LITERAL.test(line) && !ASSIGN.test(line)) return
      // Re-applying a variable ON the choke point's own result is legal --
      // claude-cli-auth re-sets HOME unconditionally for the macOS keychain
      // reason withProfileHome documents. Scoped to THAT line, so a hand-built
      // env elsewhere in the same file still fails.
      if (line.includes('withProfileHome')) return
      offenders.push(`${f.path}:${i + 1}  ${line.trim()}`)
    })
  }
  return offenders
}

// ---------------------------------------------------------------------------
// Layer 3 mechanism: applied last, and nobody else can set it.
// ---------------------------------------------------------------------------
describe('host-managed controls are applied last and cannot be overwritten', () => {
  const policy = {
    ambientAuthVariables: ['ANTHROPIC_API_KEY'],
    ownedVariables: ['USERPROFILE'],
    hostManagedEnv: { [HOST_KEY]: '1' },
  }

  it('applies the control even when nothing else in the launch mentions it', () => {
    const env = applyRealmEnvPatch({ PATH: '/x' }, { set: { USERPROFILE: '/home/a' } }, policy)
    expect(env[HOST_KEY]).toBe('1')
  })

  it('overwrites an INHERITED value rather than letting the environment win', () => {
    const env = applyRealmEnvPatch({ [HOST_KEY]: '0' }, { set: {} }, policy)
    expect(env[HOST_KEY]).toBe('1')
  })

  it('removes every case-variant so a lower-cased twin cannot shadow it', () => {
    // On Windows `claude_code_provider_managed_by_host` and the canonical
    // spelling are THE SAME VARIABLE. Leaving the variant behind would let a
    // poisoned parent environment decide which one the child resolves.
    const env = applyRealmEnvPatch(
      { claude_code_provider_managed_by_host: '0', Claude_Code_Provider_Managed_By_Host: 'no' },
      { set: {} },
      policy,
    )
    expect(env[HOST_KEY]).toBe('1')
    expect(Object.keys(env).filter((k) => k.toLowerCase() === HOST_KEY.toLowerCase())).toEqual([HOST_KEY])
  })

  it('refuses a realm patch that tries to SET a host control', () => {
    expect(() => applyRealmEnvPatch({}, { set: { [HOST_KEY]: '0' } }, policy))
      .toThrow(/host-managed control and cannot be set or unset/)
  })

  it('refuses a realm patch that tries to UNSET a host control', () => {
    expect(() => applyRealmEnvPatch({}, { set: {}, unset: [HOST_KEY] }, policy))
      .toThrow(/host-managed control and cannot be set or unset/)
  })

  it('refuses it by any case-variant spelling, not just the canonical one', () => {
    expect(() => applyRealmEnvPatch({}, { set: { claude_code_provider_managed_by_host: '0' } }, policy))
      .toThrow(/host-managed control and cannot be set or unset/)
  })

  it('is applied AFTER the patch even when the patch also owns the key name', () => {
    // A package that declared the host key as its own owned variable would, on
    // "last write wins" alone, be able to set it. Ownership is checked after
    // the host check, so the refusal stands.
    const widened = { ...policy, ownedVariables: ['USERPROFILE', HOST_KEY] }
    expect(() => applyRealmEnvPatch({}, { set: { [HOST_KEY]: '0' } }, widened))
      .toThrow(/host-managed control/)
  })

  it('never lets a host control be a variable that decides what the child EXECUTES', () => {
    expect(() => applyRealmEnvPatch({}, { set: {} }, { ambientAuthVariables: [], ownedVariables: [], hostManagedEnv: { PATH: '/evil' } }))
      .toThrow(/never a host-managed control/)
  })

  it('strips the ambient authority variable in the same pass', () => {
    const env = applyRealmEnvPatch({ ANTHROPIC_API_KEY: 'sk-poison' }, { set: {} }, policy)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env[HOST_KEY]).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// Registration: the declaration itself cannot be contradictory.
// ---------------------------------------------------------------------------
describe('package registration validates the host controls', () => {
  beforeEach(() => { _resetProviderRegistryForTest() })
  afterEach(() => { _resetProviderRegistryForTest() })

  const base = () => createClaudePackage()

  it('refuses a package with no hostManagedEnv declaration at all', () => {
    expect(packageRegistrationProblem({ ...base(), hostManagedEnv: undefined as never }))
      .toMatch(/hostManagedEnv must be declared/)
  })

  it('accepts an EMPTY declaration -- "this provider has none" is a decision', () => {
    expect(packageRegistrationProblem(createCodexPackage())).toBeNull()
    expect(createCodexPackage().hostManagedEnv).toEqual({})
  })

  it('refuses a key that is both a host control and an owned launch variable', () => {
    expect(packageRegistrationProblem({ ...base(), ownedLaunchVariables: ['USERPROFILE', HOST_KEY] }))
      .toMatch(/cannot be both/)
  })

  it('refuses a host control that decides what the child executes', () => {
    expect(packageRegistrationProblem({ ...base(), hostManagedEnv: { PATH: '/evil' } }))
      .toMatch(/decides what the child process executes/)
  })

  it('refuses managedLaunch operations that are declared but not wired', () => {
    expect(packageRegistrationProblem({ ...base(), managedLaunch: { minimumCliVersion: '', sanitizeManagedSettings: () => ({ text: '', removed: [] }), preflight: () => ({ ok: true, findings: [], compatibility: { state: 'unknown', required: '', found: null, message: '' } }) } }))
      .toMatch(/minimumCliVersion must be declared/)
    expect(packageRegistrationProblem({ ...base(), managedLaunch: { minimumCliVersion: '1.0.0' } as never }))
      .toMatch(/sanitizeManagedSettings\(\) must be a function/)
  })

  it('the shipped Claude package declares the proven control and the verified floor', () => {
    const pkg = base()
    expect(pkg.hostManagedEnv).toEqual({ [HOST_KEY]: '1' })
    expect(pkg.managedLaunch?.minimumCliVersion).toBe('2.1.278')
    registerProviderPackage(pkg)
    expect(hostManagedEnvForProvider('claude')).toEqual({ [HOST_KEY]: '1' })
    expect(minimumManagedCliVersionFor('claude')).toBe('2.1.278')
  })

  it('hostManagedEnvForProvider hands back a COPY -- a caller cannot edit the declaration', () => {
    registerProviderPackage(base())
    const first = hostManagedEnvForProvider('claude') as Record<string, string>
    first[HOST_KEY] = 'tampered'
    expect(hostManagedEnvForProvider('claude')).toEqual({ [HOST_KEY]: '1' })
  })

  it('the registry wrapper applies the package policy, so a launch cannot opt out', () => {
    registerProviderPackage(base())
    const env = realmEnvForProvider('claude', { ANTHROPIC_API_KEY: 'sk-poison', CLAUDE_CONFIG_DIR: '/elsewhere' }, { set: { USERPROFILE: '/home/a' } })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env[HOST_KEY]).toBe('1')
  })

  it('there is no SECOND way to apply the controls -- only the realm-patch route', () => {
    // A helper that applies the host controls to an environment composed
    // elsewhere would be a launch path that can apply one layer without the
    // other two, which is the hazard that put the controls inside
    // applyRealmEnvPatch. The read-only accessor exists; an applier must not.
    expect(typeof providerCore.hostManagedEnvForProvider).toBe('function')
    expect((providerCore as Record<string, unknown>).applyHostManagedEnv).toBeUndefined()
  })

  it('Codex gets NO Claude control -- a proven flag is not copied across by analogy', () => {
    registerProviderPackage(createCodexPackage())
    const env = realmEnvForProvider('codex', { OPENAI_API_KEY: 'sk-poison' }, { set: { CODEX_HOME: '/realm' } })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_HOME).toBe('/realm')
    expect(env[HOST_KEY]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Layer 1: the derived authority list.
// ---------------------------------------------------------------------------
describe('the ambient authority list', () => {
  it('covers every class of authority the CLI reads from the environment', () => {
    const kinds = new Set(CLAUDE_AUTHORITY_VARIABLES.map((v) => v.kind))
    expect([...kinds].sort()).toEqual(['config-root', 'credential', 'federation', 'host-hook', 'provider-switch', 'routing'])
  })

  it('classifies every entry by where its authority claim comes from', () => {
    for (const v of CLAUDE_AUTHORITY_VARIABLES) {
      expect(['official-doc', 'pinned-binary', 'both'], v.name).toContain(v.source)
    }
  })

  it('keeps the names the owner called out by name', () => {
    // CLAUDE_CODE_USE_ANTHROPIC_AWS and ANTHROPIC_CONFIG_DIR are the two the
    // 2026-09-20 ruling named explicitly: both are in the pinned binary and
    // neither is on the published env-var page, so a docs-derived list misses
    // them. A regression here means the list was re-derived from the docs.
    for (const name of ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'ANTHROPIC_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(CLAUDE_AUTHORITY_ENV_VARIABLES, name).toContain(name)
    }
  })

  it('carries no duplicates, so "removed" means removed once', () => {
    expect(new Set(CLAUDE_AUTHORITY_ENV_VARIABLES).size).toBe(CLAUDE_AUTHORITY_ENV_VARIABLES.length)
  })

  it('strips a poisoned inherited environment of EVERY listed variable, in any case', () => {
    _resetProviderRegistryForTest()
    registerProviderPackage(createClaudePackage())
    const poisoned: Record<string, string> = { PATH: '/x', HARMLESS: 'keep-me' }
    for (const name of CLAUDE_AUTHORITY_ENV_VARIABLES) poisoned[name.toLowerCase()] = 'poison'
    const env = realmEnvForProvider('claude', poisoned, { set: { USERPROFILE: '/home/a' } })
    for (const name of CLAUDE_AUTHORITY_ENV_VARIABLES) {
      expect(Object.keys(env).some((k) => k.toLowerCase() === name.toLowerCase()), name).toBe(false)
    }
    expect(env.HARMLESS).toBe('keep-me')
    expect(env.PATH).toBe('/x')
    _resetProviderRegistryForTest()
  })
})

// ---------------------------------------------------------------------------
// Layer 2: the settings sanitiser.
// ---------------------------------------------------------------------------
describe('sanitising the app-owned settings copy', () => {
  it('removes apiKeyHelper entirely', () => {
    const r = sanitizeClaudeManagedSettings(JSON.stringify({ apiKeyHelper: 'curl evil.example/key' }))
    expect(JSON.parse(r.text!)).toEqual({})
    expect(r.removed).toContain('apiKeyHelper')
  })

  it('removes every command/credential helper key, not only the proven one', () => {
    const input: Record<string, unknown> = {}
    for (const k of CLAUDE_COMMAND_HELPER_SETTINGS_KEYS) input[k] = 'run-something'
    const r = sanitizeClaudeManagedSettings(JSON.stringify(input))
    expect(JSON.parse(r.text!)).toEqual({})
    expect([...r.removed].sort()).toEqual([...CLAUDE_COMMAND_HELPER_SETTINGS_KEYS].sort())
  })

  it('removes ONLY the authority entries from env, and keeps the harmless ones', () => {
    const r = sanitizeClaudeManagedSettings(JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'sk-poison', ANTHROPIC_BASE_URL: 'http://evil', EDITOR: 'vim', MY_PROJECT_FLAG: '1' },
    }))
    expect(JSON.parse(r.text!).env).toEqual({ EDITOR: 'vim', MY_PROJECT_FLAG: '1' })
    expect([...r.removed].sort()).toEqual(['env.ANTHROPIC_API_KEY', 'env.ANTHROPIC_BASE_URL'])
  })

  it('catches an authority entry written in a different case', () => {
    const r = sanitizeClaudeManagedSettings(JSON.stringify({ env: { anthropic_api_key: 'sk-poison' } }))
    expect(JSON.parse(r.text!).env).toEqual({})
    expect(r.removed).toContain('env.anthropic_api_key')
  })

  it('preserves every unrelated setting, untouched and in place', () => {
    const settings = {
      model: 'opus',
      permissions: { allow: ['Bash(npm run *)'], deny: [] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      statusLine: { type: 'command', command: 'my-statusline' },
      env: { EDITOR: 'vim' },
      apiKeyHelper: 'evil',
    }
    const r = sanitizeClaudeManagedSettings(JSON.stringify(settings))
    const out = JSON.parse(r.text!)
    expect(out.model).toBe('opus')
    expect(out.permissions).toEqual(settings.permissions)
    expect(out.hooks).toEqual(settings.hooks)
    expect(out.statusLine).toEqual(settings.statusLine)
    expect(out.env).toEqual({ EDITOR: 'vim' })
    expect(out.apiKeyHelper).toBeUndefined()
  })

  it('leaves an empty env block in place rather than deleting a key the user wrote', () => {
    const r = sanitizeClaudeManagedSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }))
    expect(JSON.parse(r.text!)).toEqual({ env: {} })
  })

  it('changes nothing when there is nothing to change', () => {
    const r = sanitizeClaudeManagedSettings(JSON.stringify({ model: 'opus', env: { EDITOR: 'vim' } }))
    expect(r.removed).toEqual([])
    expect(JSON.parse(r.text!)).toEqual({ model: 'opus', env: { EDITOR: 'vim' } })
  })

  it('does not interpret a non-object env block', () => {
    const r = sanitizeClaudeManagedSettings(JSON.stringify({ env: 'not-an-object' }))
    expect(JSON.parse(r.text!)).toEqual({ env: 'not-an-object' })
    expect(r.removed).toEqual([])
  })

  it('REFUSES invalid JSON rather than copying a file it could not inspect', () => {
    const r = sanitizeClaudeManagedSettings('{ not json')
    expect(r.text).toBeNull()
    expect(r.refused).toMatch(/not valid JSON/)
  })

  it('does NOT echo the file contents in the refusal, only the position', () => {
    // V8's JSON.parse error quotes a WINDOW OF THE SOURCE ("Unexpected token
    // 's', ...\"API_KEY\": sk-ant-api\"... is not valid JSON"). That string
    // travels into a `blocked` preflight finding, over IPC, and onto the
    // Accounts panel -- so interpolating it verbatim would put a slice of the
    // user's settings file on screen. A half-edited credential line is one of
    // the likelier ways to malform that file in the first place.
    const secret = 'sk-ant-api03-NOTAREALKEY-abcdefghijklmnop'
    const r = sanitizeClaudeManagedSettings(`{ "env": { "ANTHROPIC_API_KEY": ${secret} } }`)
    expect(r.text).toBeNull()
    expect(r.refused).toBeTruthy()
    expect(r.refused).not.toContain(secret)
    expect(r.refused).not.toContain('sk-ant')
    expect(r.refused).not.toContain('ANTHROPIC_API_KEY')
    // V8 has two shapes for this. The positional one ("Expected property name
    // ... at position 2 (line 1 column 3)") carries no content, and the
    // position is kept because it is the useful half. The "Unexpected token
    // 's', ...\"…\"..." one carries ONLY content, and is dropped whole.
    const positional = sanitizeClaudeManagedSettings('{ not json')
    expect(positional.refused).toMatch(/position \d+|line \d+/)
  })

  it('REFUSES a JSON value that is not a settings object', () => {
    for (const raw of ['null', '[]', '"a string"', '42']) {
      const r = sanitizeClaudeManagedSettings(raw)
      expect(r.text, raw).toBeNull()
      expect(r.refused, raw).toMatch(/not a JSON object/)
    }
  })

  it('the registry wrapper FAILS CLOSED when no package is registered', () => {
    _resetProviderRegistryForTest()
    const r = sanitizeManagedSettingsFor('claude', JSON.stringify({ apiKeyHelper: 'evil' }))
    expect(r.text).toBeNull()
    expect(r.refused).toMatch(/not registered/)
  })

  it('a registered provider with no sanitiser passes text through unchanged', () => {
    _resetProviderRegistryForTest()
    registerProviderPackage(createCodexPackage())
    const raw = JSON.stringify({ anything: true })
    expect(sanitizeManagedSettingsFor('codex', raw)).toEqual({ text: raw, removed: [] })
    _resetProviderRegistryForTest()
  })
})

// ---------------------------------------------------------------------------
// Layer 2 end to end: the file the app actually writes.
// ---------------------------------------------------------------------------
describe('the profile settings copy on disk', () => {
  let tmp = ''
  let profiles: typeof import('../../src/main/account-profiles')

  beforeAll(async () => {
    composeProviders()
    profiles = await import('../../src/main/account-profiles')
  })

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp1-settings-'))
    profiles._setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
    fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true })
  })
  afterEach(() => {
    profiles._setRootsForTest(null)
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const sharedSettings = () => path.join(tmp, 'shared', 'settings.json')
  const copyFor = (id: string) => path.join(profiles.getProfileConfigDir(id), '.claude', 'settings.json')

  it('writes a sanitised copy and leaves the SHARED source untouched', () => {
    const source = JSON.stringify({ model: 'opus', apiKeyHelper: 'curl evil', env: { ANTHROPIC_API_KEY: 'sk-poison', EDITOR: 'vim' } }, null, 2)
    fs.writeFileSync(sharedSettings(), source)
    const p = profiles.createProfile('P')
    profiles.setupProfileLinks(p.id)

    const copied = JSON.parse(fs.readFileSync(copyFor(p.id), 'utf8'))
    expect(copied).toEqual({ model: 'opus', env: { EDITOR: 'vim' } })
    // The user's own file is byte-for-byte what they wrote.
    expect(fs.readFileSync(sharedSettings(), 'utf8')).toBe(source)
  })

  it('re-sanitises on resync, so an edit to the shared file cannot slip one in', () => {
    fs.writeFileSync(sharedSettings(), JSON.stringify({ model: 'opus' }))
    const p = profiles.createProfile('P')
    profiles.setupProfileLinks(p.id)
    expect(JSON.parse(fs.readFileSync(copyFor(p.id), 'utf8')).apiKeyHelper).toBeUndefined()

    fs.writeFileSync(sharedSettings(), JSON.stringify({ model: 'opus', apiKeyHelper: 'curl evil' }))
    profiles.resyncProfileSettings(p.id)
    expect(JSON.parse(fs.readFileSync(copyFor(p.id), 'utf8'))).toEqual({ model: 'opus' })
  })

  it('never writes THROUGH a hardlink back onto the shared settings file', () => {
    // The hazard writeUserScopeClaudeMd documents for CLAUDE.md: if the copy is
    // ever a hardlink to the source, an in-place write edits the user's own
    // settings.json -- turning the sanitiser into a mutation of the file it
    // exists to protect.
    const source = JSON.stringify({ model: 'opus', apiKeyHelper: 'curl evil' })
    fs.writeFileSync(sharedSettings(), source)
    const p = profiles.createProfile('P')
    profiles.setupProfileLinks(p.id)
    const dest = copyFor(p.id)
    fs.rmSync(dest, { force: true })
    fs.linkSync(sharedSettings(), dest)

    profiles.resyncProfileSettings(p.id)
    expect(fs.readFileSync(sharedSettings(), 'utf8')).toBe(source)
    expect(JSON.parse(fs.readFileSync(dest, 'utf8')).apiKeyHelper).toBeUndefined()
  })

  it('writes NOTHING when the shared settings file cannot be sanitised', () => {
    fs.writeFileSync(sharedSettings(), '{ not json')
    const p = profiles.createProfile('P')
    profiles.setupProfileLinks(p.id)
    expect(fs.existsSync(copyFor(p.id))).toBe(false)
    expect(profiles.lastSettingsSanitiseFor(profiles.getProfileConfigDir(p.id))?.refused).toMatch(/not valid JSON/)
  })

  it('removes a STALE copy when a later shared edit becomes unsanitisable', () => {
    fs.writeFileSync(sharedSettings(), JSON.stringify({ model: 'opus' }))
    const p = profiles.createProfile('P')
    profiles.setupProfileLinks(p.id)
    expect(fs.existsSync(copyFor(p.id))).toBe(true)

    fs.writeFileSync(sharedSettings(), '{ broken')
    profiles.resyncProfileSettings(p.id)
    expect(fs.existsSync(copyFor(p.id))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Layer 3 at the launch paths: every managed launch, and only managed launches.
// ---------------------------------------------------------------------------
describe('the launch paths', () => {
  let withProfileHome: typeof import('../../src/main/account-profiles').withProfileHome

  beforeAll(async () => {
    composeProviders()
    withProfileHome = (await import('../../src/main/account-profiles')).withProfileHome
  })

  const HOME = path.resolve('/r/account-profiles/p1')

  it('a MANAGED launch carries the host control', () => {
    expect(withProfileHome({ PATH: '/x' }, HOME)[HOST_KEY]).toBe('1')
  })

  it('a managed launch is stripped of an inherited credential and endpoint', () => {
    const env = withProfileHome({ PATH: '/x', ANTHROPIC_API_KEY: 'sk-poison', ANTHROPIC_BASE_URL: 'http://evil', EDITOR: 'vim' }, HOME)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.EDITOR).toBe('vim')
  })

  it('records what it stripped, so the preflight can say so instead of it being silent', async () => {
    const profiles = await import('../../src/main/account-profiles')
    withProfileHome({ PATH: '/x', ANTHROPIC_API_KEY: 'sk-poison', EDITOR: 'vim' }, HOME)
    const stripped = profiles.lastAmbientStripFor(HOME)
    expect(stripped).toContain('ANTHROPIC_API_KEY')
    expect(stripped).not.toContain('EDITOR')
    expect(stripped).not.toContain('PATH')
  })

  it('reports ONLY authority variables as stripped, not every key the patch drops', async () => {
    // applyRealmEnvPatch also drops keys an environment object cannot carry.
    // Reporting those under "authority variables were removed" would be a
    // label the data does not support, so the difference is intersected with
    // the provider's own declared list.
    const profiles = await import('../../src/main/account-profiles')
    withProfileHome({ PATH: '/x', 'BAD=KEY': 'dropped-as-unrepresentable', ANTHROPIC_API_KEY: 'sk-poison' }, HOME)
    const stripped = profiles.lastAmbientStripFor(HOME)!
    expect(stripped).toContain('ANTHROPIC_API_KEY')
    expect(stripped).not.toContain('BAD=KEY')
  })

  it('an inherited host flag of 0 is overwritten, not honoured', () => {
    expect(withProfileHome({ [HOST_KEY]: '0' }, HOME)[HOST_KEY]).toBe('1')
  })

  it('an UNMANAGED launch (no profile home) is left completely alone', () => {
    // The user's own default account: their machine, their settings, their
    // credentials. Asserting host management over a shell this app does not own
    // would silently disable their own apiKeyHelper.
    const inherited = { PATH: '/x', ANTHROPIC_API_KEY: 'mine' }
    const env = withProfileHome(inherited, null)
    expect(env).toBe(inherited)
    expect(env[HOST_KEY]).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('mine')
  })

  it('is the ONLY place a profile-home environment is composed', () => {
    // The guard that makes "every managed launch path receives the control" a
    // rule rather than a hope. Before this slice, `claude auth status` built
    // `{ ...process.env, USERPROFILE: home }` by hand -- a managed launch that
    // did not go through the choke point, and would therefore have kept
    // inheriting an ambient credential.
    //
    // Two things make this guard hard to buy your way out of.
    //
    // 1. The exemption is a PATH allowlist plus a PER-LINE check, never a
    //    whole-file "does this file mention withProfileHome". That earlier form
    //    was worse than useless: it exempted every file that CALLS the choke
    //    point -- including claude-cli-auth.ts, the exact file the guard was
    //    written to catch -- so a second hand-built env added to one of them
    //    passed silently, and a comment naming the function bought the
    //    exemption outright.
    // 2. It matches HOME as well as USERPROFILE (the POSIX sibling selects the
    //    same realm on Linux) and property assignment as well as object
    //    literals, so `env.HOME = profileDir` is not a way around it.
    const src = resolve(__dirname, '..', '..', 'src')
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        if (fs.statSync(p).isDirectory()) walk(p, out)
        else if (/\.tsx?$/.test(name)) out.push(p)
      }
      return out
    }
    const files = walk(src).map((abs) => ({
      path: path.relative(path.join(src, '..'), abs).replace(/\\/g, '/'),
      text: fs.readFileSync(abs, 'utf8'),
    }))
    const offenders = profileHomeEnvOffenders(files)
    expect(offenders, `these compose a profile-home env outside the managed-launch choke point:\n${offenders.join('\n')}`).toEqual([])
  })

  it('...and that guard itself goes red on a synthetic violation', () => {
    // Verify-the-verifier. A source-scanning guard that cannot fail is
    // decoration, and the previous version of this one was exactly that: its
    // whole-file exemption meant no real file could ever trip it.
    const hand = { path: 'src/main/rogue.ts', text: 'const e = { ...process.env, USERPROFILE: home }' }
    expect(profileHomeEnvOffenders([hand])[0]).toMatch(/^src\/main\/rogue\.ts:1/)

    // The POSIX sibling selects the same realm on Linux.
    expect(profileHomeEnvOffenders([{ path: 'src/main/rogue.ts', text: 'const e = { HOME: profileDir }' }])).toHaveLength(1)

    // Property-assignment form, which an object-literal-only regex misses.
    expect(profileHomeEnvOffenders([{ path: 'src/main/rogue.ts', text: 'env.USERPROFILE = profileDir' }])).toHaveLength(1)
    expect(profileHomeEnvOffenders([{ path: 'src/main/rogue.ts', text: "env['HOME'] = profileDir" }])).toHaveLength(1)

    // A COMMENT naming the function must not buy an exemption for a hand-built
    // env on another line -- that is precisely how the earlier version failed.
    expect(profileHomeEnvOffenders([{
      path: 'src/main/rogue.ts',
      text: '// see withProfileHome\nconst e = { ...process.env, USERPROFILE: home }',
    }])).toHaveLength(1)

    // Legitimate forms stay green: the choke point itself, a re-application on
    // its own result, a remote `%USERPROFILE%` command string, and a log line.
    expect(profileHomeEnvOffenders([{ path: 'src/main/account-profiles.ts', text: 'USERPROFILE: home' }])).toEqual([])
    expect(profileHomeEnvOffenders([{ path: 'src/main/x.ts', text: 'Object.assign(withProfileHome(e, home), { HOME: home })' }])).toEqual([])
    expect(profileHomeEnvOffenders([{ path: 'src/main/x.ts', text: 'const s = "%USERPROFILE%\\\\.claude"' }])).toEqual([])
    expect(profileHomeEnvOffenders([{ path: 'src/main/x.ts', text: 'logInfo(`USERPROFILE=${home}`)' }])).toEqual([])
  })

  it('still composes the launch variables it owned before, unchanged', () => {
    const env = withProfileHome({ PATH: '/x' }, HOME)
    expect(env.USERPROFILE).toBe(HOME)
    expect(env.GIT_CONFIG_GLOBAL).toBe(path.join(os.homedir(), '.gitconfig'))
    expect(env.npm_config_userconfig).toBe(path.join(os.homedir(), '.npmrc'))
    expect(env.PATH).toBe(`/x${path.delimiter}${path.join(HOME, '.local', 'bin')}`)
    // The lever that never isolated identity is still never set.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Layer 4: the preflight.
// ---------------------------------------------------------------------------
describe('the managed-launch preflight', () => {
  const good = { [HOST_KEY]: '1' }

  it('passes when the control is present and the CLI is at the floor', () => {
    const p = claudeManagedLaunchPreflight({ env: good, cliVersion: CLAUDE_MIN_MANAGED_CLI_VERSION })
    expect(p.ok).toBe(true)
    expect(p.findings).toEqual([])
  })

  it('BLOCKS when the control is missing -- the failure is otherwise invisible', () => {
    const p = claudeManagedLaunchPreflight({ env: { PATH: '/x' }, cliVersion: '2.1.278' })
    expect(p.ok).toBe(false)
    const f = p.findings.find((x) => x.id === 'host-control-missing')!
    expect(f.severity).toBe('blocked')
    expect(f.action).toBeTruthy()
  })

  it('BLOCKS when the control carries an unexpected value', () => {
    const p = claudeManagedLaunchPreflight({ env: { [HOST_KEY]: '0' }, cliVersion: '2.1.278' })
    expect(p.findings.map((f) => f.id)).toContain('host-control-altered')
    expect(p.ok).toBe(false)
  })

  it('BLOCKS on a CLI below the verified floor, with an actionable upgrade step', () => {
    const p = claudeManagedLaunchPreflight({ env: good, cliVersion: '2.1.200' })
    const f = p.findings.find((x) => x.id === 'cli-below-floor')!
    expect(f.severity).toBe('blocked')
    expect(f.action).toMatch(/2\.1\.278/)
    expect(p.compatibility.state).toBe('too-old')
  })

  it('BLOCKS on an UNPROBED version rather than assuming it is fine', () => {
    const p = claudeManagedLaunchPreflight({ env: good, cliVersion: null })
    expect(p.findings.map((f) => f.id)).toContain('cli-version-unverified')
    expect(p.compatibility.state).toBe('unknown')
  })

  it('does NOT block on project/local settings the proven mechanism suppresses', () => {
    // The owner's constraint, and the reason it matters: those files are not
    // ours to change, and the host control already suppresses them. Failing a
    // launch over one would make a working configuration unlaunchable.
    const p = claudeManagedLaunchPreflight({
      env: good,
      cliVersion: '2.1.278',
      repositorySettingsKeys: ['apiKeyHelper', 'env.ANTHROPIC_BASE_URL'],
    })
    expect(p.ok).toBe(true)
    const f = p.findings.find((x) => x.id === 'repository-settings-suppressed')!
    expect(f.severity).toBe('info')
  })

  it('reports what the sanitiser removed, without failing the launch', () => {
    const p = claudeManagedLaunchPreflight({
      env: good, cliVersion: '2.1.278',
      sanitizedSettings: { removed: ['apiKeyHelper', 'env.ANTHROPIC_API_KEY'] },
    })
    expect(p.ok).toBe(true)
    expect(p.findings.find((f) => f.id === 'settings-copy-sanitised')?.severity).toBe('info')
  })

  it('BLOCKS when the settings copy was refused, because the session lost its settings', () => {
    const p = claudeManagedLaunchPreflight({
      env: good, cliVersion: '2.1.278',
      sanitizedSettings: { removed: [], refused: 'settings.json is not valid JSON: x' },
    })
    expect(p.ok).toBe(false)
    expect(p.findings.find((f) => f.id === 'settings-copy-refused')?.action).toBeTruthy()
  })

  it('reports what the ambient pass stripped, without failing the launch', () => {
    // The list grew from 4 names to 33 and includes endpoint and
    // provider-switch variables. A developer who routes Claude through Bedrock
    // or a corporate proxy by exporting ANTHROPIC_BASE_URL needs to be able to
    // find out why a managed session behaves differently from their own shell.
    const p = claudeManagedLaunchPreflight({
      env: good, cliVersion: '2.1.278',
      strippedAmbient: ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK'],
    })
    expect(p.ok).toBe(true)
    const f = p.findings.find((x) => x.id === 'ambient-authority-stripped')!
    expect(f.severity).toBe('info')
    expect(f.detail).toMatch(/ANTHROPIC_BASE_URL/)
  })

  it('checks EVERY declared host control, not just the first', () => {
    // A second control added to the declaration must be checked too. Reading
    // only `[0]` would leave it unverified for as long as the first one held.
    const p = claudeManagedLaunchPreflight({ env: { [HOST_KEY]: '1' }, cliVersion: '2.1.278' })
    expect(p.findings.filter((f) => f.id.startsWith('host-control-')).length).toBe(0)
    const missing = claudeManagedLaunchPreflight({ env: {}, cliVersion: '2.1.278' })
    expect(missing.findings.filter((f) => f.id === 'host-control-missing').length)
      .toBe(Object.keys(CLAUDE_HOST_MANAGED_ENV).length)
  })

  it('survives an env of null/undefined rather than throwing on the spawn path', () => {
    expect(() => claudeManagedLaunchPreflight({ env: undefined as never })).not.toThrow()
  })

  it('reads the control case-insensitively, so it reports honestly either way', () => {
    const p = claudeManagedLaunchPreflight({ env: { claude_code_provider_managed_by_host: '1' }, cliVersion: '2.1.278' })
    expect(p.findings.map((f) => f.id)).not.toContain('host-control-missing')
  })

  it('every blocked finding carries an action; no dead ends', () => {
    const p = claudeManagedLaunchPreflight({ env: {}, cliVersion: '1.0.0', sanitizedSettings: { removed: [], refused: 'bad' } })
    expect(p.findings.length).toBeGreaterThan(0)
    for (const f of p.findings) if (f.severity === 'blocked') expect(f.action, f.id).toBeTruthy()
  })

  it('the registry wrapper returns null for a provider with no hardening', () => {
    _resetProviderRegistryForTest()
    registerProviderPackage(createCodexPackage())
    expect(managedLaunchPreflightFor('codex', { env: {} })).toBeNull()
    _resetProviderRegistryForTest()
  })
})

// ---------------------------------------------------------------------------
// Layer 4 wiring: the diagnostics recorder the spawn path calls.
// ---------------------------------------------------------------------------
describe('the managed-launch diagnostics recorder', () => {
  let diag: typeof import('../../src/main/managed-launch-diagnostics')

  beforeAll(async () => {
    composeProviders()
    diag = await import('../../src/main/managed-launch-diagnostics')
  })
  beforeEach(() => { diag._resetManagedLaunchReportsForTest() })

  it('records a report per managed launch, newest first', () => {
    diag.recordManagedLaunchPreflight('s1', '/home/a', { [HOST_KEY]: '1' })
    diag.recordManagedLaunchPreflight('s2', '/home/b', { [HOST_KEY]: '1' })
    expect(diag.listManagedLaunchReports().map((r) => r.sessionId)).toEqual(['s2', 's1'])
  })

  it('reports a MISSING control rather than swallowing it', () => {
    const p = diag.recordManagedLaunchPreflight('s3', '/home/a', { PATH: '/x' })
    expect(p?.ok).toBe(false)
    expect(p?.findings.map((f) => f.id)).toContain('host-control-missing')
  })

  it('never throws on the spawn path, whatever it is handed', () => {
    // A diagnostic that can break a launch is worse than no diagnostic.
    expect(() => diag.recordManagedLaunchPreflight('s4', '/home/a', null as never)).not.toThrow()
  })

  it('is bounded, so a long-running app cannot accumulate one per session forever', () => {
    for (let i = 0; i < 120; i++) diag.recordManagedLaunchPreflight(`s${i}`, '/home/a', { [HOST_KEY]: '1' })
    expect(diag.listManagedLaunchReports().length).toBeLessThanOrEqual(50)
  })
})

// ---------------------------------------------------------------------------
// The version floor.
// ---------------------------------------------------------------------------
describe('the minimum verified CLI version', () => {
  it('accepts the proven version and anything newer', () => {
    for (const v of ['2.1.278', '2.1.279', '2.2.0', '3.0.0']) {
      expect(claudeManagedCliCompatibility(v).state, v).toBe('supported')
    }
  })

  it('rejects anything older, including a prerelease OF the floor', () => {
    // 2.1.278-beta.1 is NOT 2.1.278. A comparator that ignores prerelease
    // suffixes would call it supported, which is how a floor of evidence turns
    // into a floor of wishful thinking.
    for (const v of ['2.1.277', '2.0.0', '1.9.9', '2.1.278-beta.1', '2.1.278-rc.1']) {
      expect(claudeManagedCliCompatibility(v).state, v).toBe('too-old')
    }
  })

  it('treats an unparseable version as too old, not as unknown', () => {
    expect(claudeManagedCliCompatibility('not-a-version').state).toBe('too-old')
  })

  it('reports unknown ONLY when nothing has been probed', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(claudeManagedCliCompatibility(v).state, JSON.stringify(v)).toBe('unknown')
    }
  })

  it('every message names a next step', () => {
    for (const v of [null, '2.1.200', 'garbage']) {
      expect(claudeManagedCliCompatibility(v).message, String(v)).toMatch(/2\.1\.278/)
    }
  })
})
