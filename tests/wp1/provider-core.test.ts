// WP1.41 (capability registry semantics), WP1.28 / WP1.42 (opaque ids and the
// binding shape check) and WP1.38 (realm environment patch, poisoned-
// environment negatives at the contract level; the launch handoff slice
// exercises the real spawn). Provider core only: no concrete provider is
// imported here, the packages under test are synthetic.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CAPABILITY_KEYS, WP1_REQUIRED_CAPABILITIES, resolveCapability, missingCapabilityKeys, isCapabilityPlatform,
  isOpaqueId, makeOpaqueId, isProviderId, PROVIDER_IDS, applyRealmEnvPatch, validateSessionBindingShape,
} from '../../src/shared/providers'
import type { ProviderCapabilities, CapabilityKey, CapabilityPlatform } from '../../src/shared/providers'
import {
  registerProviderPackage, packageRegistrationProblem, getProviderPackage, tryGetProviderPackage, listProviderPackages, providerCapability,
  registerProvider, getProvider, tryGetProvider, realmEnvForProvider, _resetProviderRegistryForTest,
} from '../../src/main/providers/core'
import type { ProviderPackage } from '../../src/main/providers/core'
import {
  registerRendererProvider, getRendererProvider, tryGetRendererProvider, listRendererProviders, defaultProviderActions,
  _resetRendererProviderRegistryForTest,
} from '../../src/renderer/providers/core'
import type { RendererProviderDescriptor } from '../../src/renderer/providers/core'

const fullCaps = (state: 'supported' | 'unsupported' | 'unknown' = 'unknown'): ProviderCapabilities =>
  Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, { state }])) as ProviderCapabilities
const fakeSession = (id: 'claude' | 'codex') => ({
  id, displayName: id, resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {},
}) as never
const ops = {
  setup: { discover: async () => ({ state: 'found', compatibility: 'supported', checkedAt: 0 }), installRecipes: () => [] },
  auth: { status: async () => ({ ok: true, state: 'signed-in' }), logout: async () => ({ ok: true }), login: async () => ({ ok: true }) },
  realms: { realmEnvPatch: () => ({ set: {} }) },
} as unknown as Pick<ProviderPackage, 'setup' | 'auth' | 'realms'>
const pkg = (id: 'claude' | 'codex', caps = fullCaps(), extra: Partial<ProviderPackage> = {}): ProviderPackage =>
  ({ id, displayName: `Fake ${id}`, session: fakeSession(id), capabilities: caps, ambientAuthVariables: ['X_TOKEN'], ownedLaunchVariables: ['X_HOME'], hostManagedEnv: {}, ...extra })

describe('provider registry (main core)', () => {
  beforeEach(() => _resetProviderRegistryForTest())

  it('registers a package and its session provider together, in PROVIDER_IDS order', () => {
    registerProviderPackage(pkg('codex'))
    registerProviderPackage(pkg('claude'))
    expect(listProviderPackages().map((p) => p.id)).toEqual([...PROVIDER_IDS])
    expect(getProvider('claude')).toBe(getProviderPackage('claude').session)
    expect(tryGetProvider('codex')).toBe(getProviderPackage('codex').session)
  })

  it('fails closed on an unknown id, a mismatched session id, an incomplete or invalid declaration, a missing variable list and a duplicate', () => {
    expect(() => registerProviderPackage(pkg('gemini' as never))).toThrow(/unknown provider id/)
    expect(() => registerProviderPackage({ ...pkg('claude'), session: fakeSession('codex') })).toThrow(/does not match/)
    const partial = { ...fullCaps() } as Record<string, unknown>
    delete partial['session.ssh']
    expect(() => registerProviderPackage(pkg('claude', partial as ProviderCapabilities))).toThrow(/incomplete or invalid: session\.ssh/)
    expect(() => registerProviderPackage(pkg('claude', { ...fullCaps(), 'auth.device': { state: 'maybe' as never } }))).toThrow(/auth\.device/)
    expect(() => registerProviderPackage(pkg('claude', { ...fullCaps(), 'realm.isolated': { state: 'unknown', platformOverrides: { darwin: 'suported' as never } } }))).toThrow(/realm\.isolated/)
    expect(() => registerProviderPackage(pkg('claude', { ...fullCaps(), 'realm.isolated': { state: 'unknown', platformOverrides: { macos: 'unsupported' } as never } }))).toThrow(/realm\.isolated/)
    expect(() => registerProviderPackage({ ...pkg('claude'), ambientAuthVariables: undefined as never })).toThrow(/ambientAuthVariables/)
    expect(() => registerProviderPackage({ ...pkg('claude'), ownedLaunchVariables: [''] })).toThrow(/ownedLaunchVariables/)
    // A package may not own a variable that decides what the child EXECUTES:
    // owning PATH would make the realm patch a loader hijack. Case-insensitive,
    // because Windows resolves Path and PATH to the same variable.
    for (const bad of ['PATH', 'path', 'Path', 'PATHEXT', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'COMSPEC'])
      expect(() => registerProviderPackage({ ...pkg('claude'), ownedLaunchVariables: ['HOME', bad] }), bad).toThrow(/decides what the child process executes/)
    expect(() => registerProviderPackage({ ...pkg('claude'), ambientAuthVariables: ['PATH'] })).toThrow(/decides what the child process executes/)
    // The shape check is the shape check: a malformed package comes back as a
    // message, never as a TypeError thrown by the check itself.
    expect(packageRegistrationProblem(null as never)).toMatch(/package must be an object/)
    expect(packageRegistrationProblem(undefined as never)).toMatch(/package must be an object/)
    registerProviderPackage(pkg('claude'))
    expect(() => registerProviderPackage(pkg('claude'))).toThrow(/already registered/)
    expect(tryGetProviderPackage('codex')).toBeNull()
    expect(() => getProviderPackage('codex')).toThrow(/not registered/)
  })

  it('a capability may be supported or experimental only when the backing operation object exists', () => {
    const supportedAuth = { ...fullCaps(), 'auth.status': { state: 'supported' as const } }
    expect(packageRegistrationProblem(pkg('codex', supportedAuth))).toMatch(/auth\.status is supported but the package exposes no auth operations/)
    expect(packageRegistrationProblem(pkg('codex', supportedAuth, { auth: ops.auth }))).toBeNull()
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'auth.device': { state: 'experimental', note: 'beta' } }))).toMatch(/auth\.device is experimental/)
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'cli.discovery': { state: 'supported' } }))).toMatch(/no setup operations/)
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'realm.isolated': { state: 'supported' } }))).toMatch(/no realms operations/)
    // Each session.* key names its OWN backing method, so the rule is not
    // vacuous across the block: launch is backed by every session provider,
    // ssh only by one that implements configureRemoteSettings.
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'session.launch': { state: 'supported' } }))).toBeNull()
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'session.history': { state: 'supported' } }))).toBeNull()
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'session.ssh': { state: 'supported' } }))).toMatch(/session\.ssh is supported but the session provider has no configureRemoteSettings/)
    // A key nothing on the package can back may not be declared supported at
    // all -- it is not "declaration only", it is a claim with nothing to call.
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'account.usage': { state: 'supported' } }))).toMatch(/account\.usage is supported but nothing on the package backs it/)
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'session.cloud': { state: 'experimental', note: 'x' } }))).toMatch(/session\.cloud is experimental but nothing on the package backs it/)
    // A PLATFORM OVERRIDE is a declaration too: unknown everywhere but
    // supported on win32 resolves ENABLED on win32, so it needs the backing.
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'auth.status': { state: 'unknown', platformOverrides: { win32: 'supported' } } }))).toMatch(/auth\.status is supported but the package exposes no auth operations/)
    expect(packageRegistrationProblem(pkg('codex', { ...fullCaps(), 'auth.status': { state: 'unknown', platformOverrides: { win32: 'supported' } } }, { auth: ops.auth }))).toBeNull()
    expect(() => registerProviderPackage(pkg('codex', supportedAuth))).toThrow(/declare it unknown until wired/)
  })

  it('the legacy session registration is refused once a package owns the id (no split brain)', () => {
    registerProviderPackage(pkg('claude'))
    expect(() => registerProvider(fakeSession('claude'))).toThrow(/a provider package owns this id/)
    expect(getProvider('claude')).toBe(getProviderPackage('claude').session)
    registerProvider(fakeSession('codex')) // no package yet: still allowed for fakes
    expect(tryGetProvider('codex')).not.toBeNull()
    expect(() => registerProvider({ ...fakeSession('codex'), id: 'other' } as never)).toThrow(/unknown provider id/)
  })

  it('resolves capabilities: supported on, unsupported/unknown off, experimental only when owner-enabled for THIS provider, platform overrides first, unknown platform closed', () => {
    registerProviderPackage(pkg('codex', {
      ...fullCaps('unsupported'),
      'cli.discovery': { state: 'supported' },
      'auth.device': { state: 'experimental', note: 'beta at the provider' },
      'account.usage': { state: 'unknown' },
      'realm.isolated': { state: 'supported', platformOverrides: { darwin: 'unsupported' } },
    }, { ...ops }))
    const on = (key: CapabilityKey, opts: Parameters<typeof providerCapability>[2] = {}) => providerCapability('codex', key, { platform: 'linux', ...opts })
    expect(on('cli.discovery')).toMatchObject({ enabled: true, state: 'supported', labelExperimental: false })
    expect(on('auth.logout')).toMatchObject({ enabled: false, reason: 'unsupported' })
    expect(on('account.usage')).toMatchObject({ enabled: false, reason: 'unknown' })
    expect(on('auth.device')).toMatchObject({ enabled: false, reason: 'experimental-not-enabled', labelExperimental: true, note: 'beta at the provider' })
    expect(on('auth.device', { experimentalEnabled: ['codex:auth.device'] })).toMatchObject({ enabled: true, labelExperimental: true })
    expect(on('auth.device', { experimentalEnabled: ['claude:auth.device'] })).toMatchObject({ enabled: false })
    expect(on('realm.isolated', { platform: 'darwin' })).toMatchObject({ enabled: false, state: 'unsupported' })
    expect(on('realm.isolated', { platform: 'win32' })).toMatchObject({ enabled: true })
    for (const bad of ['Darwin', 'macos', 'freebsd', '', '__proto__', 'toString']) {
      expect(on('realm.isolated', { platform: bad as CapabilityPlatform }), String(bad)).toMatchObject({ enabled: false, reason: 'unknown-platform' })
    }
    expect(on('realm.isolated', { platform: 'toString' as never }).state).toBe('unknown')
    expect(providerCapability('claude', 'cli.discovery', { platform: 'linux' })).toMatchObject({ enabled: false, reason: 'not-declared' })
  })

  it('the pure resolver keeps the note on every disabled path, and the declaration checker agrees with the registry', () => {
    expect(resolveCapability(undefined, 'auth.status', { providerId: 'claude', platform: 'linux' })).toMatchObject({ enabled: false, reason: 'not-declared' })
    expect(resolveCapability({ 'auth.status': { state: 'unsupported', note: 'why' } }, 'auth.status', { providerId: 'claude', platform: 'linux' })).toMatchObject({ enabled: false, note: 'why' })
    expect(resolveCapability({ 'auth.status': { state: 'unknown', note: 'soon' } }, 'auth.status', { providerId: 'claude', platform: 'linux' })).toMatchObject({ enabled: false, note: 'soon' })
    expect(resolveCapability({ 'auth.status': { state: 'supported' } }, 'auth.status', { providerId: 'claude', platform: 'darwin' }).enabled).toBe(true)
    expect(missingCapabilityKeys(undefined)).toEqual([...CAPABILITY_KEYS])
    expect(missingCapabilityKeys(fullCaps())).toEqual([])
    expect(missingCapabilityKeys({ ...fullCaps(), 'auth.status': { state: 'supported', note: 42 as never } })).toEqual(['auth.status'])
    for (const k of WP1_REQUIRED_CAPABILITIES) expect(CAPABILITY_KEYS).toContain(k)
    expect(['win32', 'darwin', 'linux'].every(isCapabilityPlatform) && !isCapabilityPlatform('Darwin')).toBe(true)
  })
})

describe('opaque ids, provider ids and the binding shape (WP1.28, WP1.42)', () => {
  const hex = 'a'.repeat(32)
  it('accept only the application-generated shape and reject user-controlled strings', () => {
    expect(isProviderId('claude') && isProviderId('codex')).toBe(true)
    expect(isProviderId('Claude') || isProviderId('') || isProviderId(undefined)).toBe(false)
    expect(isOpaqueId(makeOpaqueId('account', hex), 'account')).toBe(true)
    expect(isOpaqueId(makeOpaqueId('account', hex), 'realm')).toBe(false)
    for (const bad of ['acct-', 'acct-ABCDEF0123456789', 'acct-../x', 'user@example.com', 'acct-' + 'a'.repeat(65), 'acct-' + 'a'.repeat(15), '', 42])
      expect(isOpaqueId(bad), String(bad)).toBe(false)
    expect(() => makeOpaqueId('realm', 'not-hex')).toThrow(/lowercase hex/)
  })
  it('a binding is rejected by shape when any field is the wrong kind, missing, or extra', () => {
    const good = { providerId: 'codex', providerAccountId: makeOpaqueId('account', hex), authRealmId: makeOpaqueId('realm', hex), identityId: makeOpaqueId('identity', hex) }
    expect(validateSessionBindingShape(good)).toEqual({ ok: true, problems: [] })
    expect(validateSessionBindingShape({ ...good, providerAccountId: makeOpaqueId('identity', hex) }).problems).toEqual(['providerAccountId is not an account id'])
    expect(validateSessionBindingShape({ ...good, authRealmId: '../etc' }).problems).toEqual(['authRealmId is not a realm id'])
    expect(validateSessionBindingShape({ ...good, providerId: 'gemini' }).problems).toEqual(['providerId is not a known provider'])
    expect(validateSessionBindingShape({ ...good, extra: 1 }).problems).toEqual(['unexpected field extra'])
    expect(validateSessionBindingShape(null).ok).toBe(false)
    expect(validateSessionBindingShape({}).problems).toHaveLength(4)
  })
})

describe('realm environment patch (D1/D3, WP1.38 contract level)', () => {
  const policy = { ambientAuthVariables: ['CODEX_HOME', 'OPENAI_API_KEY'], ownedVariables: ['CODEX_HOME'] }

  it('removes every ambient authentication variable in any spelling, then applies the realm last; unrelated variables survive', () => {
    const poisoned = { PATH: '/usr/bin', CODEX_HOME: '/attacker/home', codex_home: '/attacker/home2', Openai_Api_Key: 'sk-poison', OPENAI_API_KEY: 'sk-poison2', TERM: 'xterm', UNDEF: undefined }
    const out = applyRealmEnvPatch(poisoned, { set: { CODEX_HOME: '/app/realms/realm-abc' } }, policy)
    expect(out).toEqual({ PATH: '/usr/bin', TERM: 'xterm', CODEX_HOME: '/app/realms/realm-abc' })
    expect(Object.keys(out).filter((k) => /openai_api_key/i.test(k))).toEqual([])
    expect(poisoned.CODEX_HOME).toBe('/attacker/home') // the base is not mutated
    // Null prototype, deliberately: Node enumerates a spawn env with for...in
    // and includes prototype properties, so Object.prototype pollution in the
    // main process would otherwise reach the child.
    expect(Object.getPrototypeOf(out)).toBe(null)
  })

  it('a patch variable must be spelled exactly as the provider declares it, and overrides any case-variant in the base', () => {
    const q = { ambientAuthVariables: [], ownedVariables: ['USERPROFILE', 'DROP'] }
    const out = applyRealmEnvPatch({ UserProfile: '/users/real', USERPROFILE: '/users/real2', KEEP: '1', DROP: '2' }, { set: { USERPROFILE: '/app/profiles/p1' }, unset: ['DROP'] }, q)
    expect(out).toEqual({ KEEP: '1', USERPROFILE: '/app/profiles/p1' })
    // A case-variant spelling is REFUSED, not silently accepted. Accepting it
    // would write `userprofile` while the case-insensitive removal pass
    // deleted `USERPROFILE`: on Linux and macOS the CLI would then see no
    // realm at all and fall back to the shared default home -- another
    // account's credentials. Windows would not show it.
    for (const bad of [{ set: { userprofile: '/app/p1' } }, { set: { UserProfile: '/app/p1' } }, { set: {}, unset: ['drop'] }])
      expect(() => applyRealmEnvPatch({}, bad, q), JSON.stringify(bad)).toThrow(/not a variable this provider owns/)
  })

  it('a patch may only SET what the provider declares: no loader variable, no other realm, and no re-adding an ambient credential', () => {
    // The ambient list is removed, never re-settable. The first shape of this
    // contract made it implicitly owned, so a Claude patch could set
    // CLAUDE_CONFIG_DIR (the mechanism D1 forbids) or re-add ANTHROPIC_API_KEY
    // one line after the removal pass deleted it.
    for (const set of [{ CLAUDE_CONFIG_DIR: '/hijack' }, { OPENAI_API_KEY: 'sk-injected' }, { USERPROFILE: '/other/realm' }])
      expect(() => applyRealmEnvPatch({}, { set }, policy), JSON.stringify(set)).toThrow(/not a variable this provider owns/)
    // Loader and search variables are refused whatever a package declares --
    // by name AND by family, so a sibling nobody enumerated (NODE_PATH beside
    // NODE_OPTIONS, DYLD_FRAMEWORK_PATH beside DYLD_LIBRARY_PATH) is refused
    // too. A git config file and an .npmrc execute commands (core.pager,
    // core.sshCommand, script-shell), so the config-file pointers are here as
    // well: withProfileHome deliberately aims them at the REAL home, which
    // makes them launch-path composition, never a realm selector.
    for (const set of [
      { PATH: '/evil' }, { Path: '/evil' }, { PATHEXT: '.evil' }, { LD_PRELOAD: '/evil.so' },
      { NODE_OPTIONS: '--require x' }, { NODE_PATH: '/evil' }, { DYLD_INSERT_LIBRARIES: '/e.dylib' },
      { DYLD_FRAMEWORK_PATH: '/evil' }, { PYTHONPATH: '/evil' }, { PERL5LIB: '/evil' },
      { GIT_CONFIG_GLOBAL: '/evil.gitconfig' }, { GIT_SSH_COMMAND: 'sh -c evil' }, { GIT_EXEC_PATH: '/evil' },
      { npm_config_userconfig: '/evil/.npmrc' }, { BASH_ENV: '/evil.sh' }, { SHELL: '/evil' },
    ])
      expect(() => applyRealmEnvPatch({}, { set }, { ambientAuthVariables: [], ownedVariables: Object.keys(set) }), JSON.stringify(set)).toThrow(/decides what the child process executes/)
    expect(() => applyRealmEnvPatch({ PATH: '/usr/bin' }, { set: {}, unset: ['PATH'] }, policy)).toThrow(/decides what the child process executes/)
    // An ambient variable may still be UNSET by the patch (removal is the
    // point), and the realm selector is declared in BOTH lists on purpose.
    expect(applyRealmEnvPatch({}, { set: {}, unset: ['OPENAI_API_KEY'] }, policy)).toEqual({})
    expect(applyRealmEnvPatch({ CODEX_HOME: '/old' }, { set: { CODEX_HOME: '/realm' } }, policy)).toEqual({ CODEX_HOME: '/realm' })
  })

  it('rejects patch names that are not environment identifiers and values an env object cannot carry; passes the developer environment through', () => {
    for (const k of ['A=B', '', 'A B', '1A', 'A-B', '__proto__x y'])
      expect(() => applyRealmEnvPatch({}, { set: { [k]: 'x' } }, { ambientAuthVariables: [], ownedVariables: [k] }), k).toThrow(/invalid variable name/)
    expect(() => applyRealmEnvPatch({}, { set: { CODEX_HOME: 'x\nB=y' } }, policy)).toThrow(/invalid value/)
    expect(() => applyRealmEnvPatch({}, { set: { CODEX_HOME: 1 as never } }, policy)).toThrow(/must be a string/)
    // Base keys are NOT held to the patch-name shape. An interactive PTY
    // inherits the developer environment for terminal-wrapper fidelity (D3),
    // and Windows really carries ProgramFiles(x86) -- MSVC and node-gyp
    // probes read it. Only what an env object cannot carry is dropped.
    // ... but a key no environment can address, or a value the native APIs
    // would truncate, is still dropped: a CR or LF in a key is the injection
    // primitive for anything that serialises an env to text, and this repo
    // builds remote export lines over SSH.
    const base = {
      'ProgramFiles(x86)': '/pf86', 'CommonProgramFiles(x86)': '/cpf86', 'has space': 'kept',
      'A=B': 'x', GOOD: 'y', '': 'z',
      ['CR' + String.fromCharCode(13) + 'KEY']: 'x', ['LF' + String.fromCharCode(10) + 'KEY']: 'x',
      ['NUL' + String.fromCharCode(0) + 'KEY']: 'x', NULVAL: 'a' + String.fromCharCode(0) + 'b',
    }
    expect(applyRealmEnvPatch(base as never, { set: {} }, policy)).toEqual({ 'ProgramFiles(x86)': '/pf86', 'CommonProgramFiles(x86)': '/cpf86', 'has space': 'kept', GOOD: 'y' })
    // A REAL own __proto__ key (an object literal creates none, so the old
    // assertion could not fail). Neither shape may pollute the prototype.
    const polluting = JSON.parse(String.raw`{"__proto__":{"polluted":"1"},"GOOD":"y"}`)
    expect(applyRealmEnvPatch(polluting, { set: {} }, policy)).toEqual({ GOOD: 'y' })
    expect(() => applyRealmEnvPatch({}, { set: JSON.parse(String.raw`{"__proto__":"x"}`) }, policy)).toThrow(/not a variable this provider owns/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('the main-core wrapper takes the policy from the registered package, so a launch cannot opt out', () => {
    _resetProviderRegistryForTest()
    registerProviderPackage(pkg('codex', fullCaps(), { ambientAuthVariables: ['CODEX_HOME', 'OPENAI_API_KEY'], ownedLaunchVariables: ['CODEX_HOME'] }))
    const out = realmEnvForProvider('codex', { OPENAI_API_KEY: 'sk-poison', HOME: '/h' }, { set: { CODEX_HOME: '/realm' } })
    expect(out).toEqual({ HOME: '/h', CODEX_HOME: '/realm' })
    expect(() => realmEnvForProvider('codex', {}, { set: { PATH: '/evil' } })).toThrow(/decides what the child process executes/)
    expect(() => realmEnvForProvider('codex', {}, { set: { OPENAI_API_KEY: 'sk-x' } })).toThrow(/not a variable this provider owns/)
    expect(() => realmEnvForProvider('claude', {}, { set: {} })).toThrow(/not registered/)
    // The wrapper has no policy parameter, so there is no argument a caller
    // could pass to weaken it. R3 in dependency-boundaries.test.ts is what
    // stops a caller importing applyRealmEnvPatch and supplying its own.
    expect(realmEnvForProvider.length).toBe(3)
  })
})

describe('renderer provider registry and default actions', () => {
  beforeEach(() => _resetRendererProviderRegistryForTest())
  const descriptor = (id: 'claude' | 'codex', over: Partial<RendererProviderDescriptor> = {}): RendererProviderDescriptor => {
    const d: RendererProviderDescriptor = {
      id, displayName: id, shortName: id, maturity: 'stable', accentToken: `--provider-accent-${id}`,
      copy: { enableQuestion: 'q', enabledSubtitle: 's', cliMissing: 'm', cliMissingHint: 'h', notSignedIn: 'n', signedInHint: 'i' },
      setupSteps: [{ id: 'detect', kind: 'detect', title: 't', capability: 'cli.discovery' }],
      authMethods: [{ method: 'browser', label: 'b', capability: 'auth.browser' }, { method: 'device', label: 'd', capability: 'auth.device' }],
      actions: (ctx) => defaultProviderActions(d, ctx),
      ...over,
    }
    return d
  }

  it('registers in PROVIDER_IDS order and fails closed on an unknown id, a duplicate and empty setup steps', () => {
    registerRendererProvider(descriptor('codex'))
    registerRendererProvider(descriptor('claude'))
    expect(listRendererProviders().map((d) => d.id)).toEqual([...PROVIDER_IDS])
    expect(getRendererProvider('codex').shortName).toBe('codex')
    expect(() => registerRendererProvider(descriptor('claude'))).toThrow(/already registered/)
    expect(() => registerRendererProvider(descriptor('gemini' as never))).toThrow(/unknown provider id/)
    _resetRendererProviderRegistryForTest()
    expect(tryGetRendererProvider('claude')).toBeNull()
    expect(() => getRendererProvider('claude')).toThrow(/not registered/)
    expect(() => registerRendererProvider(descriptor('claude', { setupSteps: [] }))).toThrow(/setup steps/)
  })

  it('actions derive from capabilities: install only when missing, enable/disable from installation, login per method, experimental labelled and provider-scoped', () => {
    const d = descriptor('codex')
    const caps: Partial<ProviderCapabilities> = { 'cli.discovery': { state: 'supported' }, 'install.recipes': { state: 'supported' }, 'auth.browser': { state: 'supported' }, 'auth.device': { state: 'experimental', note: 'beta' }, 'auth.logout': { state: 'unsupported', note: 'nope' } }
    const found = d.actions({ platform: 'linux', capabilities: caps, installation: { enabled: true, discoveryState: 'found', setupState: 'needs-auth' } })
    expect(found.map((a) => a.kind)).toEqual(['provider.disable', 'provider.recheck', 'account.login', 'account.login', 'account.logout'])
    expect(found[0].label).toBe('Turn codex off')
    const missing = d.actions({ platform: 'linux', capabilities: caps, installation: { enabled: false, discoveryState: 'missing', setupState: 'needs-install' } })
    expect(missing.map((a) => a.kind)).toEqual(['provider.enable', 'provider.recheck', 'provider.install', 'account.login', 'account.login', 'account.logout'])
    expect(missing[0].label).toBe('Turn codex on')
    const login = (list: readonly { kind: string; method?: string; enabled: boolean; labelExperimental: boolean; reason?: string }[], m: string) => list.find((a) => a.kind === 'account.login' && a.method === m)!
    expect(login(found, 'browser')).toMatchObject({ enabled: true, labelExperimental: false })
    expect(login(found, 'device')).toMatchObject({ enabled: false, labelExperimental: true, reason: 'experimental-not-enabled' })
    expect(login(d.actions({ platform: 'linux', capabilities: caps, experimentalEnabled: ['codex:auth.device'] }), 'device').enabled).toBe(true)
    expect(login(d.actions({ platform: 'linux', capabilities: caps, experimentalEnabled: ['claude:auth.device'] }), 'device').enabled).toBe(false)
    expect(found.find((a) => a.kind === 'account.logout')).toMatchObject({ enabled: false, reason: 'unsupported' })
    // A plain function: safe to pass around without its descriptor.
    const { actions } = d
    expect(actions({ platform: 'win32' }).every((a) => a.providerId === 'codex')).toBe(true)
  })
})
