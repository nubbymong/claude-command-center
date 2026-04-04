export interface TrainingStep {
  id: string
  title: string
  sinceVersion: string
  bullets: string[]
  screenshotFilename: string
}

export const trainingSteps: TrainingStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Claude Command Center',
    sinceVersion: '1.0.0',
    bullets: [
      '**Multi-session orchestrator** for Claude Code terminals',
      'Run multiple Claude agents side-by-side with independent contexts',
      'Monitor token usage, costs, and rate limits across all sessions',
      'Everything you need to manage Claude at scale, in one window',
    ],
    screenshotFilename: 'step-welcome.jpg',
  },
  {
    id: 'terminal-configs',
    title: 'Terminal Configs',
    sinceVersion: '1.0.0',
    bullets: [
      'Press **Ctrl+T** to create a new terminal from any config',
      'Organize configs into **groups and sections** for quick access',
      'Set working directories, models, and custom prompts per config',
      'Connect to remote machines via **SSH** with full Claude support',
    ],
    screenshotFilename: 'step-terminal-configs.jpg',
  },
  {
    id: 'sessions',
    title: 'Sessions & Terminal',
    sinceVersion: '1.0.0',
    bullets: [
      'Each tab is an independent Claude Code session with its own context',
      '**Status indicators** show idle, busy, and error states at a glance',
      'The **context bar** displays real-time token usage and model info',
      'Sessions are saved and restored automatically across restarts',
    ],
    screenshotFilename: 'step-sessions.jpg',
  },
  {
    id: 'commands',
    title: 'Quick Commands',
    sinceVersion: '1.0.0',
    bullets: [
      'Create reusable **prompt buttons** that paste into any session',
      'Commands can be **global** or scoped to specific terminal configs',
      'Use variables like **{clipboard}** and **{selection}** in prompts',
      'Access commands from the sidebar or with keyboard shortcuts',
    ],
    screenshotFilename: 'step-commands.jpg',
  },
  {
    id: 'agent-hub',
    title: 'Agent Hub',
    sinceVersion: '1.0.0',
    bullets: [
      '**Cloud agents** run headless Claude sessions in the background',
      'Browse and install agents from the **agent library**',
      '**Agent Teams** orchestrate multi-agent pipelines with dependencies',
      'Monitor all running agents from a single dashboard',
    ],
    screenshotFilename: 'step-agent-hub.jpg',
  },
  {
    id: 'statusline',
    title: 'Statusline Metrics',
    sinceVersion: '1.0.0',
    bullets: [
      'Live **token count** and **context window** usage per session',
      'Track **API cost estimates** and **lines changed** in real time',
      '**Rate limit bars** show 5-hour and 7-day usage at a glance',
      'Fully customizable — toggle each metric in Settings > Status Line',
    ],
    screenshotFilename: 'step-statusline.jpg',
  },
  {
    id: 'tips',
    title: 'Tips & Shortcuts',
    sinceVersion: '1.0.0',
    bullets: [
      '**Ctrl+Tab** / **Ctrl+Shift+Tab** to cycle between sessions',
      '**Ctrl+1-9** to jump directly to a session by number',
      'Check **Settings** to customize fonts, shortcuts, and status line',
      'Visit **Insights** for cross-session analytics and trends',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'vision',
    title: 'Vision System',
    sinceVersion: '1.2.144',
    bullets: [
      '**Browser automation** via a global MCP server — all sessions share one browser',
      'Click the **eye icon** in the sidebar to configure and start vision',
      '17 vision tools available to Claude: **screenshot, navigate, click, type** and more',
      'Works over **SSH** too — reverse tunnels connect remote sessions automatically',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'tokenomics',
    title: 'Tokenomics',
    sinceVersion: '1.2.144',
    bullets: [
      'Track **token usage and costs** across all your Claude Code sessions',
      'Parses JSONL transcript files for **historical usage data**',
      'See **daily aggregates**, burn rate, and cost breakdown **by model**',
      'Monitor **rate limits** and extra spend from the Anthropic API',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'memory-visualiser',
    title: 'Memory Visualiser',
    sinceVersion: '1.2.152',
    bullets: [
      'Browse Claude Code **auto-memory** files across all your projects',
      'Click the **brain icon** in the sidebar to explore memory',
      'Drill down: **project cards** > **type groups** > individual memories',
      '**Search** across all memories, view rendered markdown, delete stale entries',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'command-args',
    title: 'Command Arguments',
    sinceVersion: '1.2.152',
    bullets: [
      'Command buttons now separate **base command** from **arguments**',
      'Normal click runs with **default arguments** — no modal needed',
      '**Ctrl+click** any command button to customize arguments before running',
      'Organize buttons into **named sections** — drag to reorder',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'storyboard',
    title: 'Storyboard Capture',
    sinceVersion: '1.2.152',
    bullets: [
      'Record a **sequence of screenshots** at a set interval (1-5 seconds)',
      'Click **Storyboard** in the command bar, select a screen region, and record',
      'Review captured frames: **annotate each**, select/deselect, add context text',
      'Sends a **structured prompt** with numbered frames to Claude',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'session-options',
    title: 'Session Options',
    sinceVersion: '1.2.152',
    bullets: [
      'Set **effort level** per session (Low/Medium/High) to control thinking depth',
      'Enable **flicker-free rendering** for reduced terminal flicker',
      'Enable **PowerShell tool** for native Windows commands (preview)',
      'Disable **auto-memory** to prevent Claude writing to ~/.claude/memory/',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'security',
    title: 'Security & Updates',
    sinceVersion: '1.2.155',
    bullets: [
      '**Sandbox enabled** — renderer runs in a sandboxed process',
      'SSH passwords are **resolved in the main process** — never visible to the UI',
      'Choose **Stable or Beta** update channel in Settings',
      'All IPC calls are **validated with zod** schemas at the boundary',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
]

/** Returns the highest sinceVersion across all training steps */
export function currentTrainingVersion(): string {
  let max = '0.0.0'
  for (const step of trainingSteps) {
    if (compareVersions(step.sinceVersion, max) > 0) {
      max = step.sinceVersion
    }
  }
  return max
}

/** Returns steps added after the given version, or all if no version provided */
export function getNewSteps(lastVersion?: string): TrainingStep[] {
  if (!lastVersion) return trainingSteps
  return trainingSteps.filter(
    (step) => compareVersions(step.sinceVersion, lastVersion) > 0
  )
}

/** Compare two semver strings: returns >0 if a > b, <0 if a < b, 0 if equal */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
