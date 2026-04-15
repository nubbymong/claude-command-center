import { BrowserWindow } from 'electron'
import * as chokidar from 'chokidar'
import { logInfo, logError } from './debug-logger'
import { getGitDiff, isGitRepo } from './diff-generator'

interface SessionWatcher {
  watcher: chokidar.FSWatcher
  cwd: string
  debounceTimer?: ReturnType<typeof setTimeout>
}

const watchers = new Map<string, SessionWatcher>()

/**
 * Start watching a session's working directory for file changes.
 * On change, runs git diff and sends structured diff data to the renderer.
 */
export async function startFileWatcher(
  win: BrowserWindow,
  sessionId: string,
  cwd: string,
): Promise<void> {
  // Don't watch if not a git repo
  const isRepo = await isGitRepo(cwd)
  if (!isRepo) {
    logInfo(`[file-watcher] Skipping ${sessionId} -- not a git repo: ${cwd}`)
    return
  }

  // Kill existing watcher for this session
  stopFileWatcher(sessionId)

  logInfo(`[file-watcher] Starting watcher for ${sessionId} in ${cwd}`)

  const watcher = chokidar.watch(cwd, {
    ignored: [
      /(^|[\/\\])\../,          // dotfiles/dirs
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.git/**',
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })

  const sessionWatcher: SessionWatcher = { watcher, cwd }
  watchers.set(sessionId, sessionWatcher)

  const sendDiffUpdate = async () => {
    if (win.isDestroyed()) return
    try {
      const diffs = await getGitDiff(cwd)
      win.webContents.send('diff:update', sessionId, diffs)
    } catch (err) {
      logError(`[file-watcher] Error getting diffs for ${sessionId}: ${err}`)
    }
  }

  // Debounce change events at 500ms
  const debouncedUpdate = () => {
    if (sessionWatcher.debounceTimer) {
      clearTimeout(sessionWatcher.debounceTimer)
    }
    sessionWatcher.debounceTimer = setTimeout(sendDiffUpdate, 500)
  }

  watcher.on('change', debouncedUpdate)
  watcher.on('add', debouncedUpdate)
  watcher.on('unlink', debouncedUpdate)

  watcher.on('error', (err) => {
    logError(`[file-watcher] Error for ${sessionId}: ${err}`)
  })

  // Send initial diff state
  await sendDiffUpdate()
}

/**
 * Stop watching a session's working directory.
 */
export function stopFileWatcher(sessionId: string): void {
  const entry = watchers.get(sessionId)
  if (entry) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.watcher.close().catch(() => {})
    watchers.delete(sessionId)
    logInfo(`[file-watcher] Stopped watcher for ${sessionId}`)
  }
}

/**
 * Stop all file watchers (called during app shutdown).
 */
export function stopAllFileWatchers(): void {
  for (const [, entry] of watchers) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.watcher.close().catch(() => {})
  }
  watchers.clear()
  logInfo('[file-watcher] All watchers stopped')
}
