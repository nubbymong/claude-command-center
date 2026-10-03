// P3.9 round 3 (L4): Sentinel's Claude Code analysis loads no settings file,
// so the network settings the account's settings file sets (proxies,
// certificates) are handed to it as variables. Only what the authority
// manifest classifies as transport and keeps; every credential, endpoint or
// other key is left out. PURE: text in, variables out.
import { describe, it, expect } from 'vitest'
import { claudeTransportSettingsEnv, createClaudePackage } from '../../../../src/main/providers/claude'

describe('claudeTransportSettingsEnv (P3.9 round 3)', () => {
  it('keeps the transport variables, under the manifest spelling; nothing else', () => {
    const raw = JSON.stringify({
      env: {
        HTTPS_PROXY: 'http://proxy.example:8080', https_proxy: 'http://other:1', NO_PROXY: 'localhost,.corp', ALL_PROXY: 'socks5://p:2',
        NODE_EXTRA_CA_CERTS: 'C:\\certs\\corp.pem', CLAUDE_CODE_CLIENT_CERT: '/c.pem',
        ANTHROPIC_API_KEY: 'sk-ant-FAKE', ANTHROPIC_BASE_URL: 'https://evil.example', CLAUDE_CONFIG_DIR: '/tmp/x', PATH: '/tmp/bin', NODE_OPTIONS: '--require x',
      },
      permissions: { allow: ['Bash'] },
    })
    const out = claudeTransportSettingsEnv(raw)
    expect(out).toEqual({ HTTPS_PROXY: 'http://other:1', NO_PROXY: 'localhost,.corp', ALL_PROXY: 'socks5://p:2', NODE_EXTRA_CA_CERTS: 'C:\\certs\\corp.pem', CLAUDE_CODE_CLIENT_CERT: '/c.pem' })
  })

  it('leaves out a value that is not a plain string line, and gives none for a file that is not a settings object', () => {
    expect(claudeTransportSettingsEnv(JSON.stringify({ env: { HTTPS_PROXY: 'http://a\nSECOND=1', HTTP_PROXY: 5, NO_PROXY: 'x'.repeat(4097), ALL_PROXY: 'ok' } }))).toEqual({ ALL_PROXY: 'ok' })
    for (const raw of ['', 'not json', 'null', '[]', '{"env":[]}', '{"env":"HTTPS_PROXY=x"}', '{}']) expect(claudeTransportSettingsEnv(raw), raw).toEqual({})
    // A leading byte-order mark is read past, as the CLI does.
    expect(claudeTransportSettingsEnv(String.fromCharCode(0xfeff) + JSON.stringify({ env: { HTTP_PROXY: 'http://p:3' } }))).toEqual({ HTTP_PROXY: 'http://p:3' })
  })

  it('is what the Claude package offers the app', () => {
    expect(createClaudePackage().managedLaunch?.transportSettingsEnv).toBe(claudeTransportSettingsEnv)
  })
})
