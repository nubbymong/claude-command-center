import { getConductorMcpPort, mcpSessionToken } from '../../conductor-mcp-server'
import { buildHooksBlock } from '../../hooks/session-hooks-writer'

/**
 * SSH statusline shim — Node.js script written to the REMOTE host at
 * ~/.claude/conductor-ssh-statusline.js during SSH setup.
 *
 * Claude Code on the remote runs this as its statusLine command. The shim
 * receives JSON status data on stdin (from Claude's statusline hook), then
 * emits an OSC sentinel directly to the controlling TTY (/dev/tty).
 *
 * The OSC sentinel travels back through the SSH PTY to the local Conductor,
 * where pty-manager's OSC parser extracts and dispatches it to the renderer.
 *
 * /dev/tty is used (not stdout) because Claude captures the script's stdout
 * for its own statusline display — writing the sentinel there would either
 * be re-rendered visibly or stripped. /dev/tty bypasses Claude entirely.
 */
// Claude Code now ships `rate_limits.five_hour` and `rate_limits.seven_day`
// on the statusline stdin JSON (see https://code.claude.com/docs/en/statusline).
// The shim used to read `~/.claude/.credentials.json` and call
// api.anthropic.com/api/oauth/usage itself — that pulled in `https`, needed a
// /tmp cache, and coupled us to the OAuth token format. Reading from stdin is
// smaller, zero-network, and survives token-format changes. Trade-off: stdin
// doesn't expose `extra_usage`, so SSH statuslines no longer show the extra
// top-up bar (local sessions still do). Re-add via API later if needed.
// Fallback order for the OSC sentinel (first that succeeds wins):
//   1. tmux client tty (#242) — checked FIRST, ahead of /dev/tty below.
//      Under tmux, EVERY device this shim's own process tree can reach --
//      /dev/tty (case 2) and the ancestor-pts walk (case 3) alike -- is the
//      pane's pty, because that pane pty IS this process's (detached)
//      controlling context; tmux swallows an unrecognised OSC written there
//      instead of forwarding it to the attached client. Neither fallback
//      below can ever reach the outer ssh PTY once $TMUX is set, so tmux
//      must be tried first, not because /dev/tty would falsely "succeed"
//      but because it and the pts walk both land on the wrong pty entirely.
//      Ask the tmux SERVER for `#{client_tty}` — the device path of the tty
//      the ATTACHED CLIENT (the outer ssh session) is on — and write the
//      sentinel straight there, bypassing the pane pty and any tmux
//      forwarding entirely. tmuxBin comes from $CCC_TMUX_BIN, baked into the
//      statusLine command by generateRemoteSetupScript from the tier-1/2
//      probe result — tmux is NOT assumed to be on PATH (tiers 2+ stage it
//      under ~/.claude/bin). CCC_TMUX_BIN is allowlist-guarded at the point
//      generateRemoteSetupScript bakes it in (see the `tmuxPath` guard
//      there, mirroring SAFE_TMUX_BIN_RE in ssh-tmux.ts) — this shim can
//      trust the value it's handed. Empty `#{client_tty}` output means the
//      tmux session is detached (no attached client) — nothing to display,
//      so skip the write rather than fail. `ok` is set true on this branch
//      too (adversarial review round 5, #242 M7 fix): the prior version left
//      `ok` false here, so a detached session fell through to /dev/tty then
//      the ancestor-pts walk below — the latter usually lands on the PANE
//      pty (which still exists even with no attached client) and succeeds,
//      logging a `pts-ok` "success" for a sentinel nobody is attached to
//      ever see. Marking this handled prevents that false-positive trace.
//      The `display-message` call carries a 2s timeout: a hung or half-dead
//      tmux server must not stall the statusLine child indefinitely on
//      every refresh -- a timeout kill throws, which the catch below turns
//      into a `tmux-fail` trace line same as any other failure. See the
//      decision note on buildTmuxLaunchCommand in ssh-tmux.ts.
//      `tty` itself is validated before the write (adversarial review round
//      5, #242 M1): must be an absolute path under `/dev/` AND an actual
//      character device (fs.statSync().isCharacterDevice()) — `tmux
//      display-message` is trusted output from a binary this app itself
//      staged/resolved, not remote-attacker input, but fs.writeFileSync on
//      an arbitrary returned path would otherwise CREATE or TRUNCATE a
//      regular file if that trust were ever misplaced (a future tmux
//      version, a wrapper script, a malformed `#{client_tty}` expansion).
//   2. /dev/tty — the controlling terminal. Correct outside tmux, but Claude
//      runs the statusLine command as a DETACHED child (via `sh -c`), so
//      that child usually has NO controlling terminal and this fails with
//      ENXIO over a plain (non-tmux) SSH session.
//   3. Ancestor pts — walk the process tree for the /dev/pts/N slave that an
//      ancestor (claude itself) holds on one of its fds, and write the sentinel
//      to that device. Writing the pts slave sends bytes toward the master →
//      sshd → local, i.e. it reaches the ssh PTY and the local OSC parser. This
//      is the path that actually works over SSH (outside tmux). Linux-only
//      (needs /proc). Also serves as a fallback if tier 1 has no
//      $CCC_TMUX_BIN or the tmux server call fails (under tmux this still
//      lands on the pane pty, which tmux swallows, but it costs nothing to try).
//   4. stderr — last resort. NOTE: over SSH, Claude captures the child's stderr
//      on a pipe, so this typically does NOT reach the local PTY (that is why
//      the pre-fix shim, which relied on it, never showed a statusline). Kept
//      only for environments where the child's stderr is inherited.
//   5. Append a trace line to ~/.claude/conductor-shim.log on every path
//      (tmux-clienttty-ok / tmux-detached / tmux-fail / tty-fail / pts-ok /
//      pts-fail / pts-none / stderr-fallback) so "no statusline ever
//      appeared" stays diagnosable without guesswork. The log is capped via
//      append-and-forget; grows slowly.
const SSH_STATUSLINE_SHIM = `#!/usr/bin/env node
const fs=require('fs'),os=require('os'),path=require('path');
const logPath=path.join(os.homedir(),'.claude','conductor-shim.log');
const trace=(m)=>{try{fs.appendFileSync(logPath,new Date().toISOString()+' '+m+'\\n');}catch{}};
// Walk up the process tree to find the pty slave (/dev/pts/N) the SSH session
// is attached to. The statusLine command runs as a detached child, so it has no
// controlling terminal; an ancestor (claude) still holds the pts on an fd.
const findPty=()=>{let pid=process.pid;for(let h=0;h<8&&pid>1;h++){for(const fd of[0,1,2]){try{const p=fs.readlinkSync('/proc/'+pid+'/fd/'+fd);if(p.indexOf('/dev/pts/')===0)return p;}catch{}}try{const st=fs.readFileSync('/proc/'+pid+'/stat','utf8');pid=parseInt(st.slice(st.lastIndexOf(')')+2).split(' ')[1],10);}catch{return null;}}return null;};
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{
try{
const data=JSON.parse(input);
const sid=process.argv[2]||process.env.CLAUDE_MULTI_SESSION_ID||(data&&data.session_id)||'unknown';
const cw=data.context_window||{};
const u=cw.current_usage||{};
const it=(u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0);
const cost=data.cost||{};
const m=data.model||{};
const rl=data.rate_limits||{};
const s={sessionId:sid,model:m.display_name||m.id,contextUsedPercent:cw.used_percentage,contextRemainingPercent:cw.remaining_percentage,contextWindowSize:cw.context_window_size,inputTokens:it||undefined,outputTokens:u.output_tokens,costUsd:cost.total_cost_usd,totalDurationMs:cost.total_duration_ms,linesAdded:cost.total_lines_added,linesRemoved:cost.total_lines_removed,timestamp:Date.now()};
const iso=(t)=>typeof t==='number'?new Date(t*1000).toISOString():(t||'');
if(rl.five_hour){s.rateLimitCurrent=Math.round(Number(rl.five_hour.used_percentage)||0);s.rateLimitCurrentResets=iso(rl.five_hour.resets_at);}
if(rl.seven_day){s.rateLimitWeekly=Math.round(Number(rl.seven_day.used_percentage)||0);s.rateLimitWeeklyResets=iso(rl.seven_day.resets_at);}
const sentinel='\\x1b]9999;CMSTATUS='+JSON.stringify(s)+'\\x07';
let ok=false;if(process.platform==='win32'){try{fs.writeFileSync(String.fromCharCode(92,92,46,92)+'CONOUT$',sentinel);ok=true;trace('conout-ok sid='+sid);}catch(e0){trace('conout-fail sid='+sid+' err='+(e0&&e0.code||e0.message||'unknown'));}}
if(process.env.TMUX){
// Self-heal (2026-08-27): $CCC_TMUX_BIN can be empty or stale — the bake ran
// before a tier-3/4 stage, the post-stage patch missed, or the session runs
// inside the USER'S OWN tmux (bake correctly classed 'none'). Claude is still
// under tmux either way, so try candidates in order: the baked bin, the staged
// ~/.claude/bin/tmux, then PATH tmux (execFileSync argv lookup — no shell).
// First candidate whose display-message answers wins; every attempt traces.
const cands=[];
const tb=process.env.CCC_TMUX_BIN||'';
if(tb)cands.push(tb);
const hb=path.join(os.homedir(),'.claude','bin','tmux');
if(cands.indexOf(hb)<0)cands.push(hb);
cands.push('tmux');
for(const c of cands){
if(ok)break;
if(c!=='tmux'&&!/^[A-Za-z0-9_./-]+$/.test(c)){trace('tmux-skip sid='+sid+' cand-unsafe');continue;}
try{
const out=require('child_process').execFileSync(c,['display-message','-p','#{client_tty}'],{encoding:'utf8',timeout:2000});
const tty=out.split('\\n')[0].trim();
if(tty){
try{
if(tty.indexOf('/dev/')!==0)throw new Error('not-under-dev');
if(!fs.statSync(tty).isCharacterDevice())throw new Error('not-a-chardev');
fs.writeFileSync(tty,sentinel);ok=true;trace('tmux-clienttty-ok sid='+sid+' dev='+tty+' via='+c);
}catch(e4){trace('tmux-fail sid='+sid+' dev='+tty+' cand='+c+' err='+(e4&&e4.code||e4.message||'unknown'));}
}else{ok=true;trace('tmux-detached sid='+sid+' via='+c);}
}catch(e5){trace('tmux-fail sid='+sid+' cand='+c+' err='+(e5&&e5.code||e5.message||'unknown'));}
}
}
if(!ok){try{fs.writeFileSync('/dev/tty',sentinel);ok=true;}catch(e){trace('tty-fail sid='+sid+' err='+(e&&e.code||e.message||'unknown'));}}
if(!ok){const pts=findPty();if(pts){try{fs.writeFileSync(pts,sentinel);ok=true;trace('pts-ok sid='+sid+' dev='+pts);}catch(e2){trace('pts-fail sid='+sid+' dev='+pts+' err='+(e2&&e2.code||e2.message||'unknown'));}}else{trace('pts-none sid='+sid);}}
if(!ok){try{process.stderr.write(sentinel);trace('stderr-fallback sid='+sid);}catch(e3){trace('stderr-fail sid='+sid+' err='+(e3&&e3.message||'unknown'));}}
process.stdout.write(' ');
}catch(e){trace('parse-fail err='+(e&&e.message||'unknown'));process.stdout.write(' ');}
});
`

/**
 * Generate a single node script that handles ALL remote setup:
 * - Writes the SSH statusline shim to ~/.claude/conductor-ssh-statusline.js
 * - Configures statusline in settings.json to invoke the shim
 * - Configures MCP vision server (if running) in settings.json
 * - Cleans up legacy CLAUDE.md vision markers
 *
 * Returns the script content. The PTY base64-encodes and pipes it to node.
 */
export function generateRemoteSetupScript(
  sessionId: string,
  hooksConfig: { port: number; secret: string } | null,
  opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number } | undefined,
  nonce: string,
): string {
  // #242 finding F1 (b): the `setup ok` sentinel this script emits (bottom
  // of `lines`, below) MUST carry `nonce` -- required, not optional, so a
  // future call site cannot silently regress to the pre-nonce sentinel shape
  // by omitting the argument. Charset-guarded before interpolation into the
  // remote-facing script text, same reasoning as assertSafeNonce
  // (ssh-tmux-stage.ts) — this whole script runs under `2>/dev/null`
  // (getRemoteSetupCommand), so a thrown error here silently aborts setup
  // rather than crashing anything; that is an acceptable fail-closed
  // degrade for a nonce this app itself generated and should never be
  // malformed in production.
  if (!/^[A-Za-z0-9]+$/.test(nonce)) {
    throw new Error(`generateRemoteSetupScript: nonce "${nonce}" fails the charset guard (expected [A-Za-z0-9]+).`)
  }
  const { includeStatusLine = true, includeConductorMcp = true, remoteMcpPort } = opts ?? {}
  // Conductor MCP server is always running (independent of browser/vision config),
  // so SSH sessions always get the conductor MCP entry pointing at the
  // reverse-tunneled MCP port. The fetch_host_screenshot tool is always available;
  // browser tools fall back to "vision not connected" if no browser is attached.
  //
  // Mirror writeLocalSessionMcpConfig exactly: read the runtime port without a
  // hardcoded fallback. If the server failed to bind (mcpPort === 0) we write
  // an empty mcpServers object so the SSH session sees no tools rather than
  // pointing at a phantom 19333 endpoint that may or may not match where the
  // server actually came up.
  const mcpPort = getConductorMcpPort()
  // Built-in tools master off => empty remote mcpServers, same as the port-0
  // fallback: the session sees no tools rather than a dangling endpoint.
  const hasVision = mcpPort > 0 && includeConductorMcp
  // Embed the shim as a JSON string literal -- Node parses it back to source
  const shimLiteral = JSON.stringify(SSH_STATUSLINE_SHIM)
  // Sanitise for path use -- sessionId comes from session.id (generateId), but
  // belt-and-braces because it's embedded in a filename we write.
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')

  // Per-session settings file (~/.claude/settings-<sid>.json) passed via
  // `claude --settings`. Previously we rewrote the shared ~/.claude/settings.json
  // and baked CLAUDE_MULTI_SESSION_ID into its statusLine command, but multiple
  // concurrent sessions to the same host would clobber each other, so Claude
  // Code caching the latest write meant statusline updates landed under the
  // wrong local sessionId after the second session connected. Per-session
  // files let each Claude keep its own sid in its own settings view.
  //
  // P7.8: settings file no longer carries mcpServers. Claude CLI reads
  // mcpServers ONLY from ~/.claude.json or --mcp-config (the --settings
  // mcpServers block is silently ignored). We now write a separate
  // ~/.claude/mcp-<sid>.json and pass it via `--mcp-config <path>`.
  // Settings file still owns statusLine + hooks.
  //
  // Hooks: when the HTTP Hooks Gateway is running, the per-session settings
  // file also carries a `hooks` block pointing at `http://localhost:<hooksPort>/hook/<sid>`.
  // The SSH connection's `-R <hooksPort>:localhost:<hooksPort>` tunnel makes
  // that loopback URL resolve to the host's gateway.
  const hooksLiteral = hooksConfig
    ? JSON.stringify(buildHooksBlock(sessionId, hooksConfig.port, hooksConfig.secret))
    : null
  // P7.7.10 parity: bake `?cccSessionId=<sid>` into the MCP URL so the
  // server resolves the CCC session from the SSE transport rather than
  // trusting an LLM-supplied tool arg. parseCccSessionIdFromUrl on the
  // host side picks this up and gates codex_review by it.
  // R-DEC-3: bake &token=<secret> into the reverse-tunneled MCP URL so the SSH
  // session authenticates against the gated host MCP server. The tunnel forwards
  // localhost:<mcpPort> to the host, where the auth gate validates the token.
  const mcpConfigLiteral = hasVision
    ? JSON.stringify({
        mcpServers: {
          'conductor': {
            type: 'sse',
            url: `http://localhost:${remoteMcpPort && remoteMcpPort > 0 ? remoteMcpPort : mcpPort}/sse?cccSessionId=${encodeURIComponent(sessionId)}&token=${mcpSessionToken(sessionId)}`,
          },
        },
      })
    : JSON.stringify({ mcpServers: {} })
  // Master status-line switch: with it off, the per-session clone simply gets
  // no statusLine key (the shim file is still staged but inert without it).
  //
  // CCC_TMUX_BIN is baked in alongside CLAUDE_MULTI_SESSION_ID so the shim's
  // $TMUX branch (SSH_STATUSLINE_SHIM above) can reach the tmux server
  // without assuming `tmux` is on PATH (tiers 2+ stage it under
  // ~/.claude/bin, which a pane's shell may not have on PATH). `tmuxPath` is
  // a REMOTE-side variable, not a TS value -- the tier-1/2 probe only runs
  // once the generated script executes on the target host, so this is
  // string concatenation (`+tmuxPath+`) baked into the emitted source, the
  // same trick already used for `+shimPath` below. That means the probe
  // (declared further down in `lines`) must run BEFORE this statement, so
  // it is placed immediately after the shim is written, ahead of the
  // sesCfg build.
  const sesCfgParts: string[] = []
  if (includeStatusLine) {
    // Use safeSid, not the raw sessionId (#265; independently reached by #242
    // F2): this value is embedded in a single-quoted JS string literal inside
    // the setup script AND becomes the `command` claude later runs via `sh -c`.
    // A raw id bearing a quote/space/metacharacter would break out of the literal
    // (remote code execution) or split the command. The IPC boundary already
    // charset-gates the id; this is the sink-side backstop, and a no-op for real
    // (hex) ids. Every OTHER embedding is already neutralised — the URL via
    // encodeURIComponent, the filenames via safeSid — so this was the last raw path.
    //
    // #242 F3: CCC_TMUX_BIN='+tmuxPath+' is baked in so the statusline shim can
    // find the tmux binary under a persistent session. tmuxPath is the tier-1/2
    // probe result (empty when none); after a tier-3/4 stage succeeds it is
    // rewritten by buildTmuxBinPatchCommand. tmuxPath is charset-guarded upstream.
    sesCfgParts.push(`statusLine:{type:'command',command:'CLAUDE_MULTI_SESSION_ID=${safeSid} CCC_TMUX_BIN='+tmuxPath+' node '+shimPath}`)
  }
  if (hooksLiteral) sesCfgParts.push(`hooks:${hooksLiteral}`)

  // Build as semicolon-separated statements -- NO comments (they break single-lining)
  const lines = [
    `const fs=require('fs'),path=require('path'),os=require('os')`,
    `const home=os.homedir(),claudeDir=path.join(home,'.claude')`,
    `try{fs.mkdirSync(claudeDir,{recursive:true,mode:0o700})}catch{}`,
    // mkdir's mode applies ONLY when it creates the directory. On any remote
    // host where the operator has run claude before -- the common case --
    // ~/.claude already exists and keeps its old mode, typically 0755 under a
    // default umask, so mkdir above is a mode no-op. Re-assert 0700
    // unconditionally, the same repair hardenCredentialDir makes locally: a
    // co-tenant cannot plant a link (or any entry) in a 0700 directory the
    // operator owns, which is what closes the redirect of the token-bearing
    // writes below (GHSA-phr3-g5qh-q4v5).
    `try{fs.chmodSync(claudeDir,0o700)}catch{}`,
    `const shimPath=path.join(claudeDir,'conductor-ssh-statusline.js')`,
    // Unlink-then-exclusive-create, matching the two writes below.
    //
    // The chmod above closes this for a link planted AFTER we harden the
    // directory, but not for one that was already sitting there -- and a plain
    // writeFileSync FOLLOWS an existing symlink, so a pre-existing link at this
    // path redirects the write to wherever it points. Every other write in this
    // function was given rmSync + flag:'wx' for exactly that reason; this one
    // was missed. `wx` also means we never silently write through something we
    // did not create: if the unlink fails, the create fails too.
    //
    // The content is our own (the shim source), so the exposure is a redirected
    // WRITE rather than a leaked secret -- weaker than the token files, but the
    // same primitive, and it is the last write here without the guard.
    `try{fs.rmSync(shimPath,{force:true})}catch{}try{fs.writeFileSync(shimPath,${shimLiteral},{mode:0o755,flag:'wx'})}catch{}`,
    // #242 tmux detection, tier 1-2. Tier 1: PATH, via the `command -v`
    // shell builtin (not `which` -- not guaranteed present on minimal
    // images). Tier 2: ~/.claude/bin/tmux, the staging path a later tier
    // (base64 push / pinned static build) writes a self-fetched binary to.
    // fs.accessSync(X_OK) rather than existsSync -- a staged-but-not-yet-
    // chmod'd file must not be reported as usable. Tiers 3+ (remote
    // curl/wget fetch, host-side base64 push, --continue degradation) are
    // NOT implemented here; a miss at both tiers reports 'none' and
    // pty-manager falls back to the bare (non-tmux) claude launch. Run
    // BEFORE the sesCfg build below -- CCC_TMUX_BIN in the statusLine
    // command needs `tmuxPath` to already exist.
    //
    // #242 round-3 correction (I3): `tmuxClass` -- not `tmuxPath` -- is what
    // crosses back over the wire in the `setup ok` sentinel below.
    // `tmuxPath` itself stays purely local to THIS remote script, feeding
    // only the CCC_TMUX_BIN bake-in a few lines down (read back by the
    // statusline shim's own child process on the SAME host, never sent to
    // the local Conductor) -- pty-manager's launch-command sink
    // (buildTmuxLaunchCommand, ssh-tmux.ts) no longer accepts a
    // remote-reported path for either tier at all, so there is nothing left
    // for a wire-carried path to influence.
    `let tmuxPath='';let tmuxClass='none';try{tmuxPath=require('child_process').execSync('command -v tmux',{encoding:'utf8'}).trim();if(tmuxPath)tmuxClass='path'}catch{}`,
    // Follow-up adversarial pass (fail-posture MINOR): the tier-2 probe used
    // fs.accessSync(X_OK) alone, which is satisfied by a zero-byte file, a
    // half-written download, a wrong-architecture binary and even a DIRECTORY
    // named `tmux` (POSIX X_OK on a searchable directory succeeds). Any of
    // those got reported as `home`, wrapping every future launch on this host
    // in a binary that cannot run. Actually EXECUTING it (`-V`, bounded) is the
    // only check that answers the question the class claims to answer.
    `if(!tmuxPath){const cb=path.join(claudeDir,'bin','tmux');try{fs.accessSync(cb,fs.constants.X_OK);require('child_process').execFileSync(cb,['-V'],{timeout:5000,stdio:'ignore'});tmuxPath=cb;tmuxClass='home'}catch{}}`,
    // Follow-up adversarial pass (fail-posture MAJOR): if the remote login
    // shell is ALREADY inside tmux (a very common `[ -z "$TMUX" ] && exec tmux
    // new -A` in a user's rc file), wrapping the launch in another
    // `new-session -A` is refused by tmux itself ("sessions should be nested
    // with care, unset $TMUX to force") -- exit 1, no claude, on every single
    // connect. Report `none` so the launch stays bare: the user's own outer
    // tmux is already providing the persistence this tier would have added,
    // and a session that starts is strictly better than a pill that says
    // "persistent" over a session that never launched.
    //
    // Statusline fix (SSBN root cause, 2026-08-27): clear ONLY tmuxClass —
    // NOT tmuxPath. Claude still runs INSIDE the user's tmux, and the
    // statusline shim needs CCC_TMUX_BIN to reach the tmux client tty (an
    // unrecognised OSC written to the pane pty is swallowed by tmux). The
    // old line also wiped tmuxPath, baking an empty CCC_TMUX_BIN, so the
    // shim fell back to /dev/tty inside the pane and the CMSTATUS sentinel
    // never left the host — the "statusline row stuck on pending" bug for
    // every user-owned-tmux session. tmuxPath feeds ONLY the CCC_TMUX_BIN
    // bake (see the round-3 note above); the launch decision reads
    // tmuxClass, so the no-nesting guarantee is unchanged.
    `if(process.env.TMUX){tmuxClass='none'}`,
    // #242 MAJOR (round 2, adversarial review): allowlist guard on tmuxPath,
    // BEFORE its one remaining consumer below (CCC_TMUX_BIN). `command -v
    // tmux` and the ~/.claude/bin access check both hand back a value this
    // script does not control -- a shell function, alias, or wrapper named
    // `tmux` on the remote PATH, or (via the base64-push/pinned-binary tiers
    // this ladders toward) a staged file whose path this run doesn't fully
    // own -- and that value reaches the CCC_TMUX_BIN bake-in (sesCfgParts,
    // read back into a `sh -c` command on every statusline refresh).
    // Character class is IDENTICAL to SAFE_TMUX_BIN_RE in src/main/ssh-tmux.ts
    // -- that is the paired definition for this same shape of value at ITS
    // sink (parseTmuxStageSentinel's tier-3/4 path capture), and the two
    // must never drift apart. CLEAR rather than throw (both tmuxPath AND
    // tmuxClass): this whole script runs under `2>/dev/null`
    // (getRemoteSetupCommand) so a thrown error here is silently swallowed
    // and setup aborts outright (shim never staged, settings never
    // written); clearing instead degrades to the pre-#242 bare (non-tmux)
    // launch and an empty CCC_TMUX_BIN -- the same fail-closed choice this
    // codebase already makes for every other shape of bad value on this
    // ladder.
    `if(tmuxPath&&!/^[A-Za-z0-9_./-]+$/.test(tmuxPath)){tmuxPath='';tmuxClass='none'}`,
    // Read the user's shared settings FIRST so the per-session settings file
    // can inherit every top-level key (outputStyle, permissions, future
    // additions). The two CCC-owned keys (statusLine, hooks) then override
    // whatever the shared file had. mcpServers is NOT inherited or written
    // here -- it lives in the separate --mcp-config file (see below).
    `const sp=path.join(claudeDir,'settings.json')`,
    `let s={};try{s=JSON.parse(fs.readFileSync(sp,'utf-8'))}catch{}`,
    // Strip mcpServers from the inherited clone -- the per-session settings
    // file should not carry any mcpServers state. Claude CLI ignores it
    // there anyway; stripping prevents stale entries from leaking through.
    `const sBase=Object.assign({},s);delete sBase.mcpServers`,
    // Strip a LEGACY statusLine stanza from the clone too, not just the shared
    // file below: with includeStatusLine=false there is no CCC override, so a
    // pre-per-session install's shared stanza would otherwise be inherited by
    // the per-session file on the FIRST post-upgrade connect (the shared-file
    // heal further down runs after this clone is taken).
    `if(sBase.statusLine&&typeof sBase.statusLine.command==='string'&&sBase.statusLine.command.includes('conductor-ssh-statusline'))delete sBase.statusLine`,
    // Per-session settings -- clone of shared (without mcpServers) with CCC
    // keys overridden.
    `const sesPath=path.join(claudeDir,'settings-${safeSid}.json')`,
    `const sesCfg=Object.assign({},sBase,{${sesCfgParts.join(',')}})`,
    // settings-<sid>.json can carry the per-session hook token; write it
    // owner-only. Unlink first to clear a legitimate leftover, then create
    // EXCLUSIVELY (flag 'wx'): the write refuses (EEXIST) rather than follows a
    // symlink re-planted in the unlink->write window, and the 0600 mode applies
    // on this fresh create. The 0700 dir above is the primary defence; 'wx' is
    // the backstop for a link planted before the chmod (GHSA-phr3-g5qh-q4v5).
    // A refused write fails closed -- the session launches without the
    // per-session file, exactly as any other write failure the catch tolerates.
    `try{fs.rmSync(sesPath,{force:true})}catch{}try{fs.writeFileSync(sesPath,JSON.stringify(sesCfg,null,2),{mode:0o600,flag:'wx'})}catch{}`,
    // Per-session MCP config -- passed via `--mcp-config <path>` on the
    // claude launch. This is the canonical place for mcpServers entries
    // (P7.7.3); writing to --settings has no effect.
    `const mcpPath=path.join(claudeDir,'mcp-${safeSid}.json')`,
    // mcp-<sid>.json carries the Conductor ?token= secret; owner-only,
    // exclusive fresh create (see the settings write above for why
    // unlink-first + flag 'wx' + 0600).
    `try{fs.rmSync(mcpPath,{force:true})}catch{}try{fs.writeFileSync(mcpPath,${JSON.stringify(mcpConfigLiteral)},{mode:0o600,flag:'wx'})}catch{}`,
    // Strip any legacy statusLine stanza a prior install wrote into the
    // shared settings file; it would override the per-session file.
    `if(s.statusLine&&typeof s.statusLine.command==='string'&&s.statusLine.command.includes('conductor-ssh-statusline'))delete s.statusLine`,
    // Strip mcpServers entries we own (legacy 'conductor-vision' AND the
    // current 'conductor' key) from BOTH the shared settings file and
    // ~/.claude.json so users who upgraded from a build that wrote them
    // there don't end up with stale entries. We no longer add the entry
    // back to either file -- --mcp-config supersedes both.
    `if(s.mcpServers){if(s.mcpServers['conductor-vision'])delete s.mcpServers['conductor-vision'];if(s.mcpServers['conductor'])delete s.mcpServers['conductor']}`,
    `try{fs.writeFileSync(sp,JSON.stringify(s,null,2))}catch{}`,
    // SSH tmux enhancement (item 10): while ~/.claude.json is already open for
    // the mcpServers heal, also grab oauthAccount.emailAddress -- the SAME
    // field the LOCAL identity reader uses (claude-account-identity.ts) -- so a
    // remote session can show which account it runs as. base64 the value here
    // so the wire token carries no space/shell/regex metacharacter; the host
    // decodes + charset/length-caps it for DISPLAY only (parseSetupAccountSentinel,
    // pty-manager.ts), never interpreting it. `acctB64` stays '' when there is
    // no account or the file is unreadable.
    `let acctB64='';try{const cj=path.join(home,'.claude.json');if(fs.existsSync(cj)){let c=JSON.parse(fs.readFileSync(cj,'utf-8'));if(c&&c.oauthAccount&&typeof c.oauthAccount.emailAddress==='string')acctB64=Buffer.from(c.oauthAccount.emailAddress,'utf-8').toString('base64');let mut=false;if(c.mcpServers){if(c.mcpServers['conductor-vision']){delete c.mcpServers['conductor-vision'];mut=true}if(c.mcpServers['conductor']){delete c.mcpServers['conductor'];mut=true}}if(mut)fs.writeFileSync(cj,JSON.stringify(c,null,2))}}catch{}`,
    `try{const md=path.join(claudeDir,'CLAUDE.md');let c=fs.readFileSync(md,'utf-8');const rx=/\\n?\\n?<!-- VISION-INSTRUCTIONS-START -->[\\s\\S]*?<!-- VISION-INSTRUCTIONS-END -->\\n?/g;if(rx.test(c)){c=c.replace(rx,'').trim();fs.writeFileSync(md,c?c+'\\n':'')}}catch{}`,
    // Sentinel now carries the tmux result alongside the original
    // completion marker: pty-manager's parseTmuxSentinel requires an EXACT
    // match on THIS session's nonce, immediately after 'setup ok', before
    // ever latching completion OR reading the tmux= field -- #242 finding
    // F1 (b)/I2 correction: latching used to be gated on a bare substring
    // check ('setup ok' with no nonce requirement), so a spoofed sentinel
    // lacking the nonce (a co-tenant's wall/write, a MOTD script, any other
    // PTY writer) could still latch completion early and starve the real
    // sentinel of ever being parsed -- see parseTmuxSentinel's doc comment
    // (pty-manager.ts).
    //
    // #242 round-3 correction (I3): the field itself is now a fixed CLASS
    // (`path`/`home`/`none`), never a path -- `tmuxClass` above, NOT
    // `tmuxPath`. pty-manager's launch-command sink picks the actual
    // command token (`"$(command -v tmux)"` for `path`, the fixed
    // `$HOME/.claude/bin/tmux` literal for `home`) from a host-authored
    // literal table keyed on this class, so there is no wire-reported path
    // for a spoofed sentinel to influence even with a stolen/copied nonce.
    // item 10: the account descriptor rides the SAME nonce'd sentinel, AFTER
    // the tmux class, as `acct=<base64email>` (empty when unknown). Kept a
    // fixed b64 charset so parseTmuxSentinel's completion latch (which now
    // tolerates an optional ` acct=<b64>` suffix before the line terminator)
    // still resolves, and so the value can't smuggle a space/metacharacter.
    `process.stdout.write('setup ok ${nonce} tmux='+tmuxClass+' acct='+acctB64+'\\n')`,
  ]
  return lines.join(';')
}

// Path to the per-session settings file on the remote. Kept in sync with the
// filename written by generateRemoteSetupScript so the claude launch can point
// at it via --settings.
export function remoteSessionSettingsPath(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `~/.claude/settings-${safeSid}.json`
}

/**
 * Path to the per-session MCP config file on the remote (P7.8). Mirrors
 * remoteSessionSettingsPath; the claude launch passes it via `--mcp-config`.
 * Claude CLI reads mcpServers from this file but NOT from --settings, so
 * this is the canonical location for the conductor MCP entry on SSH.
 */
export function remoteSessionMcpConfigPath(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `~/.claude/mcp-${safeSid}.json`
}

/**
 * U8: the in-band cleanup command run down a live SSH PTY when a session is
 * explicitly closed -- removes the two per-session sidecars CCC planted on the
 * remote (`settings-<sid>.json` + `mcp-<sid>.json`). The shared statusline shim
 * is reused across sessions so it is left in place; the shared settings /
 * .claude.json edits are removals (healing), not plants, so nothing else needs
 * sweeping. The session id is sanitized to the same safe form used for the
 * filenames, so it cannot smuggle shell metacharacters into the command.
 */
export function buildRemoteSessionCleanupCommand(sessionId: string): string {
  return `rm -f ${remoteSessionSettingsPath(sessionId)} ${remoteSessionMcpConfigPath(sessionId)}\n`
}

/**
 * SSH tmux enhancement (item 4): the remote command run over a SEPARATE ssh
 * exec (NOT down the live PTY -- see endSshRemote in pty-manager.ts) when the
 * user deliberately ENDS a persistent session. It kills the named tmux session
 * AND removes the per-session sidecars.
 *
 * The tmux session name is `ccc-<safeSid>` (mirrors buildTmuxLaunchCommand).
 * We do not know at end-time which tier staged tmux, so BOTH host-authored
 * locations are tried -- `command -v tmux` (tier 1) and the fixed
 * `"$HOME"/.claude/bin/tmux` (tiers 2/3/4) -- exactly the same two fixed
 * literals buildTmuxLaunchCommand embeds, with NO wire-reported path anywhere
 * (the #242 RCE-sink discipline). safeSid is the ONLY interpolated value and is
 * sanitized to `[A-Za-z0-9_-]`, so it cannot carry a shell metacharacter into
 * the `-t` argument. Each step is best-effort (`2>/dev/null`, trailing `true`)
 * so a missing binary / already-dead session still cleans the sidecars.
 */
export function buildRemoteTmuxKillCommand(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const target = `ccc-${safeSid}`
  // The kill runs over a SEPARATE, NON-LOGIN ssh exec (endSshRemote), whose PATH
  // is minimal — `command -v tmux` alone MISSES a Homebrew tmux on macOS
  // (/opt/homebrew/bin is added only by a login shell), which would orphan the
  // session (found on real Macs in testing). So try each known tmux location in
  // turn: PATH (`tmux`, for Linux where /usr/bin is in the minimal PATH), the
  // two Homebrew prefixes (arm64 + intel), the system path, and the CCC-staged
  // tier-2 binary. All are host-authored literals; `target` is the only
  // interpolated value and is safeSid-sanitized, so nothing an attacker controls
  // reaches the `-t` argument. Each attempt is silenced; a missing binary or
  // already-dead session is a no-op, and the trailing `true` keeps the exec 0.
  const tmuxBins = ['tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '"$HOME/.claude/bin/tmux"']
  const kills = tmuxBins.map((b) => `${b} kill-session -t ${target} 2>/dev/null`).join('; ')
  return [
    kills,
    `rm -f ${remoteSessionSettingsPath(sessionId)} ${remoteSessionMcpConfigPath(sessionId)} 2>/dev/null`,
    `true`,
  ].join('; ')
}

/**
 * Write the setup script to the remote, execute it, then clean up.
 * Uses a short write-and-run pattern to avoid PTY echo of the long script.
 */
/**
 * Build the shell command that runs the setup script on the remote host.
 *
 * Why base64? The setup script is a multi-line Node.js program that configures
 * the statusline shim and MCP vision in ~/.claude/settings.json. Sending it
 * directly through the PTY would be unreliable (quoting, line breaks, echo).
 * Instead we base64-encode it and pipe through `base64 -d | node`, all as ONE
 * typed line (joined with `;`, not real newlines -- shown broken out below
 * only for readability):
 *
 *   stty -echo
 *   echo '<base64>' | base64 -d | node   ← decode and execute
 *   stty echo
 *   cd <path> && clear  ← navigate to project and clean the screen
 *
 * #242 finding F7 correction: `stty -echo` does NOT make this line's OWN
 * echo invisible, and never did -- it's the first statement of the SAME
 * line, so the tty has already echoed the whole thing (base64 blob
 * included) back to the user before any of it executes (identical false
 * claim corrected on buildTmuxStageCommand's doc comment, ssh-tmux-stage.ts
 * -- the two builders share this exact shape). What actually keeps the
 * plaintext, sentinel-carrying setup SCRIPT invisible is that this line only
 * ever contains its opaque base64 encoding, never the script text itself.
 * `stty -echo` genuinely earns its keep for a keypress typed WHILE `node` is
 * running the decoded script; `stty echo` restores normal echo once it's
 * done.
 *
 * The script itself is generated by generateRemoteSetupScript() above.
 * All errors are suppressed (2>/dev/null) so a failed setup doesn't break
 * the SSH session — the user can still use Claude, just without statusline.
 */
/**
 * Allowed characters in a remote SSH path. The path is interpolated raw into
 * a shell `cd` command, so we restrict to a character set that has no shell
 * meaning: alphanumerics, "_", ".", "/", "-", "~". This deliberately rejects
 * spaces -- a path with a space would need quoting that breaks "~" expansion,
 * and the trade-off isn't worth the surface area on a per-host config field.
 * Users with spaces in their remote root can symlink.
 */
const SAFE_REMOTE_PATH_RE = /^[~A-Za-z0-9_./\-]+$/

export function assertSafeRemotePath(remotePath: string): void {
  if (!SAFE_REMOTE_PATH_RE.test(remotePath)) {
    throw new Error(
      `Refusing to build SSH setup command: remotePath contains characters that ` +
      `could be interpreted by the remote shell. Allowed: A-Z, a-z, 0-9, "_", ".", "/", "-", "~".`,
    )
  }
}

export function getRemoteSetupCommand(
  sessionId: string,
  remotePath: string,
  hooksConfig: { port: number; secret: string } | null,
  opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number } | undefined,
  nonce: string,
): string {
  assertSafeRemotePath(remotePath)
  const script = generateRemoteSetupScript(sessionId, hooksConfig, opts, nonce)
  const b64 = Buffer.from(script).toString('base64')
  // `cd --` so a path beginning with "-" is treated as an operand, not an option.
  return `stty -echo 2>/dev/null; echo '${b64}' | base64 -d | node 2>/dev/null; stty echo 2>/dev/null; cd -- ${remotePath} && clear`
}

/**
 * #242 finding F3 (MAJOR, adversarial review round 5). `generateRemoteSetupScript`
 * bakes CCC_TMUX_BIN into the per-session settings file from the TIER-1/2
 * probe result alone -- on a host where both tiers miss, that bake-in is the
 * empty string. Tiers 3/4 run STRICTLY AFTER that file is written (see
 * writeHostSetupCmd/writeContainerSetupCmd vs. writeTmuxStageCmd in
 * pty-manager.ts) and, on success, install a real binary and wrap the
 * claude launch in `tmux new-session -A` -- but nothing rewrote the settings
 * file the statusline shim's $TMUX branch reads $CCC_TMUX_BIN from. Net
 * effect pre-fix: the shim traces `no-ccc-tmux-bin`, falls through to
 * /dev/tty / the ancestor-pts walk, both of which land on the pane pty tmux
 * swallows -- the statusline silently stops updating for exactly the host
 * population tiers 3/4 exist to serve.
 *
 * Fix: after a stage/push `ok` sentinel resolves, pty-manager writes this
 * tiny follow-up remote command (base64-wrapped like every other setup
 * fragment on this ladder, so its own echo carries no meaningful plaintext)
 * BEFORE the claude launch write, patching the ALREADY-WRITTEN
 * settings-<safeSid>.json's `statusLine.command` in place.
 *
 * #242 finding F1(a), round-2 correction: this function no longer takes a
 * `tmuxBin` parameter at all. An earlier version received the stage/push
 * sentinel's reported path and interpolated it directly -- the same
 * remote-reported-path trust the F1(a) fix removed from
 * `buildTmuxLaunchCommand` (ssh-tmux.ts). Consistency mattered here too: a
 * spoofed `ok path=/tmp/.claude/bin/tmux` would otherwise have landed in
 * $CCC_TMUX_BIN even after the launch-command sink stopped trusting it,
 * silently reopening the same shape of hole one level down. The emitted
 * script instead computes `path.join(os.homedir(),'.claude','bin','tmux')`
 * itself, evaluated by the REMOTE `node` process at the same trust boundary
 * `buildTmuxStageScript`/`buildTmuxPushControlScript` install to -- so this
 * patch and the launch command it supports are pointed at the exact same
 * fixed location, with no wire-reported operand in between.
 *
 * #242 finding I4: `tmuxBin` is real remote output (`os.homedir()`), not
 * wire-controlled -- but generateRemoteSetupScript's OWN CCC_TMUX_BIN
 * bake-in (the `tmuxPath` guard a few lines up in that function) re-checks
 * the identical class of value against the SAME allowlist right before the
 * SAME sink (`statusLine.command`, `sh -c`'d by Claude Code on every
 * statusline refresh) -- this patch script skipped that guard, so a `$HOME`
 * containing a space (or any other shell-meaningful byte the unquoted
 * `CCC_TMUX_BIN=<value>` splice can't survive) would silently corrupt the
 * statusline command instead of degrading. Applying the SAME
 * `/^[A-Za-z0-9_./-]+$/` allowlist here, and skipping the whole patch
 * (leaving whatever CCC_TMUX_BIN generateRemoteSetupScript already baked
 * in -- empty on a tier-1/2 miss, which is exactly when this patch runs)
 * rather than writing a broken command, closes that gap the same way the
 * sibling already does.
 */
export function buildTmuxBinPatchCommand(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const script = [
    `const fs=require('fs'),path=require('path'),os=require('os')`,
    `const p=path.join(os.homedir(),'.claude','settings-${safeSid}.json')`,
    `let tmuxBin=path.join(os.homedir(),'.claude','bin','tmux')`,
    `if(!/^[A-Za-z0-9_./-]+$/.test(tmuxBin))tmuxBin=''`,
    `let s={};try{s=JSON.parse(fs.readFileSync(p,'utf-8'))}catch{}`,
    `if(tmuxBin&&s.statusLine&&typeof s.statusLine.command==='string'){` +
      `s.statusLine.command=s.statusLine.command.replace(/CCC_TMUX_BIN=\\S*/,'CCC_TMUX_BIN='+tmuxBin);` +
      `try{fs.writeFileSync(p,JSON.stringify(s,null,2))}catch{}` +
    `}`,
  ].join(';')
  const b64 = Buffer.from(script).toString('base64')
  return `echo '${b64}' | base64 -d | node 2>/dev/null`
}

// ===========================================================================
// SSH tmux enhancement (item 3): Windows remote support — PROTOTYPE.
//
// A Windows SSH remote has no tmux (so no persistence tier: the session is a
// bare `claude` that resumes via --continue on reconnect), and its login shell
// is cmd.exe, so the POSIX delivery (`stty; echo b64 | base64 -d | node`) and
// the POSIX statusline shim (/dev/tty, /proc pts-walk) do not apply. This
// block is the Windows equivalent, kept entirely separate from the POSIX path
// so it cannot regress Unix. It is selected only when SshConfig.remoteOs ===
// 'windows'. Validated on Hyper-V: the PowerShell-delivered node setup runs and
// emits `setup ok <nonce> tmux=none acct=<b64>`, and the shim's CONOUT$ branch
// (SSH_STATUSLINE_SHIM above) reaches the SSH client.
// ===========================================================================

/**
 * The Windows remote setup node program. Cross-platform node handles fs/path/
 * os fine on Windows; the differences from the POSIX generator are: NO tmux
 * detection (Windows has none — tmuxClass is fixed 'none'), the per-session
 * statusLine command is `node "<shim>" <sid>` (cmd.exe cannot env-prefix, so
 * the session id rides argv — the shim reads process.argv[2]), and directory
 * modes/chmod are dropped (NTFS ACLs, not POSIX 0700). The account descriptor
 * (item 10) is read the same way. Emits the SAME nonce'd sentinel shape the
 * POSIX path does, so pty-manager's existing parseTmuxSentinel latch handles
 * Windows completion with no special-casing.
 */
/**
 * item 3: a MINIMAL Windows statusline shim (CONOUT$ only). The full POSIX
 * shim (SSH_STATUSLINE_SHIM) is ~3KB of tmux/dev-tty/proc fallback logic that
 * is dead weight on Windows AND blows past cmd.exe's 8191-char command-line
 * limit once base64'd for delivery. This keeps only what Windows needs: read
 * the statusline JSON on stdin, build the SAME status object + CMSTATUS OSC
 * sentinel the parser (pty-manager.ts) expects, and write it to the console
 * device (built via String.fromCharCode to avoid backslash escaping), which
 * reaches the SSH client (verified on Hyper-V). Session id rides argv (cmd.exe
 * cannot env-prefix a statusLine command).
 */
const SSH_STATUSLINE_SHIM_WINDOWS = "const fs=require('fs'),os=require('os'),path=require('path');const logPath=path.join(os.homedir(),'.claude','conductor-shim.log');const trace=(m)=>{try{fs.appendFileSync(logPath,new Date().toISOString()+' '+String(m).replace(/[\\r\\n]+/g,' ')+String.fromCharCode(10));}catch(e){}};let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{try{const data=JSON.parse(input);const sid=process.argv[2]||process.env.CLAUDE_MULTI_SESSION_ID||(data&&data.session_id)||'unknown';const cw=data.context_window||{},u=cw.current_usage||{},cost=data.cost||{},m=data.model||{},rl=data.rate_limits||{};const it=(u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0);const s={sessionId:sid,model:m.display_name||m.id,contextUsedPercent:cw.used_percentage,contextRemainingPercent:cw.remaining_percentage,contextWindowSize:cw.context_window_size,inputTokens:it||undefined,outputTokens:u.output_tokens,costUsd:cost.total_cost_usd,totalDurationMs:cost.total_duration_ms,linesAdded:cost.total_lines_added,linesRemoved:cost.total_lines_removed,timestamp:Date.now()};const iso=(t)=>typeof t==='number'?new Date(t*1000).toISOString():(t||'');if(rl.five_hour){s.rateLimitCurrent=Math.round(Number(rl.five_hour.used_percentage)||0);s.rateLimitCurrentResets=iso(rl.five_hour.resets_at);}if(rl.seven_day){s.rateLimitWeekly=Math.round(Number(rl.seven_day.used_percentage)||0);s.rateLimitWeeklyResets=iso(rl.seven_day.resets_at);}const sentinel=String.fromCharCode(27)+']9999;CMSTATUS='+JSON.stringify(s)+String.fromCharCode(7);try{fs.writeFileSync(String.fromCharCode(92,92,46,92)+'CONOUT$',sentinel);trace('conout-ok sid='+sid);}catch(e){trace('conout-fail sid='+sid+' err='+(e&&e.code||e.message||'unknown'));try{process.stderr.write(sentinel);trace('stderr-fallback sid='+sid);}catch(e2){}}process.stdout.write(' ');}catch(e){trace('parse-fail err='+(e&&e.message||'unknown'));process.stdout.write(' ');}});"

export function generateWindowsRemoteSetupScript(
  sessionId: string,
  opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number } | undefined,
  nonce: string,
): string {
  if (!/^[A-Za-z0-9]+$/.test(nonce)) {
    throw new Error(`generateWindowsRemoteSetupScript: nonce "${nonce}" fails the charset guard (expected [A-Za-z0-9]+).`)
  }
  const { includeStatusLine = true, includeConductorMcp = true, remoteMcpPort } = opts ?? {}
  const mcpPort = getConductorMcpPort()
  const hasVision = mcpPort > 0 && includeConductorMcp
  const shimLiteral = JSON.stringify(SSH_STATUSLINE_SHIM_WINDOWS)
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const mcpConfigLiteral = hasVision
    ? JSON.stringify({
        mcpServers: {
          conductor: {
            type: 'sse',
            url: `http://localhost:${remoteMcpPort && remoteMcpPort > 0 ? remoteMcpPort : mcpPort}/sse?cccSessionId=${encodeURIComponent(sessionId)}&token=${mcpSessionToken(sessionId)}`,
          },
        },
      })
    : JSON.stringify({ mcpServers: {} })

  // statusLine.command: `node "<shimPath>" <safeSid>` — argv carries the sid,
  // which the shim (SSH_STATUSLINE_SHIM) reads via process.argv[2]. shimPath is
  // JSON.stringify'd at RUNTIME on the remote so its backslashes are escaped
  // correctly for the JSON settings file, exactly as the POSIX generator embeds
  // `+shimPath+`.
  const sesCfgParts: string[] = []
  if (includeStatusLine) {
    sesCfgParts.push(`statusLine:{type:'command',command:'node '+JSON.stringify(shimPath)+' ${safeSid}'}`)
  }

  const lines = [
    `const fs=require('fs'),path=require('path'),os=require('os')`,
    `const home=os.homedir(),claudeDir=path.join(home,'.claude')`,
    `try{fs.mkdirSync(claudeDir,{recursive:true})}catch{}`,
    `const shimPath=path.join(claudeDir,'conductor-ssh-statusline.js')`,
    `try{fs.rmSync(shimPath,{force:true})}catch{}try{fs.writeFileSync(shimPath,${shimLiteral},{flag:'wx'})}catch{}`,
    `const sp=path.join(claudeDir,'settings.json')`,
    `let s={};try{s=JSON.parse(fs.readFileSync(sp,'utf-8'))}catch{}`,
    `const sBase=Object.assign({},s);delete sBase.mcpServers`,
    `if(sBase.statusLine&&typeof sBase.statusLine.command==='string'&&sBase.statusLine.command.includes('conductor-ssh-statusline'))delete sBase.statusLine`,
    `const sesPath=path.join(claudeDir,'settings-${safeSid}.json')`,
    `const sesCfg=Object.assign({},sBase,{${sesCfgParts.join(',')}})`,
    `try{fs.rmSync(sesPath,{force:true})}catch{}try{fs.writeFileSync(sesPath,JSON.stringify(sesCfg,null,2),{flag:'wx'})}catch{}`,
    `const mcpPath=path.join(claudeDir,'mcp-${safeSid}.json')`,
    `try{fs.rmSync(mcpPath,{force:true})}catch{}try{fs.writeFileSync(mcpPath,${JSON.stringify(mcpConfigLiteral)},{flag:'wx'})}catch{}`,
    `if(s.statusLine&&typeof s.statusLine.command==='string'&&s.statusLine.command.includes('conductor-ssh-statusline'))delete s.statusLine`,
    `if(s.mcpServers){if(s.mcpServers['conductor-vision'])delete s.mcpServers['conductor-vision'];if(s.mcpServers['conductor'])delete s.mcpServers['conductor']}`,
    `try{fs.writeFileSync(sp,JSON.stringify(s,null,2))}catch{}`,
    // item 10: read the remote account descriptor (base64) — same field as POSIX.
    `let acctB64='';try{const cj=path.join(home,'.claude.json');if(fs.existsSync(cj)){const c=JSON.parse(fs.readFileSync(cj,'utf-8'));if(c&&c.oauthAccount&&typeof c.oauthAccount.emailAddress==='string')acctB64=Buffer.from(c.oauthAccount.emailAddress,'utf-8').toString('base64')}}catch{}`,
    // tmux is fixed 'none' on Windows — the ladder never runs, launch is bare.
    `process.stdout.write('setup ok ${nonce} tmux=none acct='+acctB64+'\\n')`,
  ]
  return lines.join(';')
}

/**
 * Wrap generateWindowsRemoteSetupScript in a single line that runs it via
 * PowerShell (cmd.exe has no base64/stty). The node program is UTF-8 base64'd
 * and a small PowerShell command decodes it and pipes it to `node`.
 *
 * The `-Command` payload MUST contain NO `$`. The remote's sshd DefaultShell is
 * commonly PowerShell (not cmd.exe), and a PowerShell parent expands any `$var`
 * inside the double-quoted argument BEFORE the child powershell runs -- so the
 * earlier `$ProgressPreference=…;$s=…;$s|node` form had `$s` expanded to empty
 * by the parent, yielding `…;|node` -> "An empty pipe element is not allowed"
 * and setup silently never ran (adversarial review, 2026-08-18, live-confirmed).
 * The `$`-free `<decode-expr>|node` form parses identically under cmd.exe AND a
 * PowerShell login shell. `-NonInteractive -NoProfile` already suppress the
 * CLIXML "Preparing modules" noise the dropped `$ProgressPreference` guarded, and
 * a plain decode|node pipeline imports no module, so nothing but the sentinel
 * line comes back. NOT `-EncodedCommand`: that re-encodes as UTF-16LE base64,
 * ~2.6x larger, blowing past cmd.exe's 8191-char limit.
 */
export function getWindowsRemoteSetupCommand(
  sessionId: string,
  opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number } | undefined,
  nonce: string,
): string {
  const script = generateWindowsRemoteSetupScript(sessionId, opts, nonce)
  // Single base64 of the node program (its alphabet is [A-Za-z0-9+/=], so it
  // carries no cmd.exe / PowerShell metacharacter and needs no quoting).
  const nodeB64 = Buffer.from(script, 'utf-8').toString('base64')
  return `powershell -NoProfile -NonInteractive -Command "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${nodeB64}'))|node"`
}

/**
 * The Windows claude launch line (cmd.exe). Env vars use `set "X=Y"&&` (cmd
 * syntax, not the POSIX `X=Y claude` prefix), settings/mcp paths use
 * `%USERPROFILE%\.claude\...` (cmd expands %USERPROFILE%; `~` does not expand
 * in cmd), and `claude` resolves to claude.cmd on PATH. No tmux wrap (Windows
 * has none). `extraFlags` is the SAME claude flag string the POSIX path builds
 * MINUS --settings/--mcp-config (re-added here with Windows paths);
 * `continueFlag` is '--continue' on a reconnect or ''.
 */
export function buildWindowsClaudeCommand(input: {
  sessionId: string
  envPrefixVars: string[]
  extraFlags: string
  continueFlag: string
}): string {
  const safeSid = input.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const settings = `"%USERPROFILE%\\.claude\\settings-${safeSid}.json"`
  const mcp = `"%USERPROFILE%\\.claude\\mcp-${safeSid}.json"`
  const sets = input.envPrefixVars.map((kv) => `set "${kv}"&& `).join('')
  const flags = [`--settings ${settings}`, `--mcp-config ${mcp}`, input.extraFlags, input.continueFlag]
    .filter((f) => f && f.trim())
    .join(' ')
  return `${sets}claude ${flags}`
}
