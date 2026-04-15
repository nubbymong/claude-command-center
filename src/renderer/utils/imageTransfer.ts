/**
 * Image transfer helper — sends a host-saved image to a Claude session via the
 * Conductor MCP server's fetch_host_screenshot tool.
 *
 * Why MCP for ALL sessions (not just SSH)?
 *  - One unified code path for local + SSH (no platform branching at call sites)
 *  - SSH sessions have no other reliable transport since Claude is the foreground
 *    process on the PTY (we can't shell out to scp/base64 mid-session)
 *  - The MCP server runs at app launch independent of vision/browser config, so
 *    fetch_host_screenshot is always available on both local and SSH sessions
 *    (SSH reaches it via the existing reverse tunnel)
 *  - One round-trip: Claude sees the prompt, calls the MCP tool, gets the image
 *    inline. No path-vs-base64 confusion, no file mounts, no SCP credentials.
 *
 * Trade-off vs. directly writing a local path:
 *  - Local sessions used to write a file path and Claude would read it directly
 *    via its Read tool. The MCP path adds one MCP round-trip to view the image,
 *    but in exchange the same code path works everywhere.
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
 * Send a host-saved image file to a Claude session by writing a fetch prompt.
 * The image must already exist in the Conductor host's screenshots directory.
 *
 * @param sessionId - target Claude PTY session id
 * @param hostFilePath - absolute local path of the image file
 * @param userContext - optional context message prepended to the fetch prompt
 */
export function sendImageToSession(
  sessionId: string,
  hostFilePath: string,
  userContext?: string
): void {
  const filename = basename(hostFilePath)
  const prompt = composeFetchHostScreenshotPrompt(filename, userContext)
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
