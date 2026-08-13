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
//   1. /dev/tty — the controlling terminal. Correct when it exists, but Claude
//      runs the statusLine command as a DETACHED child (via `sh -c`), so that
//      child has NO controlling terminal and this fails with ENXIO over SSH.
//   2. Ancestor pts — walk the process tree for the /dev/pts/N slave that an
//      ancestor (claude itself) holds on one of its fds, and write the sentinel
//      to that device. Writing the pts slave sends bytes toward the master →
//      sshd → local, i.e. it reaches the ssh PTY and the local OSC parser. This
//      is the path that actually works over SSH. Linux-only (needs /proc).
//   3. stderr — last resort. NOTE: over SSH, Claude captures the child's stderr
//      on a pipe, so this typically does NOT reach the local PTY (that is why
//      the pre-fix shim, which relied on it, never showed a statusline). Kept
//      only for environments where the child's stderr is inherited.
//   4. Append a trace line to ~/.claude/conductor-shim.log on every path
//      (tty-fail / pts-ok / pts-fail / pts-none / stderr-fallback) so "no
//      statusline ever appeared" stays diagnosable without guesswork. The log
//      is capped via append-and-forget; grows slowly.
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
const sid=process.env.CLAUDE_MULTI_SESSION_ID||'unknown';
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
let ok=false;
try{fs.writeFileSync('/dev/tty',sentinel);ok=true;}catch(e){trace('tty-fail sid='+sid+' err='+(e&&e.code||e.message||'unknown'));}
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
  opts?: { includeStatusLine?: boolean; includeConductorMcp?: boolean },
): string {
  const { includeStatusLine = true, includeConductorMcp = true } = opts ?? {}
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
            url: `http://localhost:${mcpPort}/sse?cccSessionId=${encodeURIComponent(sessionId)}&token=${mcpSessionToken(sessionId)}`,
          },
        },
      })
    : JSON.stringify({ mcpServers: {} })
  // Master status-line switch: with it off, the per-session clone simply gets
  // no statusLine key (the shim file is still staged but inert without it).
  const sesCfgParts: string[] = []
  if (includeStatusLine) {
    sesCfgParts.push(`statusLine:{type:'command',command:'CLAUDE_MULTI_SESSION_ID=${sessionId} node '+shimPath}`)
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
    `try{fs.writeFileSync(shimPath,${shimLiteral},{mode:0o755})}catch{}`,
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
    `try{const cj=path.join(home,'.claude.json');if(fs.existsSync(cj)){let c=JSON.parse(fs.readFileSync(cj,'utf-8'));let mut=false;if(c.mcpServers){if(c.mcpServers['conductor-vision']){delete c.mcpServers['conductor-vision'];mut=true}if(c.mcpServers['conductor']){delete c.mcpServers['conductor'];mut=true}}if(mut)fs.writeFileSync(cj,JSON.stringify(c,null,2))}}catch{}`,
    `try{const md=path.join(claudeDir,'CLAUDE.md');let c=fs.readFileSync(md,'utf-8');const rx=/\\n?\\n?<!-- VISION-INSTRUCTIONS-START -->[\\s\\S]*?<!-- VISION-INSTRUCTIONS-END -->\\n?/g;if(rx.test(c)){c=c.replace(rx,'').trim();fs.writeFileSync(md,c?c+'\\n':'')}}catch{}`,
    `process.stdout.write('setup ok\\n')`,
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
 * Write the setup script to the remote, execute it, then clean up.
 * Uses a short write-and-run pattern to avoid PTY echo of the long script.
 */
/**
 * Build the shell command that runs the setup script on the remote host.
 *
 * Why base64? The setup script is a multi-line Node.js program that configures
 * the statusline shim and MCP vision in ~/.claude/settings.json. Sending it
 * directly through the PTY would be unreliable (quoting, line breaks, echo).
 * Instead we base64-encode it and pipe through `base64 -d | node`:
 *
 *   stty -echo          ← suppress terminal echo so the blob isn't visible
 *   echo '<base64>' | base64 -d | node   ← decode and execute
 *   stty echo           ← restore echo
 *   cd <path> && clear  ← navigate to project and clean the screen
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
  opts?: { includeStatusLine?: boolean; includeConductorMcp?: boolean },
): string {
  assertSafeRemotePath(remotePath)
  const script = generateRemoteSetupScript(sessionId, hooksConfig, opts)
  const b64 = Buffer.from(script).toString('base64')
  // `cd --` so a path beginning with "-" is treated as an operand, not an option.
  return `stty -echo 2>/dev/null; echo '${b64}' | base64 -d | node 2>/dev/null; stty echo 2>/dev/null; cd -- ${remotePath} && clear`
}
