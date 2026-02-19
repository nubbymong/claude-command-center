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
