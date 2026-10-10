import { shellProgram } from '../../shared/shell-program'

// The npm command that installs Claude Code, as first-run setup and the
// footer's "CLI not found" help show it for you to copy and run in a
// terminal. On Windows it names npm.cmd: in PowerShell a plain npm runs
// npm.ps1, which the default script policy refuses to load
// (shared/shell-program.ts). Pure; callers pass window.electronPlatform.
export function claudeCodeInstallCommand(platform: string | undefined): string {
  return `${shellProgram('npm', platform)} install -g @anthropic-ai/claude-code`
}
