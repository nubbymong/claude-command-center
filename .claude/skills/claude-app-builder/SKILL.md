---
name: claude-app-builder
description: Expert on building applications that integrate with Claude Code CLI sessions, including session orchestration, multi-agent management, context tracking, status detection, and Claude's statusline/transcript APIs. Invoke when working on features that interact with Claude Code processes or parse Claude output.
---

# Claude Code App Integration Expert

You are an expert on building desktop applications that manage and orchestrate multiple Claude Code CLI sessions.

## Claude Code CLI Integration

### Launching Claude Code
```bash
# Basic launch
claude

# With arguments
claude --model opus --resume

# In a specific directory
cd /path/to/project && claude
```

### Claude Code Output Patterns
Claude Code produces structured terminal output that can be parsed:
- **Prompt indicator**: The `❯` or similar prompt character when waiting for input
- **Streaming output**: Continuous text when Claude is generating a response
- **Tool use blocks**: Structured output showing file reads, writes, bash commands
- **Cost display**: Shows token/cost info in the interface

### Status Detection from PTY Output
Analyze a rolling buffer of PTY output to determine Claude's state:

```typescript
type SessionStatus = 'starting' | 'busy' | 'waiting' | 'idle' | 'error' | 'disconnected'

// State transitions:
// starting: From spawn until first prompt detected
// busy: Data received within last 2 seconds (Claude is generating)
// waiting: No output for 2+ seconds, prompt detected
// idle: Waiting state for 30+ seconds with no user input
// error: Error patterns detected in output
// disconnected: PTY process exited
```

### Context Window Tracking
Claude Code supports statusline scripts that report context usage:

**PowerShell statusline script** (for local Windows sessions):
```powershell
# Writes JSON to a status file that the app watches
$status = @{
  used_percentage = $usedPct
  remaining_percentage = $remainingPct
  model = $model
  cost = $cost
} | ConvertTo-Json
$status | Set-Content "~/.claude-multi/status/$sessionId.json"
```

**Bash statusline script** (for remote Linux sessions):
```bash
#!/bin/bash
echo "{\"used_percentage\": $USED_PCT, \"remaining_percentage\": $REM_PCT}" > ~/.claude-multi/status/$SESSION_ID.json
```

Watch these files with `fs.watch()` or poll via SSH for remote sessions.

### Claude Transcript Parsing
Claude stores conversation transcripts as JSONL in `~/.claude/projects/`:

```typescript
// Find transcript files
const claudeDir = path.join(os.homedir(), '.claude', 'projects')
// Each project has timestamped JSONL files
// Parse for token usage, costs, model info

interface TranscriptEntry {
  type: string
  message?: { role: string; content: string }
  model?: string
  usage?: { input_tokens: number; output_tokens: number }
  costUSD?: number
  timestamp: string
}
```

### Subscription Usage Tracking
- Claude has a 5-hour rolling usage window
- Parse JSONL transcripts to calculate tokens used in current window
- Track burn rate (tokens/minute) to project when limit will be hit
- Aggregate costs across all local sessions

## Multi-Session Orchestration

### Session Management Architecture
```
App (Electron Main Process)
├── PTY Manager (Map<sessionId, PtySession>)
│   ├── Session 1: pwsh.exe → ssh → claude
│   ├── Session 2: pwsh.exe → claude (local)
│   └── Session N: ...
├── Status Detector (per-session state machine)
├── Context Tracker (file watchers)
├── Metrics Collector (SSH polling)
└── Orchestrator (global commands)
```

### Broadcast Commands
Send the same prompt/command to multiple Claude sessions simultaneously:
```typescript
function broadcast(text: string, sessionIds: string[]): void {
  for (const id of sessionIds) {
    writeToSession(id, text + '\r')
  }
}
```

### Orchestration Commands
- **Update All**: Send `claude update` to each session's PTY
- **Restart All**: Kill PTY → respawn → re-run startup sequence
- **Sync Skills**: SCP skill files to remote machines' `~/.claude/commands/`
- **Kill All**: Kill all PTY processes immediately

### Skills Management
- Central skills folder: `~/.claude-multi/skills/`
- Push to remote via SCP: `scp local_skill.md user@host:~/.claude/commands/`
- Pull from remote: `scp user@host:~/.claude/commands/*.md local_dir/`
- Auto-sync on session connect (optional)

## Performance Considerations
- Each Claude Code session uses 100-300MB RAM
- 20 concurrent sessions = 2-6GB total
- PTY output can be high-bandwidth during code generation
- Use rolling buffers (10KB) instead of unbounded string concatenation
- Throttle IPC events to renderer (batch multiple PTY data events)
