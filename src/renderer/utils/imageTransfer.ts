/**
 * Image transfer helper — gets a host-saved image into a Claude session.
 *
 * Local sessions: write the absolute path into the prompt. Claude's
 * built-in Read tool ingests the file directly — no extra MCP round-
 * trip, fastest path, and matches what Claude Code does when you drag
 * an image onto its CLI.
 *
 * SSH sessions: write the bare filename and ask Claude to call
 * `mcp__conductor-vision__fetch_host_screenshot`. The remote machine
 * has no access to the host filesystem, so the MCP fetch (running over
 * the auto-injected reverse tunnel) is the only way the image lands on
 * Claude's input. Vision MCP is started at app launch, so this path is
 * always available on SSH sessions even when no browser is configured.
 *
 * Both paths cap the image to 1920px / JPG q85 server-side
 * (screenshot-capture.ts) so neither saturates Claude's image-size
 * budget.
 */

/**
 * Extract the bare filename from a Windows or POSIX absolute path.
 */
function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}

/**
 * Compose the prompt that asks Claude to fetch a host screenshot via MCP.
 * The prompt is a single line so it submits cleanly when followed by \r.
 *
 * Optional `userContext` is included so Claude knows what the user wants done
 * with the image (defaults to "Please view this image.").
 */
export function composeFetchHostScreenshotPrompt(
  filename: string,
  userContext?: string
): string {
  const ctx = userContext?.trim() || 'Please view this image.'
  // Single-line prompt — Claude needs the tool name and the filename arg clearly.
  return `${ctx} (use mcp__conductor-vision__fetch_host_screenshot with filename="${filename}" to load the image from the Conductor host)`
}

/**
 * Compose a local-path prompt — writes the absolute path so Claude's
 * Read tool can ingest it directly.
 */
export function composeLocalPathPrompt(
  filePath: string,
  userContext?: string
): string {
  const ctx = userContext?.trim() || 'Please view this image.'
  return `${ctx} ${filePath}`
}

/**
 * Send a host-saved image file to a Claude session.
 *
 * @param sessionId - target Claude PTY session id
 * @param hostFilePath - absolute local path of the image file
 * @param userContext - optional context message prepended to the prompt
 * @param sessionType - 'local' uses direct path; 'ssh' uses MCP fetch.
 *                     Defaults to MCP fetch for back-compat with any caller
 *                     that doesn't yet thread the type through.
 */
export function sendImageToSession(
  sessionId: string,
  hostFilePath: string,
  userContext?: string,
  sessionType?: 'local' | 'ssh'
): void {
  const prompt = sessionType === 'local'
    ? composeLocalPathPrompt(hostFilePath, userContext)
    : composeFetchHostScreenshotPrompt(basename(hostFilePath), userContext)
  // Trailing \r submits the prompt to Claude
  window.electronAPI.pty.write(sessionId, prompt + '\r')
}

/**
 * Send multiple frames (storyboard) by writing one fetch prompt that lists all
 * filenames. Claude will call the MCP tool for each in sequence.
 *
 * @param frames - list of host-saved image absolute paths in display order
 * @param userContext - optional context describing what to do with the frames
 */
export function sendStoryboardToSession(
  sessionId: string,
  frames: string[],
  userContext?: string
): void {
  if (frames.length === 0) return
  const filenames = frames.map(basename)
  const ctx = userContext?.trim() || 'Please review these storyboard frames in order.'
  const list = filenames.map((f, i) => `${i + 1}. ${f}`).join('\n')
  // Multi-line prompt — Claude reads context, then calls fetch_host_screenshot
  // for each filename via the conductor-vision MCP server.
  const prompt = [
    ctx,
    '',
    'Frames (use mcp__conductor-vision__fetch_host_screenshot for each):',
    list,
  ].join('\n')
  // Send line by line so the PTY chunked writer doesn't fight with the heredoc-free protocol
  const lines = prompt.split('\n')
  let idx = 0
  const writeNext = () => {
    if (idx >= lines.length) {
      window.electronAPI.pty.write(sessionId, '\r')
      return
    }
    window.electronAPI.pty.write(sessionId, lines[idx] + '\n')
    idx++
    setTimeout(writeNext, 80)
  }
  writeNext()
}
