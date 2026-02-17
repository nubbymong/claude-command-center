import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { getResourcesDirectory, getDataDirectory } from './ipc/setup-handlers'

// Lazy-initialized: can't call getDataDirectory() at module load time
let STATUS_DIR: string | null = null
function getStatusDir(): string {
  if (!STATUS_DIR) {
    STATUS_DIR = path.join(getDataDirectory(), 'status')
  }
  return STATUS_DIR
}
const STATUSLINE_SCRIPT = path.join(os.homedir(), '.claude', 'claude-multi-statusline.js')

export interface StatuslineData {
  sessionId: string
  model?: string
  contextUsedPercent?: number
  contextRemainingPercent?: number
  contextWindowSize?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  totalDurationMs?: number
  linesAdded?: number
  linesRemoved?: number
  // Rate limits from Anthropic API
  rateLimitCurrent?: number        // 5-hour utilization %
  rateLimitCurrentResets?: string   // ISO timestamp
  rateLimitWeekly?: number         // 7-day utilization %
  rateLimitWeeklyResets?: string   // ISO timestamp
  rateLimitExtra?: {
    enabled: boolean
    utilization: number            // %
    usedUsd: number
    limitUsd: number
  }
}

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
// Claude Conductor - Statusline bridge script
// Reads JSON from stdin (sent by Claude Code), fetches rate limits, writes status file
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const statusDir = ${JSON.stringify(statusDir)};
const cacheFile = path.join(os.tmpdir(), 'claude-conductor-usage-cache.json');
const CACHE_MAX_AGE = 60; // seconds

function fetchUsageLimits() {
  return new Promise((resolve) => {
    // Read OAuth token from Claude's credentials
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

    if (!fs.existsSync(statusDir)) {
      fs.mkdirSync(statusDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(statusDir, sessionId + '.json'),
      JSON.stringify(status)
    );

    // Output a single-line status for Claude's built-in statusline display
    const pct = status.contextUsedPercent != null ? Math.round(status.contextUsedPercent) + '%' : '?';
    const cost = status.costUsd != null ? 'API eq $' + status.costUsd.toFixed(4) : '';
    let line = pct + ' context' + (cost ? ' | ' + cost : '');
    if (status.rateLimitCurrent != null) line += ' | 5h:' + status.rateLimitCurrent + '%';
    if (status.rateLimitWeekly != null) line += ' 7d:' + status.rateLimitWeekly + '%';
    process.stdout.write(line);
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

    // Deploy vision-cli.js from bundled scripts
    const visionCliSrc = path.join(__dirname, '../../scripts/vision-cli.js')
    if (fs.existsSync(visionCliSrc)) {
      fs.copyFileSync(visionCliSrc, path.join(resourcesScriptsDir, 'vision-cli.js'))
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

  const command = os.platform() === 'win32'
    ? `node "${STATUSLINE_SCRIPT.replace(/\\/g, '\\\\')}"`
    : `node "${STATUSLINE_SCRIPT}"`

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
 */
export function startStatuslineWatcher(getWindow: () => BrowserWindow | null): () => void {
  const statusDir = getStatusDir()
  if (!fs.existsSync(statusDir)) {
    fs.mkdirSync(statusDir, { recursive: true })
  }

  const watcher = fs.watch(statusDir, (eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return
    const win = getWindow()
    if (!win || win.isDestroyed()) return

    const filePath = path.join(statusDir, filename)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const data: StatuslineData = JSON.parse(content)
      win.webContents.send('statusline:update', data)
    } catch { /* ignore read errors during writes */ }
  })

  return () => watcher.close()
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
