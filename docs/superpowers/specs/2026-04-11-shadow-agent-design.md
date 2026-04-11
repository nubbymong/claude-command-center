# Shadow Agent — Design Spec

## Overview

A managed, on-demand Claude Code PTY session that runs in the background for app-internal analysis tasks. The user knows about it, can enable/disable it, and optionally watch the terminal as it works. Token usage is tracked separately in Tokenomics.

The shadow agent is **not** a new SDK integration or API client. It is a real Claude Code interactive session, spawned via node-pty, with the same capabilities as any user session — but controlled programmatically by the app.

## Motivation

Several app features need Claude to perform analysis (Insights KPI extraction, cross-run comparison). The current approach — spawning `claude -p` with shell arguments — is fragile on Windows (quoting breaks), has no session persistence, and provides no visibility into what's happening. A managed PTY session solves all three problems and creates a foundation for future agentic features.

## Architecture

### Core Module: `src/main/shadow-agent.ts`

Single module managing the shadow agent lifecycle. Exports:

```typescript
interface ShadowTask {
  id: string
  consumer: 'insights'          // extensible enum
  prompt: string                // what to send to Claude
  resultFile?: string           // relative path under .agent-workspace/ for file-based output
  timeoutMs?: number            // per-task timeout (default 600000 = 10 min)
}

interface ShadowTaskResult {
  taskId: string
  output: string                // accumulated TUI text (stripped ANSI)
  fileResult?: string           // contents of resultFile if specified
  durationMs: number
}

// Public API
function submitTask(task: ShadowTask): Promise<ShadowTaskResult>
function cancelCurrentTask(): void
function isAgentRunning(): boolean
function getQueueLength(): number
function shutdown(): Promise<void>   // graceful — finish active, reject queued
```

### PTY Lifecycle

1. **Spawn on first task**: When `submitTask()` is called and no PTY exists, spawn one:
   - Binary: `resolveClaudeForPty()` (same resolution as user sessions)
   - CWD: `{resourcesDir}/.agent-workspace/`
   - Flags: `--dangerously-skip-permissions`
   - PTY options: `xterm-256color`, 120x30, `useConpty: false`

2. **Task execution**: Write the prompt to the PTY using chunked writes (256B chunks, 12ms delay — same pattern as `pty-manager.ts` paste chunking) to avoid exceeding PTY buffer limits on large prompts. Accumulate output. Detect completion when Claude's `> ` prompt reappears (regex: `/>\s*$/` on the last line of stripped output) AND output has been stable for 500ms (debounce to avoid false-matching `> ` in quoted blocks or markdown).

3. **Result collection**: If `resultFile` is specified, validate the path does not contain `..` (prevent directory traversal), then read `{workspaceDir}/{resultFile}` after prompt detection. Return both the raw TUI output and the file contents.

4. **Dequeue or kill**: After task completes, check queue. If more tasks, send next prompt. If empty, kill the PTY process and clean up.

5. **Timeout**: Per-task timeout (default 10 min). If exceeded, kill PTY, reject task, mark agent as failed.

### FIFO Queue

- Tasks are appended to a queue array.
- Only one task executes at a time.
- When the active task completes, the next is dequeued.
- Consumers call `submitTask()` which returns a Promise that resolves when their specific task completes.
- On `shutdown()`: the active task is allowed to complete (with a 30s hard timeout), all queued tasks are rejected with an error.

### Working Directory

Path: `{resourcesDir}/.agent-workspace/`

Created on first use. Seeded with:

**CLAUDE.md** (app-managed, written fresh on each agent spawn):
```markdown
# Shadow Agent

You are Command Center's internal analysis agent. You run in the background to perform analytical tasks for the app.

## Rules

- When a task asks for structured output, write the result as valid JSON to the file path specified in the prompt. Do not wrap in markdown fences.
- Be concise. Your output is consumed programmatically, not read by humans.
- You have full tool access. Use the Read tool to read files referenced in prompts.
- Do not create, modify, or delete files outside this workspace unless explicitly instructed.
```

**results/** directory: Task results are written here by Claude and read by the app.

### IPC & Renderer Integration

**IPC channels:**
- `shadow-agent:status` (event → renderer): `{ running: boolean, taskId?: string, consumer?: string, message?: string }`
- `shadow-agent:data` (event → renderer): PTY output chunks for the read-only terminal tab
- `shadow-agent:submit` (renderer → main): Submit a task (used if future UI allows manual submission)

**Toast notification (`ShadowAgentToast.tsx`):**
- Appears when a task starts: "Shadow Agent: {message}..." with a **Watch** button
- Auto-dismisses when task completes (or shows brief "Done" state)
- Watch button opens a read-only session tab

**Read-only session tab:**
- Created on demand when user clicks Watch
- Uses existing `TerminalView` component with xterm.js
- Input disabled: the `onData` handler that writes to the PTY is not attached
- Visual indicators: lock icon in tab header, "Shadow Agent" label, muted border color
- PTY output routed via `shadow-agent:data` IPC channel
- Tab can be closed by user at any time without affecting the agent
- Tab auto-closes when the agent goes idle (unless user pinned/interacted with it)

## Settings

### Config key: `shadowAgent`

```json
{
  "shadowAgent": {
    "enabled": false,
    "consumers": {
      "insights": true
    }
  }
}
```

### Settings UI

New section in SettingsPage: **Shadow Agent**

- **Enable Shadow Agent** toggle
  - Description: "Runs a background Claude session for app analysis tasks. Token usage is tracked separately in Tokenomics under 'Shadow Agent'."
  - Warning note: "Uses `--dangerously-skip-permissions` in an app-managed workspace. No user files are modified."
- **Sub-section: Insights**
  - "Use Shadow Agent for KPI extraction and cross-run analysis"
  - Only visible when shadow agent is enabled
  - When disabled, Insights falls back to `claude -p` for single-run KPI extraction (no cross-run analysis)

## Tokenomics Integration

The shadow agent runs in `.agent-workspace/` which creates a project entry at `~/.claude/projects/{encoded-path}/`. The tokenomics scanner discovers this automatically.

**Detection**: In `tokenomics-manager.ts`, when processing project directories, check if the project path ends with `.agent-workspace`. If so, label the project as **"Shadow Agent"** in the UI instead of the raw encoded directory name.

**Display**: Shadow Agent appears as a distinct project in:
- The project filter dropdown on the Tokenomics page
- The sessions table (sessions labelled "Shadow Agent" with a system badge)
- Daily cost summaries (shadow agent cost shown separately)

## Insights Integration

### When shadow agent is disabled (or insights consumer is disabled)

No change from current behavior:
- `/insights` report generated via existing PTY spawn (`spawnClaudeInsights()`)
- KPI extraction via `claude -p` with stdin piping (the fix applied in this session)
- No cross-run comparison or progression narrative

### When shadow agent is enabled

- `/insights` report generated via existing PTY spawn (unchanged)
- KPI extraction submitted as a shadow agent task:
  ```typescript
  const result = await submitTask({
    id: `insights-kpi-${runId}`,
    consumer: 'insights',
    prompt: KPI_EXTRACTION_PROMPT.replace('{reportPath}', reportPath).replace('{previousContext}', prevContext),
    resultFile: `results/kpis-${runId}.json`,
  })
  // Parse result.fileResult as InsightsData
  ```
- Cross-run progression analysis submitted as a second task after KPI extraction:
  ```typescript
  const result = await submitTask({
    id: `insights-progression-${runId}`,
    consumer: 'insights',
    prompt: buildProgressionPrompt(allKpiFiles),
    resultFile: `results/progression-${runId}.json`,
  })
  ```

### Cross-run progression analysis

New capability, only available with shadow agent enabled.

**Prompt**: Given all historical KPI JSON files (paths provided), produce a progression narrative:
- Trend lines: which metrics are improving/declining over time
- Inflection points: when did significant changes occur
- Recommendations: what to do differently based on multi-run patterns
- Period comparison: this week vs last week, this month vs last month

**Output**: Shadow agent writes to `.agent-workspace/results/progression-{runId}.json`. The insights runner then copies it to the archive directory (`{resourcesDir}/insights/{runId}/progression.json`) alongside `kpis.json`.

**UI**: New section in KpiSidebar — "Progression" tab alongside the existing KPI metrics. Shows the narrative and trend data from the progression analysis.

## Error Handling

| Scenario | Behavior |
|---|---|
| PTY fails to spawn | Reject task, log error, set status to failed |
| Task times out | Kill PTY, reject task, dequeue next (fresh PTY) |
| PTY crashes mid-task | Reject active task, attempt to dequeue next (new PTY) |
| User disables agent mid-task | Active task completes (30s hard timeout), queued tasks rejected |
| `claude` binary not found | Reject task with descriptive error, don't retry |
| Result file not written | Return task with `fileResult: undefined`, consumer handles gracefully |
| Workspace directory missing | Recreate on next spawn |

## Graceful Shutdown

On app close (`app.on('before-quit')`):
1. Stop accepting new tasks
2. If active task running, wait up to 30 seconds for completion
3. Kill PTY if still running after 30s
4. Clean up queue (reject all pending)

## Files

| File | Change |
|---|---|
| `src/main/shadow-agent.ts` | **NEW** — core agent: PTY lifecycle, FIFO queue, task execution |
| `src/main/insights-runner.ts` | Add shadow agent path for KPI extraction + progression analysis |
| `src/main/index.ts` | Register shadow agent shutdown on app quit |
| `src/main/ipc/shadow-agent-handlers.ts` | **NEW** — IPC handlers for status, data, submit |
| `src/main/config-manager.ts` | Add `shadowAgent` config key |
| `src/main/tokenomics-manager.ts` | Detect `.agent-workspace` project, label as "Shadow Agent" |
| `src/shared/types.ts` | ShadowTask, ShadowTaskResult, ShadowAgentConfig types |
| `src/renderer/components/SettingsPage.tsx` | Shadow Agent config section with toggle + consumer sub-sections |
| `src/renderer/components/ShadowAgentToast.tsx` | **NEW** — notification with Watch button |
| `src/renderer/components/KpiSidebar.tsx` | Progression tab for cross-run analysis |
| `src/renderer/components/InsightsPage.tsx` | Progression data loading and display |
| `src/renderer/App.tsx` | Mount toast, handle read-only session tab lifecycle |
| `src/renderer/stores/shadowAgentStore.ts` | **NEW** — Zustand store for agent status |
| `src/preload/index.ts` | Expose shadow agent IPC channels |
| `src/renderer/types/electron.d.ts` | Shadow agent API types |

## Non-goals (explicitly out of scope)

- User-submitted prompts to the shadow agent (future feature)
- Multiple concurrent shadow agent sessions
- Custom CLAUDE.md editing by the user
- Shadow agent for cloud agent / team pipeline execution
- Persistent warm session (always kill when queue drains)
