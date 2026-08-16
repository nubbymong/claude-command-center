/**
 * #265: the IPC boundary is the primary charset gate for the three fields that
 * reach the SSH argv / remote setup script. These import the REAL shipped
 * schemas (not mirrors) — reverting the source regex must turn these red, the
 * vacuous-guard failure mode this repo has hit before (see extra-args-guard).
 *
 * Finding 1: `host`/`username` are fused into `${username}@${host}` = argv[0];
 * ssh reads a leading `-` as an option (`-oProxyCommand=...` = local RCE).
 * Finding 3: the sessionId is interpolated into the base64'd remote setup script
 * and into remote filenames.
 */
import { describe, it, expect } from 'vitest'
import { spawnOptionsSchema, sessionIdSchema } from '../../../src/main/ipc/pty-handlers'

const baseSsh = { host: 'example.com', port: 22, username: 'me', remotePath: '~/proj' }
const sshAccepts = (patch: Record<string, unknown>): boolean =>
  spawnOptionsSchema.safeParse({ ssh: { ...baseSsh, ...patch } }).success

describe('sshSchema charset-gates host/username at the IPC boundary (#265 finding 1)', () => {
  it.each([
    { username: '-oProxyCommand=touch /tmp/pwn' },
    { username: '-l' },
    { host: '-oProxyCommand=id' },
    { host: '-p2222' },
  ])('rejects a leading-dash value %o', (patch) => {
    expect(sshAccepts(patch)).toBe(false)
  })

  it.each([
    { username: 'me evil' },
    { username: 'me\tx' },
    { host: 'example.com host2' },
    { host: 'example.com\nrm' },
  ])('rejects whitespace %o', (patch) => {
    expect(sshAccepts(patch)).toBe(false)
  })

  it.each([
    { username: 'me', host: 'example.com' },
    { username: 'my-user', host: 'my-host.example.com' },   // internal dashes
    { username: 'root', host: '[2001:db8::1]' },            // IPv6 literal
    { username: 'DOMAIN\\me', host: '10.0.0.5' },           // Windows domain user
  ])('accepts legitimate values %o', (patch) => {
    expect(sshAccepts(patch)).toBe(true)
  })
})

describe('sessionIdSchema charset-gate (#265 finding 3)', () => {
  const accepts = (v: string): boolean => sessionIdSchema.safeParse(v).success

  it.each([
    "a'b",                    // breaks the single-quoted JS literal in the setup script
    'a b',                    // whitespace splits the sh -c command
    'a;rm -rf ~',             // shell metacharacters
    'a/b',                    // path separator into a remote filename
    'a.b',                    // dot — not in the real (hex) charset
    '$(id)',
    '`whoami`',
  ])('rejects an injection-shaped id %j', (v) => {
    expect(accepts(v)).toBe(false)
  })

  it.each([
    '9f1f147ea02f2cf7d1eec041',           // a real 24-hex CSPRNG id (generateId())
    'ABCdef0123456789',
    'sess_1-2_3',                          // alnum + underscore + dash
  ])('accepts a path-safe id %j', (v) => {
    expect(accepts(v)).toBe(true)
  })

  it('rejects empty and over-long ids', () => {
    expect(accepts('')).toBe(false)
    expect(accepts('a'.repeat(201))).toBe(false)
  })
})
