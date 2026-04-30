// Detects whether a chunk of PTY output came from Codex's TUI rendering loop
// (vs a shell prompt, banner text, or pre-render initialisation).
//
// Codex CLI is a Rust app built on crossterm. It enables synchronized-output
// mode (BEDA mode 2026) and focus tracking (mode 1004) when its TUI screen
// initialises, and re-emits the synchronized-output toggle on every render
// frame. Plain shells (bash, zsh, cmd, powershell) do not emit either mode,
// so the presence of these escape sequences is a reliable Codex-TUI signal.
//
// Pinned against tests/fixtures/codex/tui-trace.txt (codex 0.125.0 on Windows).
export function detectCodexUi(data: string): boolean {
  return /\x1b\[\?(?:2026|1004)[hl]/.test(data)
}
