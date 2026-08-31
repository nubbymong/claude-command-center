/**
 * Shared statusline data-gathering (harmonise-remote slice: local unification).
 *
 * ONE source embedded by all three statusline bridges — the POSIX remote shim,
 * the Windows remote shim (both in ssh-shim.ts) and the LOCAL bridge script
 * (statusline.ts) — so the account/usage logic cannot drift between them:
 * read the signed-in account from ~/.claude.json (5 MB cap), then fetch the
 * account's usage from the Anthropic OAuth usage endpoint with the machine's
 * own token (60 s on-disk cache per account, 5 s timeout, fail-to-null — the
 * statusline must never block claude).
 *
 * The 60 s cache lives in `~/.claude/` (owner-only), NOT `os.tmpdir()`
 * (ADR-009 hardening). On a POSIX remote `os.tmpdir()` is `/tmp` — mode 1777,
 * shared with every other account on the box and with every co-tenant process in
 * the same container — and the filename was predictable from the account email,
 * so a neighbour could pre-create or symlink the path and feed chosen JSON into
 * a payload the app renders. `~/.claude` is the directory the setup script
 * already re-asserts to 0700 on every connect; the file itself is written 0600
 * with an exclusive create (unlink-then-`wx`, the same custody the token
 * sidecars use), and the read refuses anything that is not a regular file owned
 * by this uid. Cache semantics are unchanged: same key, same 60 s window, same
 * silent fall-through to a live fetch on any miss. applyUsage fills what claude's stdin
 * JSON does not carry: the per-model weekly buckets (Fable), extra_usage, and
 * 5h/weekly when stdin lacked them (stdin wins where both exist). Bucket
 * labelling mirrors src/main/usage/usage-buckets.ts (kept in sync by hand;
 * this snippet can't import).
 *
 * Contract with the embedding script: plain ES5-ish JS, no template
 * interpolation; expects `fs`, `os`, `path` consts in the prologue and a
 * status object named `s` already built from stdin. Declares `fetchUsage(cb)`
 * and `applyUsage(lim)` for the embedder to call.
 */
/**
 * Shared status-URL resolution (ADR-009 token custody hardening).
 *
 * The tier-0 delivery URL carries this session's MCP token in its query string,
 * and the token opens every MCP route — /sse and `vision_eval` included. It used
 * to travel to the bridge in argv (local + Windows remote) or as a shell
 * env-prefix (POSIX remote), which put the secret in the machine's process table
 * for the life of the session: readable by any other local user through
 * `ps auxww` / `/proc/<pid>/cmdline`, and by any co-tenant process inside the
 * same container. Every other token-bearing artefact this app writes is confined
 * to a 0600 file; this was the one that was not.
 *
 * The URL now lives in `~/.claude/ccc-status-<sid>.url` (0600, exclusive
 * create), and only its PATH — not a secret — travels in argv or the env.
 *
 * Resolution order, deliberately back-compatible so a settings file written by
 * an older build keeps working until it is rewritten on the next connect:
 *   1. argv[3] — a URL if it starts with `http`, otherwise a path to read.
 *   2. $CCC_STATUS_URL — the legacy env form.
 *   3. $CCC_STATUS_URL_FILE — a path to read (the POSIX remote env-prefix form).
 * Anything unreadable, empty, or failing the URL charset guard yields '', which
 * drops the bridge onto its own legacy delivery (the OSC ladder remotely, the
 * watched status file locally) exactly as a torn tunnel already does.
 *
 * The charset guard is the SAME one statusPostUrl asserts before writing the
 * file (ssh-shim.ts), re-applied at the read: the file is 0600 in a 0700 dir, so
 * this is defence in depth, not the primary control.
 *
 * Contract with the embedding script: expects `fs` in the prologue; declares
 * `statusUrl`.
 */
export const SHIM_STATUS_URL_JS = `
var readStatusUrlFile=function(p){try{if(!p)return '';var v=fs.readFileSync(p,'utf-8').trim();return /^[A-Za-z0-9:/?=&._%-]+$/.test(v)?v:'';}catch(eV){return '';}};
var statusArg=process.argv[3]||'';
var statusUrl=(statusArg.slice(0,4)==='http'?statusArg:readStatusUrlFile(statusArg))||process.env.CCC_STATUS_URL||readStatusUrlFile(process.env.CCC_STATUS_URL_FILE||'');
`

export const SHIM_GATHER_JS = `
try{var cj=path.join(os.homedir(),'.claude.json');var stA=fs.statSync(cj);if(stA.size<5*1024*1024){var jA=JSON.parse(fs.readFileSync(cj,'utf-8'));if(jA&&jA.oauthAccount&&typeof jA.oauthAccount.emailAddress==='string')s.accountEmail=jA.oauthAccount.emailAddress;}}catch(eA){}
var fetchUsage=function(cb){
var doneU=false;var finU=function(lim){if(doneU)return;doneU=true;cb(lim);};
try{
var credsPath=path.join(os.homedir(),'.claude','.credentials.json');
if(!fs.existsSync(credsPath))return finU(null);
var tokenU=null;try{var creds=JSON.parse(fs.readFileSync(credsPath,'utf-8'));tokenU=creds.claudeAiOauth&&creds.claudeAiOauth.accessToken;}catch(eB){}
if(!tokenU)return finU(null);
var cacheKey=String(s.accountEmail||'default').toLowerCase().replace(/[^a-z0-9]/g,'_');
var cacheDir=path.join(os.homedir(),'.claude');
try{fs.mkdirSync(cacheDir,{recursive:true,mode:0o700})}catch(eC0){}
var cacheFile=path.join(cacheDir,'ccc-usage-cache-'+cacheKey+'.json');
try{var cst=fs.lstatSync(cacheFile);var mineU=typeof process.getuid!=='function'||cst.uid===process.getuid();if(cst.isFile()&&mineU&&(Date.now()-cst.mtimeMs)/1000<60)return finU(JSON.parse(fs.readFileSync(cacheFile,'utf-8')));}catch(eC){}
var rqU=require('https').request({hostname:'api.anthropic.com',path:'/api/oauth/usage',method:'GET',headers:{Accept:'application/json',Authorization:'Bearer '+tokenU,'anthropic-beta':'oauth-2025-04-20','User-Agent':'claude-code/2.1.34'},timeout:5000},function(resU){var bU='';resU.on('data',function(cU){bU+=cU;});resU.on('end',function(){try{var jU=JSON.parse(bU);try{fs.rmSync(cacheFile,{force:true});fs.writeFileSync(cacheFile,bU,{mode:0o600,flag:'wx'})}catch(eD){}finU(jU);}catch(eE){finU(null);}});});
rqU.on('timeout',function(){try{rqU.destroy()}catch(eF){}finU(null);});
rqU.on('error',function(){finU(null);});
rqU.end();
}catch(eG){finU(null);}
};
var applyUsage=function(lim){
if(!lim)return;
try{
if(lim.five_hour&&s.rateLimitCurrent===undefined){s.rateLimitCurrent=Math.round(Number(lim.five_hour.utilization)||0);s.rateLimitCurrentResets=lim.five_hour.resets_at||'';}
if(lim.seven_day&&s.rateLimitWeekly===undefined){s.rateLimitWeekly=Math.round(Number(lim.seven_day.utilization)||0);s.rateLimitWeeklyResets=lim.seven_day.resets_at||'';}
if(lim.extra_usage&&lim.extra_usage.is_enabled){s.rateLimitExtra={enabled:true,utilization:Math.round(Number(lim.extra_usage.utilization)||0),usedUsd:Math.round(Number(lim.extra_usage.used_credits||0))/100,limitUsd:Math.round(Number(lim.extra_usage.monthly_limit||0))/100};}
if(Object.prototype.toString.call(lim.limits)==='[object Array]'){var bks=[];for(var iU=0;iU<lim.limits.length;iU++){var itU=lim.limits[iU];if(!itU||typeof itU!=='object')continue;var grp=typeof itU.group==='string'?itU.group:'';if(grp!=='session'&&grp!=='weekly')continue;var pct=typeof itU.percent==='number'?itU.percent:null;if(pct===null)continue;var lbl='Weekly';if(grp==='session')lbl='5h';else if(itU.scope&&itU.scope.model&&typeof itU.scope.model.display_name==='string'&&itU.scope.model.display_name.trim())lbl=itU.scope.model.display_name;bks.push({key:(typeof itU.kind==='string'?itU.kind:grp)+':'+(lbl==='5h'||lbl==='Weekly'?'':lbl),label:lbl,group:grp,percent:Math.round(pct),resetsAt:itU.resets_at||'',severity:typeof itU.severity==='string'?itU.severity:'normal'});}if(bks.length)s.usageBuckets=bks;}
}catch(eH){}
};
`
