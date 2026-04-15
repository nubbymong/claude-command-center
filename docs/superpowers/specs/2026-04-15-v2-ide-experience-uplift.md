# v2.0.0 IDE Experience Uplift -- Design Spec

**Date:** 2026-04-15
**Version:** 2.0.0-beta
**Branch:** beta
**Status:** Approved for implementation

## Overview

Transformative upgrade to Claude Command Center evolving it from a terminal orchestrator into a full IDE-class development environment. Replaces the fixed two-pane layout with a full drag-and-drop panel system and adds five new panel types: Diff Viewer, Side Chat, Preview Pane, File Editor, and Git Worktree Isolation.

This is a major version bump (v1.3.x to v2.0.0) due to the scope and architectural impact. v1 stable continues on `main`; v2 development on `beta`.

## Versioning Strategy

- `package.json` version: `2.0.0`
- Beta releases tagged: `v2.0.0-beta.1`, `v2.0.0-beta.2`, etc.
- v1.3.x maintained on `main` for stable channel users
- PR kept open across all 6 phases, description accumulates (never removing content, only adding)
- Promote to stable after all 6 phases complete and tested

## Implementation Phases

Each phase is independently testable and includes: implementation, tips/tour entries, unit tests (vitest), E2E tests (Playwright) for Windows and macOS, and screenshot capture updates.

| Phase | Feature | Dependency | Shortcut |
|-------|---------|------------|----------|
| 1 | Panel System (drag-and-drop layout) | None (foundation) | Views menu |
| 2 | Side Chat | Phase 1 (overlay, not a grid pane) | Ctrl+; (Cmd+; on Mac) |
| 3 | Diff Viewer | Phase 1 (pane type) | Ctrl+Shift+D (Cmd+Shift+D on Mac) |
| 4 | Preview Pane | Phase 1 (pane type) | Ctrl+Shift+P (Cmd+Shift+P on Mac) |
| 5 | File Editor | Phase 1 (pane type) | Click file path / Ctrl+S to save |
| 6 | Git Worktree Isolation | None (main process only) | Config toggle |

---

## Phase 1: Panel System (Foundation)

### Problem

The current layout is a fixed two-pane system (Claude terminal + Partner terminal toggle via show/hide). New features (Diff Viewer, Preview, Editor) need a flexible home. The existing implementation in `App.tsx` (lines 350-415) uses `display: none/flex` toggling which cannot scale to multiple simultaneous panels.

### Architecture

**Layout Tree Model:**

The panel system uses a recursive binary split tree. Each node is either a `SplitNode` (container with two children and a divider) or a `PaneNode` (leaf holding a component).

```typescript
interface SplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  ratio: number                              // 0-1, position of divider
  children: [LayoutNode, LayoutNode]
}

interface PaneNode {
  type: 'pane'
  id: string
  paneType: PaneType
  props: Record<string, unknown>             // pane-specific (file path, URL, etc.)
  maximized?: boolean
}

type LayoutNode = SplitNode | PaneNode
type PaneType = 'claude-terminal' | 'partner-terminal' | 'diff-viewer' | 'preview' | 'file-editor'
// Note: side-chat is an overlay, not a PaneType -- it does not participate in the layout tree
```

**Resolution-Aware Defaults:**

On session creation, detect window width and apply appropriate default layout:

| Window Width | Default Layout |
|-------------|----------------|
| >2560px (ultrawide) | Claude Terminal + Diff Viewer side-by-side |
| 1920-2560px (standard) | Claude Terminal full-width |
| <1920px (small/laptop) | Claude Terminal full-width, panes stack vertically when added |

User-customized layouts override these defaults. Once the user drags a pane, resizes a divider, or adds a pane from the Views menu, the layout is marked as user-customized and resolution-aware defaults no longer apply for that session. A "Reset Layout" option in the Views menu restores resolution-aware defaults.

### New Files

| File | Purpose |
|------|---------|
| `src/renderer/stores/panelStore.ts` | Layout tree state per session, pane CRUD, maximization, persistence |
| `src/renderer/components/panels/PanelContainer.tsx` | Recursive split renderer, drag-and-drop zones, resize dividers |
| `src/renderer/components/panels/PaneHeader.tsx` | Shared pane header: title, icon, drag handle, maximize, close |
| `src/renderer/components/panels/PaneRegistry.ts` | Maps PaneType strings to React component constructors |

### Modified Files

| File | Changes |
|------|---------|
| `src/renderer/App.tsx` | Replace fixed terminal/partner layout (lines 350-415) with `<PanelContainer>` |
| `src/renderer/components/SessionHeader.tsx` | Add "Views" dropdown menu to add panes |
| `src/renderer/stores/configStore.ts` | Add `panelLayout?: LayoutNode` to TerminalConfig for persistence |
| `src/shared/types.ts` | Add LayoutNode, SplitNode, PaneNode, PaneType types |
| `src/renderer/components/TerminalView.tsx` | Wrap as a pane-compatible component (accept pane props) |

### Behavior

- **Default layout:** Single `claude-terminal` pane (preserves current UX for existing users -- zero migration friction)
- **Adding panes:** "Views" dropdown in SessionHeader lists available pane types. Selecting one splits the current layout at the focused pane
- **Drag to rearrange:** Drag pane header to reposition. Drop zones highlight on edges (top/bottom/left/right) of existing panes, indicating where the new split will appear
- **Resize:** Drag dividers between panes. Minimum pane dimension: 200px
- **Maximize:** Double-click pane header or click maximize button. Pane takes full panel area, others collapse. Click again to restore
- **Close:** Close button removes pane and collapses its parent split node
- **Persistence:** Layout tree saved to config per session via `panelStore`. Restored on app restart. Saved on every layout change (debounced)
- **Partner terminal migration:** Existing partner terminal toggle becomes "add/remove partner-terminal pane." Backward compatible -- configs with `partnerTerminalPath` auto-add a partner pane on session creation

### Edge Cases

- Last pane cannot be closed (always at least one pane per session)
- Window resize triggers FitAddon reflow on all terminal panes
- Pane props are serializable (no functions/components stored in layout tree)

---

## Phase 2: Side Chat

### Problem

Users need to ask quick questions about what Claude is doing without derailing the main session's context. Currently the only option is to open a separate session, losing the working context.

### Architecture

Side Chat is an **overlay**, not a grid pane. It slides in from the right edge (35-40% width) with the main workspace dimmed behind it. This reflects that side chats are ephemeral, not persistent workspace elements.

Under the hood, Side Chat spawns a full PTY session -- giving it complete Claude capabilities including file reading, tool use, and multi-turn conversation.

### New Files

| File | Purpose |
|------|---------|
| `src/main/side-chat-manager.ts` | Spawn side chat PTY, context extraction from parent, lifecycle management |
| `src/main/ipc/side-chat-handlers.ts` | IPC: spawn side chat, kill side chat, get parent context |
| `src/renderer/components/panels/SideChatPane.tsx` | Overlay UI: branched-from indicator, xterm.js terminal, close button |
| `src/shared/ipc-channels.ts` | (modified) Add `SIDE_CHAT_SPAWN`, `SIDE_CHAT_KILL` channels |

### Context Injection

Before spawning Claude in the side chat PTY, inject context via the `--system-prompt` flag (or by writing a temporary `.claude/side-chat-context.md` and passing it with `--add-dir`). The context includes:

```markdown
# Side Chat Context

You are in a side chat branched from the main session. Your responses here
do not affect the main thread. The user wants to ask questions about the
current work without derailing the main session.

## Recent Activity (main session)
[Last ~100 lines of main terminal output, filtered for readability]

## Current State
- Model: claude-sonnet-4-6
- Context usage: 42%
- Working directory: /path/to/project
- Files recently modified: src/main/auth.ts, src/main/middleware.ts
```

The context injection method depends on the Claude CLI version available. Prefer `--system-prompt` if supported; fall back to temporary file (cleaned up when the side chat closes). The number of context lines is configurable in settings (default: 100).

### SSH Support

For SSH sessions, Side Chat spawns a second SSH connection using the same `sshConfig` from the parent session:
- Credentials retrieved from `credential-store.ts` (same as parent)
- Context file written to remote `~/.claude/side-chat-context.md` via the SSH session
- Same setup script and statusline shim as parent
- Context file cleaned up on close via SSH command

### Behavior

- **Ctrl+;** toggles overlay open/closed
- Overlay slides in with 200ms ease-out animation
- "Branched from [session name]" indicator in header
- Info bar: "Reading context from main session. Changes here won't affect the main thread."
- Only one side chat active per session at a time
- Closing overlay kills the side chat PTY (ephemeral -- no restore)
- Side chat does not appear in the tab bar or session list
- ESC key also closes the overlay

### Edge Cases

- If main session exits while side chat is open, show notice and keep side chat alive until user closes
- Side chat PTY uses same model as parent session by default
- Side chat sessionId format: `{parentSessionId}-sidechat-{timestamp}`
- Side chats do not count toward session metrics or tokenomics tracking for the parent session (tracked separately)

---

## Phase 3: Diff Viewer

### Problem

When Claude edits files, changes only appear as text in the terminal output. There's no structured way to review what changed, comment on specific lines, or get an overview of all modifications.

### Architecture

The Diff Viewer has two components:
1. **Main process:** File watcher (chokidar) + git diff generator
2. **Renderer:** Split-pane diff display (file list + inline diff) as a panel type

### New Files

| File | Purpose |
|------|---------|
| `src/main/file-watcher.ts` | chokidar watcher scoped to session working directory, debounced change events, git repo detection |
| `src/main/diff-generator.ts` | Runs `git diff` and `git diff --cached`, parses unified diff into structured data per file |
| `src/main/ipc/diff-handlers.ts` | IPC: get current diffs, subscribe to diff updates, submit line comments |
| `src/renderer/components/panels/DiffViewerPane.tsx` | File list sidebar + unified diff view with Catppuccin syntax highlighting |
| `src/renderer/components/panels/DiffComment.tsx` | Click-to-comment on diff lines, batch submit |

### Diff Data Model

```typescript
interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  linesAdded: number
  linesRemoved: number
  hunks: DiffHunk[]
}

interface DiffHunk {
  header: string                    // @@ -15,6 +15,18 @@
  lines: DiffLine[]
}

interface DiffLine {
  type: 'context' | 'addition' | 'removal'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
  comments?: DiffLineComment[]
}

interface DiffLineComment {
  id: string
  text: string
  timestamp: number
}
```

### File Watching

- chokidar watches the session's working directory (respects `.gitignore` via git's own filtering)
- Change events debounced at 500ms to avoid spam during rapid multi-file edits
- On change: run `git diff` and `git diff --cached`, parse output, send structured diff to renderer
- Watcher starts when session spawns in a git repo, stops on session kill
- SSH sessions: no file watcher. Instead, run `git diff` over SSH on demand (user clicks refresh in diff pane, or periodic poll every 10s while diff pane is visible)

### Behavior

- **Diff stats badge** (`+28 -5`) appears in SessionHeader when uncommitted changes exist. Click to open/focus diff pane
- **File list** on left side of pane: filename, status icon, lines added/removed. Click to view that file's diff
- **Inline diff** on right: unified diff format with Catppuccin Mocha colors (green for additions, red for removals, muted for context)
- **Line comments:** Click any diff line to open a comment input. Type feedback, press Enter to save locally. Ctrl+Enter (Cmd+Enter on Mac) submits all pending comments as a single prompt written to the Claude terminal
- **Preview button** on HTML/image files in the file list -- click to open that file in Preview pane
- **Edit button** on any file -- click to open in File Editor pane
- No git repo: pane shows "No git repository detected. Diff viewer requires a git-initialized project." with dismiss option

### Edge Cases

- Binary files shown in file list but marked as "[binary]" with no inline diff
- Large diffs (>10,000 lines total) show a warning with option to load incrementally
- Renamed files show old and new paths
- Staged vs unstaged changes shown with visual separator

---

## Phase 4: Preview Pane

### Problem

Users currently have to switch to an external browser to see the result of Claude's changes. There's no way to preview HTML files, PDFs, images, or running dev servers inline.

### Architecture

Uses Electron's `<webview>` tag with sandboxing for security. Content enters through 5 configurable triggers.

### New Files

| File | Purpose |
|------|---------|
| `src/main/preview-manager.ts` | Dev server URL detection (regex patterns for Vite, Next.js, Express, etc.), file type routing, URL validation |
| `src/main/ipc/preview-handlers.ts` | IPC: open URL, open local file, list detected servers, dismiss detection |
| `src/renderer/components/panels/PreviewPane.tsx` | Webview wrapper with URL bar, refresh, back/forward navigation, loading indicator |

### Content Invocation (5 triggers)

All triggers are configurable (on/off) in Settings > Preview Pane. All toasts auto-dismiss after 5 seconds.

1. **Auto-detect dev server URLs:** Regex patterns match common framework output (`localhost:\d+`, `127.0.0.1:\d+`) in terminal data stream. Toast: "Dev server detected at localhost:5173" with Open / Dismiss / Don't Ask Again
2. **Click file paths:** Terminal file paths (already linkified by xterm WebLinksAddon) route by extension: `.html/.pdf/.png/.jpg/.svg/.gif` open in Preview, others open in File Editor. Right-click gives choice
3. **Views menu:** Manual -- open Preview pane with URL bar for typing any URL or browsing local files
4. **From Diff Viewer:** "Preview" button appears next to HTML/image filenames in diff file list
5. **Command Bar:** Custom commands can set `target: 'preview'` to open a URL after execution

### Dev Server Detection Patterns

```typescript
const DEV_SERVER_PATTERNS = [
  /Local:\s+https?:\/\/(localhost|127\.0\.0\.1):(\d+)/,     // Vite
  /ready.*https?:\/\/(localhost|127\.0\.0\.1):(\d+)/i,       // Next.js
  /listening.*(?:on|at)\s+(?:port\s+)?(\d+)/i,               // Express/generic
  /Server running.*https?:\/\/(localhost|127\.0\.0\.1):(\d+)/ // Generic
]
```

### Behavior

- URL bar at top shows current URL, editable for manual navigation
- Refresh, back, forward buttons
- Loading spinner during page load
- Webview sandboxed: `allowpopups` disabled, `nodeintegration` disabled
- External links (non-localhost) open in system browser via `shell.openExternal` (https:// only, matching existing security restriction)
- SSH sessions: Preview pane shows "Preview requires local access. Set up SSH port forwarding to use Preview with remote sessions." with a link to documentation

### Settings

```typescript
interface PreviewSettings {
  enabled: boolean                    // master toggle
  autoDetectDevServers: boolean       // trigger 1
  clickableFilePaths: boolean         // trigger 2
  suppressedProjects: string[]        // projects where user clicked "Don't Ask Again"
}
```

---

## Phase 5: File Editor

### Problem

When Claude edits files, users have to open an external editor to make spot corrections. No way to view or edit files without leaving the app.

### Architecture

Monaco Editor (same engine as VS Code) embedded as a pane type. Provides syntax highlighting, minimap, keyboard shortcuts, and language detection for free.

### New Files

| File | Purpose |
|------|---------|
| `src/main/ipc/file-editor-handlers.ts` | IPC: read file (with path validation), write file (atomic), watch file for disk changes |
| `src/renderer/components/panels/FileEditorPane.tsx` | Monaco editor wrapper with tab bar, save/discard, disk-change warning |

### Dependencies

Add `monaco-editor` to dependencies. Use `@monaco-editor/react` for React integration (handles worker loading).

### Behavior

- **Opening files:** Click file paths in terminal output (non-preview types) or diff viewer "Edit" button
- **Tab bar** within the editor pane: multiple files open as tabs, one active at a time
- **Save:** Button or Ctrl+S writes file via IPC. Main process uses atomic write pattern (existing `config-manager.ts` pattern)
- **Discard:** Reverts to last saved state from disk
- **Disk change detection:** `fs.watch` on the open file in main process. If file changes (Claude editing it), show yellow warning bar: "File changed on disk since you opened it" with Reload from Disk / Override options
- **Path validation:** Main process validates paths to prevent directory traversal attacks. Only allow files within the session's working directory tree
- **Syntax highlighting:** Monaco auto-detects language from file extension
- **Theme:** Catppuccin Mocha theme for Monaco (custom theme definition matching our terminal theme)

### SSH Sessions

File editor for SSH sessions deferred to v2.1. Reading/writing remote files requires either:
- SFTP integration (new dependency)
- Piping through the SSH PTY (fragile)

For v2.0, clicking a file path in an SSH session shows: "File editing is available for local sessions. For SSH sessions, ask Claude to make the edit."

### Edge Cases

- Large files (>1MB): warning before loading, with option to cancel
- Binary files: show "Binary file -- cannot edit" message
- Unsaved changes on pane close: prompt "You have unsaved changes in [filename]. Save or discard?"
- File deleted while open: show error bar, disable save, allow copy content

---

## Phase 6: Git Worktree Isolation

### Problem

When running multiple sessions on the same project, they can step on each other's changes -- one session's edits appear as uncommitted changes in another session's `git status`.

### Architecture

Git worktree isolation gives each session its own working copy of the repository, on its own branch. Changes are isolated until explicitly merged.

### New Files

| File | Purpose |
|------|---------|
| `src/main/git-manager.ts` | Worktree create/list/remove, branch management, git repo detection, cleanup |
| `src/main/ipc/git-handlers.ts` | IPC: create worktree, list worktrees, remove worktree, check git status |

### Behavior

- **Opt-in per config:** Toggle in SessionDialog: "Isolate with git worktree". Disabled by default
- **On session spawn** (when enabled):
  1. Check working directory is a git repo (if not, warn and disable)
  2. Run `git worktree add .worktrees/{sessionId} -b session/{configLabel}-{shortId}`
  3. Set PTY working directory to the worktree path
  4. Inject context into session's CLAUDE.md:
     ```
     You are working in an isolated git worktree.
     Worktree path: /project/.worktrees/{sessionId}
     Parent repo: /project (branch: main)
     Your branch: session/{configLabel}-{shortId}
     When your work is complete, changes should be merged back to the parent branch.
     ```
- **On session close:** Prompt: "Delete worktree and branch?" with options:
  - **Delete** -- `git worktree remove` + `git branch -d`
  - **Keep** -- worktree persists for later use
  - **Merge and delete** -- merge branch to parent, then cleanup
- **Worktree management:** Visible in Settings page under a "Git Worktrees" section, showing all active worktrees with cleanup options
- **Toggle disabled** when working directory is not a git repo (tooltip: "Requires a git-initialized project")

### SSH Sessions

For SSH sessions with worktree isolation:
- Run `git worktree add` over the SSH PTY before starting Claude
- Working directory set to remote worktree path
- Cleanup runs over SSH on session close
- Same context injection via remote CLAUDE.md

### Edge Cases

- Worktree path uses `.worktrees/` (dot-prefixed, same pattern as Shadow Agent workspace)
- If worktree creation fails (dirty working tree, branch conflicts), fall back to normal mode with warning
- Stale worktrees (from crashed sessions) detected on app startup and offered for cleanup
- `.worktrees/` added to `.gitignore` automatically on first use

---

## Cross-Cutting Concerns

### Tips and Tour

Every phase adds:
- 1-2 entries in `src/renderer/tips-library.ts` with `postUse` power-tip variants
- 1 step in `src/renderer/components/TrainingWalkthrough.tsx` tour sequence
- Condition-based tips: e.g., "You've been switching to an external editor. Did you know you can edit files inline?" (triggered by repeated `alt-tab` patterns or manual tracking)

### Testing

Every phase adds:
- **Unit tests** (vitest) in `tests/unit/`: store logic, diff parsing, layout tree manipulation, context extraction
- **E2E tests** (Playwright) in `tests/e2e/`: pane creation, drag-and-drop, keyboard shortcuts, file operations
- Tests run on both Windows and macOS in CI
- Screenshot capture updates in `scripts/capture-training-screenshots.ts` for new pane types

### IPC Channels

All new channels added to `src/shared/ipc-channels.ts` following existing naming pattern:

```typescript
// Phase 2: Side Chat
SIDE_CHAT_SPAWN: 'side-chat:spawn',
SIDE_CHAT_KILL: 'side-chat:kill',

// Phase 3: Diff Viewer
DIFF_GET: 'diff:get',
DIFF_SUBSCRIBE: 'diff:subscribe',
DIFF_COMMENT_SUBMIT: 'diff:comment:submit',

// Phase 4: Preview
PREVIEW_OPEN_URL: 'preview:open-url',
PREVIEW_OPEN_FILE: 'preview:open-file',
PREVIEW_LIST_SERVERS: 'preview:list-servers',

// Phase 5: File Editor
FILE_READ: 'file:read',
FILE_WRITE: 'file:write',
FILE_WATCH: 'file:watch',

// Phase 6: Git Worktrees
GIT_WORKTREE_CREATE: 'git:worktree:create',
GIT_WORKTREE_LIST: 'git:worktree:list',
GIT_WORKTREE_REMOVE: 'git:worktree:remove',
GIT_STATUS: 'git:status',
```

### Settings

New settings section in SettingsPage for each feature, all with enable/disable toggles:

```typescript
interface V2Settings {
  panels: {
    defaultLayout: 'auto' | 'single' | 'side-by-side'   // 'auto' uses resolution detection
    savedLayouts: Record<string, LayoutNode>               // named layout presets
  }
  sideChat: {
    enabled: boolean
    contextLines: number           // how many lines of main session to inject (default: 100)
  }
  diffViewer: {
    enabled: boolean
    autoRefreshInterval: number    // seconds, for SSH sessions (default: 10)
    showBadge: boolean             // show +/- badge in session header
  }
  preview: {
    enabled: boolean
    autoDetectDevServers: boolean
    clickableFilePaths: boolean
    suppressedProjects: string[]
  }
  fileEditor: {
    enabled: boolean
    showMinimap: boolean
    fontSize: number
  }
  gitWorktree: {
    enabled: boolean               // global toggle (per-config opt-in still required)
    autoCleanup: boolean           // auto-delete worktrees on session close
  }
}
```

### Shadow Agent Consideration

The Shadow Agent design spec (approved, not yet implemented) should be considered for v2.1:
- Shadow Agent's working directory pattern (`.agent-workspace/`) aligns with worktree isolation (`.worktrees/`)
- Shadow Agent could consume diff data from the file watcher for cross-run analysis
- Side Chat architecture (spawning secondary PTY sessions) is a stepping stone toward Shadow Agent's managed PTY queue
- Defer Shadow Agent to v2.1 to avoid scope creep, but ensure v2.0 architecture doesn't preclude it

---

## File Impact Summary

### New Files (18)

| File | Phase |
|------|-------|
| `src/renderer/stores/panelStore.ts` | 1 |
| `src/renderer/components/panels/PanelContainer.tsx` | 1 |
| `src/renderer/components/panels/PaneHeader.tsx` | 1 |
| `src/renderer/components/panels/PaneRegistry.ts` | 1 |
| `src/main/side-chat-manager.ts` | 2 |
| `src/main/ipc/side-chat-handlers.ts` | 2 |
| `src/renderer/components/panels/SideChatPane.tsx` | 2 |
| `src/main/file-watcher.ts` | 3 |
| `src/main/diff-generator.ts` | 3 |
| `src/main/ipc/diff-handlers.ts` | 3 |
| `src/renderer/components/panels/DiffViewerPane.tsx` | 3 |
| `src/renderer/components/panels/DiffComment.tsx` | 3 |
| `src/main/preview-manager.ts` | 4 |
| `src/main/ipc/preview-handlers.ts` | 4 |
| `src/renderer/components/panels/PreviewPane.tsx` | 4 |
| `src/main/ipc/file-editor-handlers.ts` | 5 |
| `src/renderer/components/panels/FileEditorPane.tsx` | 5 |
| `src/main/git-manager.ts` | 6 |
| `src/main/ipc/git-handlers.ts` | 6 |

### Modified Files (10)

| File | Phases | Changes |
|------|--------|---------|
| `src/renderer/App.tsx` | 1, 2 | Replace fixed layout with PanelContainer; add side chat overlay |
| `src/renderer/components/SessionHeader.tsx` | 1, 3 | Add "Views" dropdown; add diff stats badge |
| `src/renderer/components/TerminalView.tsx` | 1 | Wrap as pane-compatible component |
| `src/renderer/stores/configStore.ts` | 1, 6 | Add panelLayout to TerminalConfig; add worktree toggle |
| `src/shared/types.ts` | 1-6 | Add all new types (LayoutNode, DiffFile, PreviewSettings, etc.) |
| `src/shared/ipc-channels.ts` | 2-6 | Add all new IPC channel constants |
| `src/preload/index.ts` | 2-6 | Add all new IPC bridge methods |
| `src/main/index.ts` | 2-6 | Register new IPC handlers; initialize file watcher, preview manager |
| `src/renderer/tips-library.ts` | 1-6 | Add tips for each new feature |
| `src/renderer/components/TrainingWalkthrough.tsx` | 1-6 | Add tour steps for each new feature |

### New Dependencies

| Package | Purpose | Phase |
|---------|---------|-------|
| `chokidar` | File watching for diff viewer | 3 |
| `monaco-editor` | Code editor component | 5 |
| `@monaco-editor/react` | React wrapper for Monaco | 5 |
