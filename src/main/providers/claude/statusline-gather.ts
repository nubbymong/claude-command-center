/**
 * Shared statusline data-gathering (harmonise-remote slice: local unification).
 *
 * ONE source embedded by all three statusline bridges — the POSIX remote shim,
 * the Windows remote shim (both in ssh-shim.ts) and the LOCAL bridge script
 * (statusline.ts) — so the account/usage logic cannot drift between them:
 * read the signed-in account from ~/.claude.json (5 MB cap), then fetch the
 * account's usage from the Anthropic OAuth usage endpoint with the machine's
 * own token (60 s on-disk cache per account, 5 s timeout, fail-to-null — the
 * statusline must never block claude). applyUsage fills what claude's stdin
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
var cacheFile=path.join(os.tmpdir(),'ccc-usage-cache-'+cacheKey+'.json');
try{var cst=fs.statSync(cacheFile);if((Date.now()-cst.mtimeMs)/1000<60)return finU(JSON.parse(fs.readFileSync(cacheFile,'utf-8')));}catch(eC){}
var rqU=require('https').request({hostname:'api.anthropic.com',path:'/api/oauth/usage',method:'GET',headers:{Accept:'application/json',Authorization:'Bearer '+tokenU,'anthropic-beta':'oauth-2025-04-20','User-Agent':'claude-code/2.1.34'},timeout:5000},function(resU){var bU='';resU.on('data',function(cU){bU+=cU;});resU.on('end',function(){try{var jU=JSON.parse(bU);try{fs.writeFileSync(cacheFile,bU)}catch(eD){}finU(jU);}catch(eE){finU(null);}});});
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
