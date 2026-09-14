/**
 * Claude statusline deployment (lifted from statusline-watcher.ts in P0.7)
 *
 * - Stages the Node.js statusline bridge script at
 *   <resourcesDir>/scripts/claude-multi-statusline.js.
 * - Delivery is PER-SESSION only (U2): the statusLine stanza is injected into
 *   the per-session settings clone (per-session-settings.ts), never the global
 *   ~/.claude/settings.json. healGlobalStatusline below strips the legacy
 *   global stanza + planted ~/.claude script that pre-U2 installs wrote.
 * - Bundled script POSTs its payload to the conductor MCP server's /status
 *   endpoint (same channel as the SSH remote shims; per-session status file
 *   is the fallback) and fetches rate limits via the SHARED gather snippet
 *   (statusline-gather.ts) at runtime.
 *
 * All behaviour here is Claude-specific: settings.json layout, OAuth token path,
 * statusLine command stanza. Codex has no equivalent statusline shim.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { SHIM_GATHER_JS, SHIM_STATUS_URL_JS } from './statusline-gather'

/**
 * Deploy the statusline script that Claude Code will invoke.
 * The script reads JSON from stdin and writes to a per-session status file.
 *
 * @param resourcesDir Resources directory used for the SSH-mounted copy and
 *   the per-session status files. The bundled script derives its own status
 *   dir from `path.dirname(process.argv[1])/../status` so it works on any
 *   mount path (local resources dir, SSH remote mount, etc.).
 */
export async function deployClaudeStatuslineScript(resourcesDir: string): Promise<void> {
  const statusDir = path.join(resourcesDir, 'status')
  // Ensure directories exist
  if (!fs.existsSync(statusDir)) {
    fs.mkdirSync(statusDir, { recursive: true })
  }

  const claudeDir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true })
  }

  // Write the Node.js statusline script.
  //
  // Harmonised with the two REMOTE shims (ssh-shim.ts) in the local-unification
  // slice: the status object is built the same way (stdin rate_limits first),
  // the account/usage gather is the SHARED snippet (statusline-gather.ts), and
  // delivery is POST-FIRST to the conductor MCP server's /status endpoint
  // (argv[2] = session id, argv[3] = URL — the same argv convention as both
  // remote shims; env fallbacks CLAUDE_MULTI_SESSION_ID / CCC_STATUS_URL).
  // The per-session status FILE is now the fallback, kept for sessions whose
  // settings predate the URL bake-in and for an MCP server that failed to bind.
  const scriptContent = `#!/usr/bin/env node
// AI Code Conductor - Statusline bridge script
// Reads JSON from stdin (sent by Claude Code), enriches it with account +
// usage (shared gather), then POSTs it to the Conductor's /status endpoint;
// falls back to writing the per-session status file the app's watcher tails.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Derive status dir from script location: scripts/xxx.js → ../status/
// Works on any mount path (local resources dir, SSH remote mount, etc.)
const statusDir = path.join(path.dirname(process.argv[1]), '..', 'status');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sid = process.argv[2] || process.env.CLAUDE_MULTI_SESSION_ID || (data && data.session_id) || 'unknown';
    const cw = data.context_window || {};
    const u = cw.current_usage || {};
    const it = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const cost = data.cost || {};
    const m = data.model || {};
    const rl = data.rate_limits || {};
    const s = {
      sessionId: sid,
      model: m.display_name || m.id,
      modelId: m.id,
      effortLevel: data.effort && data.effort.level,
      fastMode: data.fast_mode,
      contextUsedPercent: cw.used_percentage,
      contextRemainingPercent: cw.remaining_percentage,
      contextWindowSize: cw.context_window_size,
      inputTokens: it || undefined,
      outputTokens: u.output_tokens,
      costUsd: cost.total_cost_usd,
      totalDurationMs: cost.total_duration_ms,
      linesAdded: cost.total_lines_added,
      linesRemoved: cost.total_lines_removed,
      // Logs v2 (Task 8): forward Claude Code's transcript_path so the watcher
      // fan-out can bind it (continuous, exact discovery source).
      transcriptPath: typeof data.transcript_path === 'string' ? data.transcript_path : undefined,
      timestamp: Date.now()
    };
    // stdin rate_limits win; the gather's applyUsage below only fills gaps
    // (extra_usage + per-model weekly buckets never ride stdin).
    const iso = (t) => typeof t === 'number' ? new Date(t * 1000).toISOString() : (t || '');
    if (rl.five_hour) { s.rateLimitCurrent = Math.round(Number(rl.five_hour.used_percentage) || 0); s.rateLimitCurrentResets = iso(rl.five_hour.resets_at); }
    if (rl.seven_day) { s.rateLimitWeekly = Math.round(Number(rl.seven_day.used_percentage) || 0); s.rateLimitWeeklyResets = iso(rl.seven_day.resets_at); }
    ${SHIM_GATHER_JS}
    // Fallback delivery: write the per-session status file for the app's
    // directory watcher. Suppress statusline display in the terminal either
    // way — the Conductor's own ContextBar shows all this data; a single
    // space keeps Claude's statusline area minimal.
    const deliverLegacy = function () {
      try {
        if (!fs.existsSync(statusDir)) {
          fs.mkdirSync(statusDir, { recursive: true });
        }
        fs.writeFileSync(path.join(statusDir, sid + '.json'), JSON.stringify(s));
      } catch (e1) {}
      process.stdout.write(' ');
    };
    ${SHIM_STATUS_URL_JS}
    const deliver = function () {
      if (statusUrl) {
        let done = false;
        const fin = function (good) { if (done) return; done = true; if (good) { process.stdout.write(' '); } else { deliverLegacy(); } };
        try {
          const body = JSON.stringify(s);
          const u2 = new URL(statusUrl);
          const rq = require('http').request({ hostname: u2.hostname, port: u2.port, path: u2.pathname + u2.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 3000 }, function (res) { res.resume(); fin(!!res.statusCode && res.statusCode < 300); });
          rq.on('timeout', function () { try { rq.destroy(); } catch (e2) {} fin(false); });
          rq.on('error', function () { fin(false); });
          rq.end(body);
        } catch (e3) { fin(false); }
      } else {
        deliverLegacy();
      }
    };
    fetchUsage(function (lim) { applyUsage(lim); deliver(); });
  } catch (e) {
    // Silently fail - don't break Claude's output
    process.stdout.write(' ');
  }
});
`

  // The statusline is delivered PER-SESSION (writeLocalSessionSettings) pointing
  // at the resources-dir copy below -- we no longer plant a script in ~/.claude
  // or write the global settings stanza. Boot-heal removes any legacy ones.

  // Deploy to resources/scripts/ for the per-session command + SSH-mounted access
  try {
    const resourcesScriptsDir = path.join(resourcesDir, 'scripts')
    if (!fs.existsSync(resourcesScriptsDir)) {
      fs.mkdirSync(resourcesScriptsDir, { recursive: true })
    }
    fs.writeFileSync(
      path.join(resourcesScriptsDir, 'claude-multi-statusline.js'),
      scriptContent,
      { mode: 0o755 }
    )

    // Resume-picker deploy is factored out into deployClaudeResumePickerScript
    // and called from index.ts boot chain alongside deployStatuslineScript.

    // Clean up legacy vision scripts (replaced by MCP server)
    for (const legacy of ['vision-cli.js', 'vision-prompt.txt']) {
      const legacyPath = path.join(resourcesScriptsDir, legacy)
      try { if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath) } catch { /* ignore */ }
    }

  } catch { /* resources dir may not be configured yet */ }

}

/**
 * Boot-heal: remove a GLOBAL statusLine stanza a prior CCC version wrote into
 * ~/.claude/settings.json (so plain `claude` outside CCC shows its native line
 * again) and delete the legacy planted ~/.claude/claude-multi-statusline.js.
 * Only OUR stanza is stripped -- a user's own statusLine is left untouched.
 */
export function healGlobalStatusline(claudeDir: string = path.join(os.homedir(), '.claude')): void {
  try {
    const settingsPath = path.join(claudeDir, 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      const sl = settings.statusLine as { command?: unknown } | undefined
      if (sl && typeof sl.command === 'string' && sl.command.includes('claude-multi-statusline.js')) {
        delete settings.statusLine
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
      }
    }
  } catch { /* best-effort -- never block boot on cleanup */ }
  try {
    const legacyScript = path.join(claudeDir, 'claude-multi-statusline.js')
    if (fs.existsSync(legacyScript)) fs.unlinkSync(legacyScript)
  } catch { /* best-effort */ }
}

/**
 * Copy `scripts/resume-picker.js` into `<resourcesDir>/scripts/`.
 *
 * electron-vite bundles all src/main/**\/*.ts into a single out/main/index.js,
 * so `__dirname` at runtime is always out/main/ regardless of original source
 * location. The default `path.join(__dirname, '../../scripts/...')` hops two
 * directories up from out/main/ to the build root (sibling of out/), then into
 * scripts/ -- where electron-builder copies the script via package.json
 * `build.files`. In dev (vitest) __dirname resolves to the source file's
 * directory, so the same join lands at <repo>/src/main/scripts/ -- which is
 * empty in the source tree (the picker actually lives at <repo>/scripts/),
 * so an unredirected dev call silently no-ops via the existsSync guard.
 * Tests inject `sourceRoot` to point at a per-test temp dir instead.
 *
 * @param resourcesDir Destination resources directory.
 * @param sourceRoot   Optional override for the source-script lookup root. The
 *   default uses the __dirname-relative path described above. Tests inject a
 *   per-test temp dir to avoid races on the shared <repo>/src/main/scripts/
 *   path under vitest's parallel file runner.
 */
export async function deployClaudeResumePickerScript(resourcesDir: string, sourceRoot?: string): Promise<void> {
  const resourcesScriptsDir = path.join(resourcesDir, 'scripts')
  if (!fs.existsSync(resourcesScriptsDir)) {
    fs.mkdirSync(resourcesScriptsDir, { recursive: true })
  }
  const resumePickerSrc = sourceRoot
    ? path.join(sourceRoot, 'scripts/resume-picker.js')
    : path.join(__dirname, '../../scripts/resume-picker.js')
  if (fs.existsSync(resumePickerSrc)) {
    fs.copyFileSync(resumePickerSrc, path.join(resourcesScriptsDir, 'resume-picker.js'))
  }
}
