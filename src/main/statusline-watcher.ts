import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { getResourcesDirectory } from './ipc/setup-handlers'
import { handleStatuslineUpdate } from './tokenomics-manager'

// Re-export from shared types for backward compatibility
export type { StatuslineData } from '../shared/types'
import type { StatuslineData } from '../shared/types'

// Lazy-initialized: can't call getResourcesDirectory() at module load time
let STATUS_DIR: string | null = null
function getStatusDir(): string {
  if (!STATUS_DIR) {
    STATUS_DIR = path.join(getResourcesDirectory(), 'status')
  }
  return STATUS_DIR
}
const STATUSLINE_SCRIPT = path.join(os.homedir(), '.claude', 'claude-multi-statusline.js')

/**
 * Deploy the statusline script that Claude Code will invoke.
 * The script reads JSON from stdin and writes to a per-session status file.
 */
export function deployStatuslineScript(): void {
  const statusDir = getStatusDir()
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
const cacheFile = path.join(os.tmpdir(), 'claude-command-center-usage-cache.json');
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

async function getCachedUsageLimits() {
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

  // Fetch fresh data
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
    const sessionId = process.env.CLAUDE_MULTI_SESSION_ID || data.session_id || 'unknown';

    const usage = data.context_window?.current_usage;
    const inputTokens = usage ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : undefined;

    const status = {
      sessionId,
      model: data.model?.display_name || data.model?.id,
      contextUsedPercent: data.context_window?.used_percentage,
      contextRemainingPercent: data.context_window?.remaining_percentage,
      contextWindowSize: data.context_window?.context_window_size,
      inputTokens,
      outputTokens: usage?.output_tokens,
      costUsd: data.cost?.total_cost_usd,
      totalDurationMs: data.cost?.total_duration_ms,
      linesAdded: data.cost?.total_lines_added,
      linesRemoved: data.cost?.total_lines_removed,
      timestamp: Date.now()
    };

    // Fetch rate limits (cached, non-blocking)
    const limits = await getCachedUsageLimits();
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

    // Peak/off-peak — peak hours are 05:00-11:00 PT (UTC-7/-8) on weekdays
    const now = new Date();
    const ptOffset = (() => {
      const year = now.getUTCFullYear();
      const marchSecondSun = new Date(Date.UTC(year, 2, 8));
      marchSecondSun.setUTCDate(8 + (7 - marchSecondSun.getUTCDay()) % 7);
      const novFirstSun = new Date(Date.UTC(year, 10, 1));
      novFirstSun.setUTCDate(1 + (7 - novFirstSun.getUTCDay()) % 7);
      return (now >= marchSecondSun && now < novFirstSun) ? -7 : -8;
    })();
    const ptHour = (now.getUTCHours() + ptOffset + 24) % 24;
    const ptDay = new Date(now.getTime() + ptOffset * 3600000).getUTCDay();
    const isWeekday = ptDay >= 1 && ptDay <= 5;
    const isPeak = isWeekday && ptHour >= 5 && ptHour < 11;
    status.isPeak = isPeak;

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

  fs.writeFileSync(STATUSLINE_SCRIPT, scriptContent, { mode: 0o755 })

  // Also deploy to resources/scripts/ for SSH-mounted access
  try {
    const resourcesScriptsDir = path.join(getResourcesDirectory(), 'scripts')
    if (!fs.existsSync(resourcesScriptsDir)) {
      fs.mkdirSync(resourcesScriptsDir, { recursive: true })
    }
    fs.writeFileSync(
      path.join(resourcesScriptsDir, 'claude-multi-statusline.js'),
      scriptContent,
      { mode: 0o755 }
    )

    // Deploy resume-picker.js from bundled scripts
    const resumePickerSrc = path.join(__dirname, '../../scripts/resume-picker.js')
    if (fs.existsSync(resumePickerSrc)) {
      fs.copyFileSync(resumePickerSrc, path.join(resourcesScriptsDir, 'resume-picker.js'))
    }

    // Clean up legacy vision scripts (replaced by MCP server)
    for (const legacy of ['vision-cli.js', 'vision-prompt.txt']) {
      const legacyPath = path.join(resourcesScriptsDir, legacy)
      try { if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath) } catch { /* ignore */ }
    }

  } catch { /* resources dir may not be configured yet */ }
}

/**
 * Merge our statusline command into Claude's settings.json without overwriting other settings.
 */
export function configureClaudeSettings(): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}

  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
  } catch { /* start fresh */ }

  // Point to the resources dir copy so the script can derive status dir
  // from its own location (scripts/ → ../status/)
  const resourcesScript = path.join(getResourcesDirectory(), 'scripts', 'claude-multi-statusline.js')
  const command = os.platform() === 'win32'
    ? `node "${resourcesScript.replace(/\\/g, '\\\\')}"`
    : `node "${resourcesScript}"`

  settings.statusLine = {
    type: 'command',
    command
  }

  const claudeDir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true })
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

/**
 * Watch the status directory for updates and send to the renderer.
 * Uses fs.watch for instant local notifications, plus a polling fallback
 * for remote/SMB writes that don't trigger ReadDirectoryChangesW on Windows.
 */
export function startStatuslineWatcher(getWindow: () => BrowserWindow | null): () => void {
  const statusDir = getStatusDir()
  if (!fs.existsSync(statusDir)) {
    fs.mkdirSync(statusDir, { recursive: true })
  }

  // Track last-seen mtime per file to avoid redundant sends
  const lastMtime = new Map<string, number>()

  function processFile(filename: string): void {
    const win = getWindow()
    if (!win || win.isDestroyed()) return

    const filePath = path.join(statusDir, filename)
    try {
      const stat = fs.statSync(filePath)
      const mtime = stat.mtimeMs
      if (lastMtime.get(filename) === mtime) return
      lastMtime.set(filename, mtime)

      const content = fs.readFileSync(filePath, 'utf-8')
      const data: StatuslineData = JSON.parse(content)
      win.webContents.send('statusline:update', data)

      // Feed real-time data to tokenomics
      handleStatuslineUpdate(data)
    } catch { /* ignore read errors during writes */ }
  }

  // fs.watch: instant for local writes
  const watcher = fs.watch(statusDir, (eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return
    processFile(filename)
  })

  // Polling fallback: catches remote/SMB writes that fs.watch misses
  const POLL_INTERVAL = 3000
  const pollTimer = setInterval(() => {
    try {
      const files = fs.readdirSync(statusDir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        processFile(file)
      }
    } catch { /* ignore */ }
  }, POLL_INTERVAL)

  return () => {
    watcher.close()
    clearInterval(pollTimer)
  }
}

/**
 * Clean up status files for a given session.
 */
export function cleanupStatusFile(sessionId: string): void {
  const filePath = path.join(getStatusDir(), `${sessionId}.json`)
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch { /* ignore */ }
}
