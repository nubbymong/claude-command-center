# Claude Conductor Beta

Multi-session terminal orchestrator for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Run multiple Claude sessions simultaneously with tabbed management, SSH remote access, session restore, and real-time usage monitoring.

> **Beta** — This app is unsigned. Windows SmartScreen will warn on first run.
> Click **"More info"** then **"Run anyway"** to proceed.

## Installation

1. Download the latest `ClaudeConductor-Beta-x.y.z.exe` from [Releases](../../releases)
2. Verify the SHA-256 checksum against `CHECKSUMS.txt` in the release
3. Run the installer — choose your Data and Resources directories
4. The setup wizard will guide you through Claude CLI authentication

## Key Features

### Session Management
- Run multiple Claude Code sessions in parallel with tabbed interface
- Save terminal configurations as reusable presets
- Organize configs into sections and groups — launch entire groups at once
- Session restore on close with automatic `/resume` on relaunch
- Attention indicators on tabs when Claude needs input

### Local & SSH Terminals
- Local sessions in any working directory
- SSH remote sessions with encrypted password storage
- Post-connect commands (e.g., `docker exec -it container bash`)
- Sudo password auto-entry
- Partner terminal — optional second shell alongside Claude
- Shell-only mode for manual tasks

### Custom Commands
- Create command buttons that send prompts to Claude or partner terminal
- Scope commands globally or per-config
- Target Claude, partner, or whichever terminal is active
- Drag-and-drop reordering with custom colors

### Real-Time Monitoring
- Live context window usage with color-coded progress bar
- Model name, token counts, API cost, lines changed, session duration
- Rate limit tracking (5-hour and weekly) with reset timers
- Compaction Interrupt — auto-pause Claude when context reaches a threshold

### Screenshots & Images
- Rectangle or window capture directly into Claude's context
- Clipboard image paste (Alt+V) with auto-resize and JPEG optimization
- Recent screenshots panel with multi-select
- Docker container screenshot support via `docker cp`

### Analytics
- Usage dashboard with cost breakdown by model and time
- Session logging with full terminal output, search, and timeline
- Project browser — discover and resume past Claude sessions
- Insights — Claude-powered analysis of usage patterns with KPI tracking

### Configuration
- All settings stored in portable CONFIG directory (survives reinstall)
- Customizable terminal font size, default model, working directory
- Debug logging with event panel and log rotation
- Keyboard shortcuts for common actions

## Security

- **Password encryption**: SSH passwords encrypted with Windows DPAPI via Electron's safeStorage API. Passwords are machine-bound — they only decrypt on the machine that stored them. Stored as encrypted base64 blobs, never plaintext.
- **No telemetry**: The app sends no data anywhere. All API communication goes through Claude CLI directly to Anthropic's API.
- **Local storage**: All configuration, logs, and session data stored locally in user-selected directories.
- **VirusTotal scanned**: Each release installer is scanned against 70+ antivirus engines. Scan results linked in release notes.

## Build from Source

Requires: Node.js 20+, npm, Windows 10/11

```bash
git clone https://github.com/nubbymong/claude_conductor_windows.git
cd claude_conductor_windows
npm install
npm run dev        # Development with HMR
npm run build      # Build only
npm run release    # Full release: build, package, checksum, tag, publish
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+W | Close active session |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous session |
| Ctrl+1-9 | Jump to session N |
| Ctrl+B | Toggle sidebar |
| Alt+V | Paste clipboard image |
| Escape | Interrupt Claude |
| Shift+Enter | New line in input |

## License

Proprietary. All rights reserved.
