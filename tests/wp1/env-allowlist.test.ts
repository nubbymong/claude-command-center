// WP1.38 -- WP2 slice 3a (owner decision D3; design 9.2): the Codex setup and
// auth subprocess environment is an allowlist. Poisoned-environment negative
// tests: nothing credential-, endpoint- or injection-bearing is forwarded,
// CODEX_HOME is always the realm, and on Windows the current-folder search
// that would let a planted `node` hijack npm's shim is always switched off.
// PURE.
import { describe, it, expect, afterEach } from 'vitest'
import { codexCliEnv, codexCliEnvAllowlist } from '../../src/main/providers/codex'

const poisoned: Record<string, string> = {
  PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_GB.UTF-8', HTTPS_PROXY: 'http://proxy:8080',
  // credentials, endpoints, state roots (the CLI's own list and the docs')
  OPENAI_API_KEY: 'sk-test-secret', CODEX_API_KEY: 'k', CODEX_ACCESS_TOKEN: 't', OPENAI_BASE_URL: 'https://evil', CODEX_URL: 'https://evil',
  CODEX_CLOUD_TASKS_BASE_URL: 'https://evil', OPENAI_FEDERATION_RULE_ID: 'r', OPENAI_IDENTITY_TOKEN_FILE: '/tmp/t', CODEX_SQLITE_HOME: '/tmp/s',
  CODEX_HOME: '/home/u/.codex', OPENAI_ORG_ID: 'o', AZURE_OPENAI_API_KEY: 'a',
  // code injection and noisy logs
  NODE_OPTIONS: '--require /tmp/evil.js', NODE_PATH: '/tmp/mods', npm_config_prefix: '/tmp/p', RUST_LOG: 'trace', BROWSER: '/tmp/evil.sh',
  LD_PRELOAD: '/tmp/x.so', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
  // anything else a shell happens to carry
  GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'x', ANTHROPIC_API_KEY: 'x',
}

afterEach(() => { delete (Object.prototype as Record<string, unknown>).OPENAI_API_KEY })

describe('the Codex CLI subprocess environment (POSIX)', () => {
  it('forwards only allowlisted names and sets CODEX_HOME to the realm, last', () => {
    const env = codexCliEnv(poisoned, '/res/codex-realms/realm-abc', 'linux')
    expect({ ...env }).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_GB.UTF-8', HTTPS_PROXY: 'http://proxy:8080', CODEX_HOME: '/res/codex-realms/realm-abc' })
    expect(Object.keys(env).at(-1)).toBe('CODEX_HOME')
  })

  it('the lower-case proxy spelling POSIX tools read is kept', () => {
    const env = codexCliEnv({ https_proxy: 'http://p:1', http_proxy: 'http://p:1', no_proxy: 'corp', all_proxy: 'socks5://p:2' }, '/r', 'linux')
    expect({ ...env }).toEqual({ https_proxy: 'http://p:1', http_proxy: 'http://p:1', no_proxy: 'corp', all_proxy: 'socks5://p:2', CODEX_HOME: '/r' })
  })

  it('names are case-sensitive on POSIX: a lower-case lookalike never displaces the real one', () => {
    const env = codexCliEnv({ path: '/tmp/evil', PATH: '/usr/bin', home: '/tmp/h', HOME: '/home/u', codex_home: '/tmp/c' }, '/r', 'linux')
    expect({ ...env }).toEqual({ PATH: '/usr/bin', HOME: '/home/u', CODEX_HOME: '/r' })
  })

  it('a D-Bus address that could run a program or reach another bus is dropped; a local socket is kept', () => {
    expect(codexCliEnv({ DBUS_SESSION_BUS_ADDRESS: 'unixexec:path=/tmp/evil,argv1=x' }, '/r', 'linux').DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(codexCliEnv({ DBUS_SESSION_BUS_ADDRESS: 'tcp:host=evil,port=1' }, '/r', 'linux').DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(codexCliEnv({ DBUS_SESSION_BUS_ADDRESS: 'autolaunch:' }, '/r', 'linux').DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(codexCliEnv({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }, '/r', 'linux').DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
    expect(codexCliEnv({ XDG_RUNTIME_DIR: 'relative' }, '/r', 'linux').XDG_RUNTIME_DIR).toBeUndefined()
  })
})

describe('the Codex CLI subprocess environment (Windows)', () => {
  it('matching is case-insensitive, the first spelling wins, and a differently cased CODEX_HOME never survives', () => {
    const env = codexCliEnv({ Path: 'C:\\Windows', PATH: 'C:\\evil', SystemRoot: 'C:\\Windows', codex_home: 'C:\\other', Openai_Api_Key: 'x' }, 'C:\\res\\codex-realms\\realm-abc', 'win32')
    expect({ ...env }).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: '1', CODEX_HOME: 'C:\\res\\codex-realms\\realm-abc' })
  })

  it('always switches off the current-folder executable search, whatever the parent had', () => {
    expect(codexCliEnv({}, 'C:\\r', 'win32').NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(codexCliEnv({ NODEFAULTCURRENTDIRECTORYINEXEPATH: '' }, 'C:\\r', 'win32').NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(Object.keys(codexCliEnv({ nodefaultcurrentdirectoryinexepath: '0' }, 'C:\\r', 'win32')).filter((k) => /nodefault/i.test(k))).toEqual(['NoDefaultCurrentDirectoryInExePath'])
  })

  it('a Unicode lookalike name (long s, dotless i) is never folded onto an allowed one', () => {
    const env = codexCliEnv({ ['\u017fSL_CERT_FILE']: 'C:\\evil.pem', SSL_CERT_FILE: 'C:\\real.pem', ['WIND\u0131R']: 'C:\\evil' }, 'C:\\r', 'win32')
    expect(env.SSL_CERT_FILE).toBe('C:\\real.pem')
    expect(Object.keys(env).some((k) => /[^\x20-\x7e]/.test(k))).toBe(false)
  })
})

describe('shape', () => {
  it('no allowlisted name carries a credential, an endpoint, a state root or an injection hook', () => {
    for (const name of codexCliEnvAllowlist()) {
      expect(name, name).not.toMatch(/OPENAI|CODEX|API_KEY|TOKEN|SECRET|NODE_|NPM_|RUST_LOG|BROWSER|PRELOAD|INSERT_LIBRARIES/)
    }
  })

  it('the result has no prototype, so a polluted Object.prototype contributes nothing', () => {
    ;(Object.prototype as Record<string, unknown>).OPENAI_API_KEY = 'sk-polluted'
    const env = codexCliEnv({ PATH: '/usr/bin' }, '/r', 'linux')
    expect(Object.getPrototypeOf(env)).toBeNull()
    const inherited: string[] = []
    for (const k in env) inherited.push(k)
    expect(inherited).toEqual(['PATH', 'CODEX_HOME'])
  })

  it('undefined values and non-string values are dropped and a missing realm home is refused', () => {
    expect({ ...codexCliEnv({ PATH: undefined, HOME: '/h', TZ: 5 as unknown as string }, '/r', 'linux') }).toEqual({ HOME: '/h', CODEX_HOME: '/r' })
    expect(() => codexCliEnv({}, '')).toThrow(/realm home/)
  })
})
