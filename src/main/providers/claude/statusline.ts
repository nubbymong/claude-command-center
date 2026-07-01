/**
 * Claude statusline deployment (lifted from statusline-watcher.ts in P0.7)
 *
 * - Writes the Node.js statusline bridge script to ~/.claude/claude-multi-statusline.js
 *   AND to <resourcesDir>/scripts/claude-multi-statusline.js (for SSH-mounted access).
 * - Mutates ~/.claude/settings.json to point Claude Code's `statusLine.command`
 *   at the resources-dir copy.
 * - Bundled script handles fetching rate limits from the Anthropic OAuth usage
 *   endpoint (api.anthropic.com/api/oauth/usage) at runtime.
 *
 * All behaviour here is Claude-specific: settings.json layout, OAuth token path,
 * statusLine command stanza. Codex has no equivalent statusline shim.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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

  // Write the Node.js statusline script
  const scriptContent = `#!/usr/bin/env node
// Claude Command Center - Statusline bridge script
// Reads JSON from stdin (sent by Claude Code), fetches rate limits, writes status file
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// Derive status dir from script location: scripts/xxx.js → ../status/
// Works on any mount path (local resources dir, SSH remote mount, etc.)
const statusDir = path.join(path.dirname(process.argv[1]), '..', 'status');
const CACHE_MAX_AGE = 60; // seconds

function fetchUsageLimits() {
  return new Promise((resolve) => {
    // Read OAuth token from Claude CLI's own credentials file (opt-in: only used if file exists).
    // This token is created by "claude login" and is NOT stored or transmitted by this app.
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    try {
      if (!fs.existsSync(credsPath)) return resolve(null);
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      const token = creds.claudeAiOauth?.accessToken;
      if (!token) return resolve(null);

      const options = {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.34'
        },
        timeout: 5000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

async function getCachedUsageLimits(accountEmail) {
  const cacheKey = (accountEmail || 'default').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const cacheFile = path.join(os.tmpdir(), 'claude-command-center-usage-cache-' + cacheKey + '.json');
  // Check cache first
  try {
    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      const age = (Date.now() - stat.mtimeMs) / 1000;
      if (age < CACHE_MAX_AGE) {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      }
    }
  } catch {}
  const data = await fetchUsageLimits();
  if (data) {
    try { fs.writeFileSync(cacheFile, JSON.stringify(data)); } catch {}
  }
  return data;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);

    // P8.9: read active Claude account email for statusline display.
    // Defensive cap protects against runaway ~/.claude.json growth.
    let accountEmail = undefined;
    try {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      const stat = fs.statSync(claudeJsonPath);
      if (stat.size < 5 * 1024 * 1024) {
        const j = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        if (j && j.oauthAccount && typeof j.oauthAccount.emailAddress === 'string') {
          accountEmail = j.oauthAccount.emailAddress;
        }
      }
    } catch { /* swallow -- statusline must not block on identity */ }

    const sessionId = process.env.CLAUDE_MULTI_SESSION_ID || data.session_id || 'unknown';

    const usage = data.context_window?.current_usage;
    const inputTokens = usage ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : undefined;

    const status = {
      sessionId,
      model: data.model?.display_name || data.model?.id,
      modelId: data.model?.id,
      effortLevel: data.effort && data.effort.level,
      fastMode: data.fast_mode,
      contextUsedPercent: data.context_window?.used_percentage,
      contextRemainingPercent: data.context_window?.remaining_percentage,
      contextWindowSize: data.context_window?.context_window_size,
      inputTokens,
      outputTokens: usage?.output_tokens,
      costUsd: data.cost?.total_cost_usd,
      totalDurationMs: data.cost?.total_duration_ms,
      linesAdded: data.cost?.total_lines_added,
      linesRemoved: data.cost?.total_lines_removed,
      accountEmail,
      // Logs v2 (Task 8): forward Claude Code's transcript_path so the watcher
      // fan-out can bind it (continuous, exact discovery source).
      transcriptPath: typeof data.transcript_path === 'string' ? data.transcript_path : undefined,
      timestamp: Date.now()
    };

    // Fetch rate limits (cached per-account, non-blocking)
    const limits = await getCachedUsageLimits(accountEmail);
    if (limits) {
      if (limits.five_hour) {
        status.rateLimitCurrent = Math.round(Number(limits.five_hour.utilization) || 0);
        status.rateLimitCurrentResets = limits.five_hour.resets_at || '';
      }
      if (limits.seven_day) {
        status.rateLimitWeekly = Math.round(Number(limits.seven_day.utilization) || 0);
        status.rateLimitWeeklyResets = limits.seven_day.resets_at || '';
      }
      if (limits.extra_usage && limits.extra_usage.is_enabled) {
        status.rateLimitExtra = {
          enabled: true,
          utilization: Math.round(Number(limits.extra_usage.utilization) || 0),
          usedUsd: Math.round(Number(limits.extra_usage.used_credits || 0)) / 100,
          limitUsd: Math.round(Number(limits.extra_usage.monthly_limit || 0)) / 100
        };
      }
    }

    // Suppress statusline display in the terminal — the Conductor's own ContextBar
    // shows all this data via the file watcher below. Output a single space
    // so Claude's statusline area stays minimal.
    process.stdout.write(' ');

    // Write status file for the app's ContextBar (best-effort, fails silently on remote)
    try {
      if (!fs.existsSync(statusDir)) {
        fs.mkdirSync(statusDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(statusDir, sessionId + '.json'),
        JSON.stringify(status)
      );
    } catch {}
  } catch (e) {
    // Silently fail - don't break Claude's output
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
