export interface TrainingStep {
  id: string
  title: string
  sinceVersion: string
  bullets: string[]
  screenshotFilename: string
}

export const trainingSteps: TrainingStep[] = [
  {
    id: 'session-options',
    title: 'Session Configuration',
    sinceVersion: '1.0.0',
    bullets: [
      'Create **terminal configs** with custom working directories and models',
      'Set **effort level** (Low/Medium/High) to control thinking depth and cost',
      'Enable **flicker-free rendering** and platform-specific tools per session',
      'Connect to remote machines via **SSH** with full Claude support',
    ],
    screenshotFilename: 'step-session-options.jpg',
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
    id: 'vision',
    title: 'Vision System',
    sinceVersion: '1.2.144',
    bullets: [
      '**Browser automation** via a global MCP server — all sessions share one browser',
      'Click the **eye icon** in the sidebar to configure and start vision',
      '17 vision tools available to Claude: **screenshot, navigate, click, type** and more',
      'Works over **SSH** too — reverse tunnels connect remote sessions automatically',
    ],
    screenshotFilename: 'step-vision.jpg',
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
    screenshotFilename: 'step-tokenomics.jpg',
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
    screenshotFilename: 'step-memory.jpg',
  },
  {
    id: 'settings',
    title: 'Settings & Security',
    sinceVersion: '1.2.155',
    bullets: [
      '**Sandbox enabled** — renderer runs in a sandboxed process',
      'Choose **Stable or Beta** update channel for app updates',
      'Customize **keyboard shortcuts**, terminal font size, and status line metrics',
      'All IPC calls are **validated with zod** schemas at the boundary',
    ],
    screenshotFilename: 'step-security.jpg',
  },
  {
    id: 'tips',
    title: 'Tips & Shortcuts',
    sinceVersion: '1.0.0',
    bullets: [
      '**Ctrl+Tab** / **Ctrl+Shift+Tab** to cycle between sessions',
      '**Ctrl+1-9** to jump directly to a session by number',
      'Create **quick command buttons** with customizable arguments',
      'Live **statusline** shows tokens, cost, rate limits, and peak hours',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'github-sidebar',
    title: 'GitHub Sidebar',
    sinceVersion: '1.3.2',
    bullets: [
      '**PR snapshot** for your current branch — status, CI runs, reviews, unresolved threads',
      '**Session context** infers the issue you are on from branch, transcript, or PR body',
      '**Local git state** — ahead/behind, dirty/clean, staged/unstaged — always visible',
      'Sign in via **OAuth**, PAT, or adopt your existing **gh CLI** auth. Per-session opt-in',
    ],
    screenshotFilename: 'step-github-sidebar.jpg',
  },
  {
    id: 'hooks-gateway',
    title: 'Live Activity & Hooks',
    sinceVersion: '1.3.2',
    bullets: [
      '**Live Activity feed** on each session shows a real-time timeline of Claude hook events',
      '**Pause/Resume** and **type filters** let you focus on what matters — tools, notifications, lifecycle',
      'Loopback-only **HTTP hooks gateway** on 127.0.0.1 — per-session UUID secrets, no telemetry',
      'SSH sessions **auto reverse-tunnel** the gateway port so remote events flow back seamlessly',
    ],
    screenshotFilename: 'step-hooks-gateway.jpg',
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
