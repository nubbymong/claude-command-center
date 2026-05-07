import { getConductorMcpPort } from '../../vision-manager'
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
// Fallback order for the OSC sentinel:
//   1. /dev/tty — correct path. Bypasses Claude entirely; flows through the
//      ssh PTY back to pty-manager.
//   2. stderr — Claude captures stdout as the statusline text, so stdout is
//      a dead-end (the sentinel gets displayed or stripped). stderr is NOT
//      captured by Claude Code's statusline handler and, in a PTY context,
//      travels back through the ssh PTY just like stdout would.
//   3. Append a trace line to ~/.claude/conductor-shim.log on any failure
//      path so we can diagnose "no statusline ever appeared" issues without
//      guesswork. The log is capped via append-and-forget; grows slowly.
const SSH_STATUSLINE_SHIM = `#!/usr/bin/env node
const fs=require('fs'),os=require('os'),path=require('path');
const logPath=path.join(os.homedir(),'.claude','conductor-shim.log');
const trace=(m)=>{try{fs.appendFileSync(logPath,new Date().toISOString()+' '+m+'\\n');}catch{}};
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
const now=new Date();const yr=now.getUTCFullYear();const m2=new Date(Date.UTC(yr,2,8));m2.setUTCDate(8+(7-m2.getUTCDay())%7);const n1=new Date(Date.UTC(yr,10,1));n1.setUTCDate(1+(7-n1.getUTCDay())%7);const ptOff=(now>=m2&&now<n1)?-7:-8;const ptH=(now.getUTCHours()+ptOff+24)%24;const ptD=new Date(now.getTime()+ptOff*3600000).getUTCDay();s.isPeak=(ptD>=1&&ptD<=5&&ptH>=5&&ptH<11);
const sentinel='\\x1b]9999;CMSTATUS='+JSON.stringify(s)+'\\x07';
let tty_ok=false;
try{fs.writeFileSync('/dev/tty',sentinel);tty_ok=true;}catch(e){trace('tty-fail sid='+sid+' err='+(e&&e.code||e.message||'unknown'));}
if(!tty_ok){try{process.stderr.write(sentinel);trace('stderr-fallback sid='+sid);}catch(e2){trace('stderr-fail sid='+sid+' err='+(e2&&e2.message||'unknown'));}}
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
): string {
  // Conductor MCP server is always running (independent of browser/vision config),
  // so SSH sessions always get the conductor-vision MCP entry pointing at the
  // reverse-tunneled MCP port. The fetch_host_screenshot tool is always available;
  // browser tools fall back to "vision not connected" if no browser is attached.
  const mcpPort = getConductorMcpPort() || 19333
  const hasVision = mcpPort > 0
  // Embed the shim as a JSON string literal — Node parses it back to source
  const shimLiteral = JSON.stringify(SSH_STATUSLINE_SHIM)
  // Sanitise for path use — sessionId comes from session.id (generateId), but
  // belt-and-braces because it's embedded in a filename we write.
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')

  // Per-session settings file (~/.claude/settings-<sid>.json) passed via
  // `claude --settings`. Previously we rewrote the shared ~/.claude/settings.json
  // and baked CLAUDE_MULTI_SESSION_ID into its statusLine command — but multiple
  // concurrent sessions to the same host would clobber each other, so Claude
  // Code caching the latest write meant statusline updates landed under the
  // wrong local sessionId after the second session connected. Per-session
  // files let each Claude keep its own sid in its own settings view.
  //
  // We also still touch shared settings.json for the MCP server entry (vision),
  // and we clean up the legacy statusLine stanza so old installs don't keep
  // overriding via the shared file.
  //
  // Hooks: when the HTTP Hooks Gateway is running, the per-session file also
  // carries a `hooks` block pointing at `http://localhost:<hooksPort>/hook/<sid>`
  // — the SSH connection's `-R <hooksPort>:localhost:<hooksPort>` tunnel makes
  // that loopback URL resolve to the host's gateway.
  const hooksLiteral = hooksConfig
    ? JSON.stringify(buildHooksBlock(sessionId, hooksConfig.port, hooksConfig.secret))
    : null
  // MCP vision: prior builds relied on Claude Code's `--settings` MERGING
  // the per-session file onto the user settings (which held mcpServers in
  // the shared settings.json write below). That assumption is undocumented.
  // Include the conductor-vision entry in the per-session file too, so even
  // if a future Claude Code build flips `--settings` to REPLACE semantics,
  // SSH sessions keep seeing the reverse-tunnelled MCP server.
  const mcpServersLiteral = hasVision
    ? JSON.stringify({ 'conductor-vision': { url: `http://localhost:${mcpPort}/sse` } })
    : null
  const sesCfgParts: string[] = [
    `statusLine:{type:'command',command:'CLAUDE_MULTI_SESSION_ID=${sessionId} node '+shimPath}`,
  ]
  if (mcpServersLiteral) sesCfgParts.push(`mcpServers:${mcpServersLiteral}`)
  if (hooksLiteral) sesCfgParts.push(`hooks:${hooksLiteral}`)

  // Build as semicolon-separated statements — NO comments (they break single-lining)
  const lines = [
    `const fs=require('fs'),path=require('path'),os=require('os')`,
    `const home=os.homedir(),claudeDir=path.join(home,'.claude')`,
    `try{fs.mkdirSync(claudeDir,{recursive:true})}catch{}`,
    `const shimPath=path.join(claudeDir,'conductor-ssh-statusline.js')`,
    `try{fs.writeFileSync(shimPath,${shimLiteral},{mode:0o755})}catch{}`,
    // Read the user's shared settings FIRST so the per-session file can
    // inherit every top-level key (outputStyle, permissions, future
    // additions). The three CCC-owned keys (statusLine, mcpServers, hooks)
    // then override whatever the shared file had. This makes the local
    // and SSH behaviour identical under `--settings` regardless of
    // whether Claude Code treats that flag as MERGE or REPLACE.
    `const sp=path.join(claudeDir,'settings.json')`,
    `let s={};try{s=JSON.parse(fs.readFileSync(sp,'utf-8'))}catch{}`,
    // Per-session settings — clone of shared with CCC keys overridden.
    `const sesPath=path.join(claudeDir,'settings-${safeSid}.json')`,
    `const sesCfg=Object.assign({},s,{${sesCfgParts.join(',')}})`,
    `try{fs.writeFileSync(sesPath,JSON.stringify(sesCfg,null,2))}catch{}`,
    // Shared settings — owns MCP vision only. Strip any legacy statusLine
    // stanza a prior install wrote; it would override the per-session file.
    `if(s.statusLine&&typeof s.statusLine.command==='string'&&s.statusLine.command.includes('conductor-ssh-statusline'))delete s.statusLine`,
    hasVision
      ? `if(!s.mcpServers)s.mcpServers={};s.mcpServers['conductor-vision']={url:'http://localhost:${mcpPort}/sse'}`
      : `if(s.mcpServers&&s.mcpServers['conductor-vision'])delete s.mcpServers['conductor-vision']`,
    `try{fs.writeFileSync(sp,JSON.stringify(s,null,2))}catch{}`,
    `try{const cj=path.join(home,'.claude.json');if(fs.existsSync(cj)){let c=JSON.parse(fs.readFileSync(cj,'utf-8'));if(c.mcpServers&&c.mcpServers['conductor-vision']){delete c.mcpServers['conductor-vision'];fs.writeFileSync(cj,JSON.stringify(c,null,2))}}}catch{}`,
    `try{const md=path.join(claudeDir,'CLAUDE.md');let c=fs.readFileSync(md,'utf-8');const rx=/\\n?\\n?<!-- VISION-INSTRUCTIONS-START -->[\\s\\S]*?<!-- VISION-INSTRUCTIONS-END -->\\n?/g;if(rx.test(c)){c=c.replace(rx,'').trim();c?fs.writeFileSync(md,c+'\\n'):fs.unlinkSync(md)}}catch{}`,
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
export function getRemoteSetupCommand(
  sessionId: string,
  remotePath: string,
  hooksConfig: { port: number; secret: string } | null,
): string {
  const script = generateRemoteSetupScript(sessionId, hooksConfig)
  const b64 = Buffer.from(script).toString('base64')
  return `stty -echo 2>/dev/null; echo '${b64}' | base64 -d | node 2>/dev/null; stty echo 2>/dev/null; cd ${remotePath} && clear`
}
