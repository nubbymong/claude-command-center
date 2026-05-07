/**
 * Codex rollout watch-and-claim telemetry (P3.1)
 *
 * Tails the rollout JSONL that Codex writes to
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * and converts token_count events into StatuslineData updates.
 *
 * Exports:
 *   parseCodexRollout       -- parse raw JSONL text into typed events
 *   mapTokenCountToStatusline -- convert a TokenCountEvent to StatuslineData
 *   watchAndClaimRollout    -- 250ms-poll claim + 500ms-poll tail pipeline
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { getCodexHome } from './auth'
import { computeCodexCostUsd } from './pricing'
import type { StatuslineData } from '../../../shared/types'
import type { TelemetrySource } from '../types'

// ── Types ────────────────────────────────────────────────────────────────────

export interface RolloutMeta {
  id: string
  cwd: string
  model: string
  /**
   * Codex turn_context.payload.effort -- reasoning effort label like "xhigh".
   * Surfaced alongside the model name in the ContextBar so the user can see
   * which effort level the session is actually running at. Optional because
   * older rollouts (pre-0.128.0) and the very earliest events of a session
   * before the first turn_context may not carry it.
   */
  reasoningEffort?: string
  cli_version: string
  timestamp: string
}

/**
 * Merged view of a token_count event: token usage from evt.payload.info
 * combined with rate_limits from evt.payload.rate_limits.
 *
 * Codex JSONL structure (real format):
 *   { type: "event_msg", payload: {
 *       type: "token_count",
 *       info: { total_token_usage: {...}, last_token_usage: {...}, model_context_window: N } | null,
 *       rate_limits: { primary?: {...}, secondary?: {...}, ... }
 *   }}
 *
 * Events where info is null (pre-response placeholders) are skipped by parseCodexRollout.
 */
export interface TokenCountEvent {
  total_token_usage: {
    input_tokens: number
    cached_input_tokens: number
    output_tokens: number
    reasoning_output_tokens: number
    total_tokens: number
  }
  last_token_usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
    reasoning_output_tokens?: number
    total_tokens?: number
  }
  rate_limits?: {
    primary?: { used_percent: number; window_minutes: number; resets_at: number; plan_type?: string }
    secondary?: { used_percent: number; window_minutes: number; resets_at: number }
  }
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse raw JSONL text from a Codex rollout file.
 *
 * Returns:
 *   meta          -- session_meta fields (id, cwd, model, cli_version, timestamp)
 *   tokenCounts   -- all token_count events that have real usage data (info != null)
 *   contextWindow -- model_context_window from the task_started event, or null
 *
 * Throws if no session_meta line is found.
 */
export function parseCodexRollout(text: string): {
  meta: RolloutMeta
  tokenCounts: TokenCountEvent[]
  contextWindow: number | null
} {
  const lines = text.split('\n').filter(Boolean)
  let meta: RolloutMeta | null = null
  const tokenCounts: TokenCountEvent[] = []
  let contextWindow: number | null = null

  for (const line of lines) {
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (evt.type === 'session_meta') {
      const p = evt.payload as Record<string, unknown>
      meta = {
        id: String(p.id ?? ''),
        cwd: String(p.cwd ?? ''),
        // model is populated below from turn_context; session_meta only has model_provider
        model: String(p.model ?? ''),
        cli_version: String(p.cli_version ?? ''),
        timestamp: String(evt.timestamp ?? ''),
      }
      continue
    }

    // turn_context carries the resolved model name (e.g. "gpt-5.5") and the
    // reasoning effort (e.g. "xhigh"). The effort is on payload.effort directly.
    if (evt.type === 'turn_context' && meta) {
      const p = evt.payload as Record<string, unknown>
      if (typeof p.model === 'string' && p.model) {
        meta.model = p.model
      }
      if (typeof p.effort === 'string' && p.effort) {
        meta.reasoningEffort = p.effort
      }
      continue
    }

    if (evt.type !== 'event_msg') continue

    const payload = evt.payload as Record<string, unknown>

    if (payload.type === 'task_started') {
      const cw = (payload as Record<string, unknown>).model_context_window
      if (typeof cw === 'number') contextWindow = cw
      continue
    }

    if (payload.type === 'token_count') {
      // info is null for pre-response token_count events -- skip those
      const info = payload.info as Record<string, unknown> | null
      if (!info) continue

      const usage = info.total_token_usage as Record<string, unknown>
      if (!usage) continue

      const tokenCountEvent: TokenCountEvent = {
        total_token_usage: {
          input_tokens: Number(usage.input_tokens ?? 0),
          cached_input_tokens: Number(usage.cached_input_tokens ?? 0),
          output_tokens: Number(usage.output_tokens ?? 0),
          reasoning_output_tokens: Number(usage.reasoning_output_tokens ?? 0),
          total_tokens: Number(usage.total_tokens ?? 0),
        },
        rate_limits: payload.rate_limits as TokenCountEvent['rate_limits'] | undefined,
      }

      const lastUsage = info.last_token_usage as Record<string, unknown> | undefined
      if (lastUsage) {
        tokenCountEvent.last_token_usage = {
          input_tokens: Number(lastUsage.input_tokens ?? 0),
          cached_input_tokens: Number(lastUsage.cached_input_tokens ?? 0),
          output_tokens: Number(lastUsage.output_tokens ?? 0),
          reasoning_output_tokens: Number(lastUsage.reasoning_output_tokens ?? 0),
          total_tokens: Number(lastUsage.total_tokens ?? 0),
        }
      }

      tokenCounts.push(tokenCountEvent)
    }
  }

  if (!meta) throw new Error('rollout missing session_meta')
  return { meta, tokenCounts, contextWindow }
}

// ── Mapper ───────────────────────────────────────────────────────────────────

/**
 * Convert a TokenCountEvent into a StatuslineData update.
 *
 * - inputTokens = input_tokens + cached_input_tokens (total consumed input)
 * - outputTokens = output_tokens + reasoning_output_tokens
 * - costUsd: computed via computeCodexCostUsd; undefined if model has no pricing entry
 * - rateLimitCurrent + rateLimitCurrentResets: present when rate_limits.primary exists
 * - rateLimitWeekly + rateLimitWeeklyResets: present when rate_limits.secondary exists
 * - contextUsedPercent: total_tokens / contextWindow * 100 when contextWindow is known
 */
export function mapTokenCountToStatusline(
  tc: TokenCountEvent,
  meta: RolloutMeta,
  sessionId: string,
  contextWindow: number | null = null,
): StatuslineData {
  const u = tc.total_token_usage

  const cost = computeCodexCostUsd(meta.model, {
    inputTokens: u.input_tokens,
    cachedInputTokens: u.cached_input_tokens,
    outputTokens: u.output_tokens,
    reasoningOutputTokens: u.reasoning_output_tokens,
  })

  const sl: StatuslineData = {
    sessionId,
    model: meta.model,
    reasoningEffort: meta.reasoningEffort,
    inputTokens: u.input_tokens + u.cached_input_tokens,
    outputTokens: u.output_tokens + u.reasoning_output_tokens,
    costUsd: cost ?? undefined,
    contextWindowSize: contextWindow ?? undefined,
    contextUsedPercent: contextWindow ? (u.total_tokens / contextWindow) * 100 : undefined,
  }

  if (tc.rate_limits?.primary) {
    sl.rateLimitCurrent = Math.round(tc.rate_limits.primary.used_percent)
    const ra = tc.rate_limits.primary.resets_at
    if (Number.isFinite(ra)) {
      sl.rateLimitCurrentResets = new Date(ra * 1000).toISOString()
    }
  }

  if (tc.rate_limits?.secondary) {
    sl.rateLimitWeekly = Math.round(tc.rate_limits.secondary.used_percent)
    const ra = tc.rate_limits.secondary.resets_at
    if (Number.isFinite(ra)) {
      sl.rateLimitWeeklyResets = new Date(ra * 1000).toISOString()
    }
  }

  return sl
}

// ── Watch-and-claim pipeline ─────────────────────────────────────────────────

/**
 * Module-level set of rollout file paths that have already been claimed by an
 * active watcher. Prevents two concurrent sessions from both latching onto the
 * same file. stop() removes the path so the set stays bounded over app lifetime.
 */
const claimed = new Set<string>()

/**
 * Watch and claim the Codex rollout file for a spawned session.
 *
 * Algorithm:
 * 1. Poll every 250ms, looking for a rollout file in the UTC date directory
 *    whose session_meta.cwd matches sessionCwd AND whose timestamp is within
 *    [spawnTimestamp - 5000ms, +inf).
 * 2. Once claimed, poll parseAndEmit every 500ms. fs.watch is NOT used because
 *    on Windows it misses append events when the Codex CLI writer holds the
 *    file open -- same failure mode that hit the Claude statusline in v1.2.134
 *    (SMB writes). The lastSize dedupe in parseAndEmit keeps the polling cheap.
 * 3. If no claim happens within 10s, log a "still polling" warning. If still
 *    no claim at 30s, give up (--ephemeral path) and stop polling. The 30s
 *    cap accounts for cold-start delay -- on Windows, Codex 0.128.0 typically
 *    writes the first rollout event ~8s after spawn but a cold launch through
 *    the cmd.exe wrapper can run noticeably longer.
 * 4. stop() clears both timeouts, the claim-poll interval, and the tail-poll
 *    interval, and removes the path from the claimed set.
 *
 * Windows path note: Codex records cwd exactly as provided by the OS at spawn
 * time. Pass the same resolvedCwd string from pty-manager (backslashes on
 * Windows) so the exact-string match works correctly.
 */
export function watchAndClaimRollout(
  sessionId: string,
  sessionCwd: string,
  spawnTimestamp: number,
  onUpdate: (sl: StatuslineData) => void,
): TelemetrySource {
  const home = getCodexHome()
  // NOTE: dateDir is bound to today's UTC date at call time; it will not follow
  // midnight UTC rollover (sessions started before midnight won't be found after).
  // Known limitation -- fix by re-computing dateDir on each poll tick.
  const today = new Date()
  const dateDir = join(
    home,
    'sessions',
    String(today.getUTCFullYear()),
    String(today.getUTCMonth() + 1).padStart(2, '0'),
    String(today.getUTCDate()).padStart(2, '0'),
  )

  let claimedPath: string | null = null
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let tailIntervalHandle: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let lastSize = 0
  let contextWindow: number | null = null
  let meta: RolloutMeta | null = null

  function tryClaim(): void {
    if (claimedPath || stopped) return
    if (!existsSync(dateDir)) return

    let files: string[]
    try {
      files = readdirSync(dateDir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
    } catch {
      return
    }

    for (const f of files) {
      const fullPath = join(dateDir, f)
      if (claimed.has(fullPath)) continue

      try {
        const text = readFileSync(fullPath, 'utf-8')
        const firstLine = text.split('\n')[0]
        if (!firstLine) continue

        const evt = JSON.parse(firstLine) as Record<string, unknown>
        if (evt.type !== 'session_meta') continue

        const p = evt.payload as Record<string, unknown>
        const rolloutTs = new Date(String(evt.timestamp ?? '')).getTime()

        if (
          String(p.cwd) === sessionCwd &&
          rolloutTs >= spawnTimestamp - 5000
        ) {
          claimedPath = fullPath
          claimed.add(fullPath)
          meta = {
            id: String(p.id ?? ''),
            cwd: String(p.cwd ?? ''),
            model: String(p.model ?? ''),
            cli_version: String(p.cli_version ?? ''),
            timestamp: String(evt.timestamp ?? ''),
          }

          // Initial parse covers the case where session_meta + task_started +
          // token_count are all already present at claim time.
          parseAndEmit(fullPath)

          // Replaced fs.watch with a polling interval -- fs.watch on Windows
          // misses append events when the Codex CLI writer holds the file open
          // and appends progressively. lastSize dedupe in parseAndEmit keeps
          // the polling cheap when the file has not grown.
          tailIntervalHandle = setInterval(() => {
            if (stopped || !claimedPath) return
            parseAndEmit(claimedPath)
          }, 500)

          // Claimed -- the interval can stop polling
          if (intervalHandle) {
            clearInterval(intervalHandle)
            intervalHandle = null
          }
          return
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  function parseAndEmit(filePath: string): void {
    try {
      const text = readFileSync(filePath, 'utf-8')
      // JSONL rollouts are append-only. A size shrink means the file was replaced
      // (rotation, restart, or external delete-and-recreate); reset lastSize to
      // force a fresh parse from offset 0.
      if (text.length < lastSize) { lastSize = 0 }
      if (text.length === lastSize) return
      lastSize = text.length

      try {
        const { meta: parsedMeta, tokenCounts, contextWindow: cw } = parseCodexRollout(text)
        // Refresh meta on each parse so turn_context model updates are captured.
        // session_meta.payload has no model field; turn_context carries the resolved model name.
        meta = parsedMeta
        if (cw != null && contextWindow == null) contextWindow = cw
        if (tokenCounts.length > 0 && meta) {
          const latest = tokenCounts[tokenCounts.length - 1]
          onUpdate(mapTokenCountToStatusline(latest, meta, sessionId, contextWindow))
        }
      } catch {
        // Partial read or missing session_meta -- will retry on next change
      }
    } catch {
      // File read error -- skip
    }
  }

  // Set up the 250ms polling interval before the initial tryClaim() call so
  // that if tryClaim() claims synchronously, it can clear intervalHandle correctly.
  intervalHandle = setInterval(() => {
    if (claimedPath || stopped) {
      if (intervalHandle) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
      return
    }
    tryClaim()
  }, 250)

  // Initial attempt -- avoids waiting 250ms before the first probe.
  tryClaim()

  // No-claim deadline. P3.5 dev smoke showed Codex 0.128.0 takes ~8s to write the
  // first rollout event on Windows after the cmd.exe wrapper warms up; cold starts
  // can run longer. We warn at 10s (so the user sees something is slow) but keep
  // polling until 30s before giving up. Hitting 30s genuinely indicates --ephemeral
  // or a launch failure.
  const warnHandle = setTimeout(() => {
    if (!claimedPath && !stopped) {
      console.warn(
        `[codex/telemetry] no rollout claimed for session ${sessionId} after 10s -- still polling, will give up at 30s`,
      )
    }
  }, 10_000)

  const timeoutHandle = setTimeout(() => {
    if (!claimedPath && !stopped) {
      console.warn(
        `[codex/telemetry] no rollout claimed for session ${sessionId} after 30s -- assuming --ephemeral`,
      )
      if (intervalHandle) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
    }
  }, 30_000)

  return {
    stop(): void {
      stopped = true
      clearTimeout(warnHandle)
      clearTimeout(timeoutHandle)
      if (intervalHandle) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
      if (tailIntervalHandle) {
        clearInterval(tailIntervalHandle)
        tailIntervalHandle = null
      }
      if (claimedPath) {
        claimed.delete(claimedPath)
        claimedPath = null
      }
    },
  }
}
