/**
 * dry-run-transcripts.ts — READ-ONLY probe of ~/.claude/projects JSONL transcript store.
 *
 * Walks every project directory, collects file metadata, then samples up to 50 JSONL
 * files (mix of largest + most recent) and builds a histogram of the entry shapes that
 * the Logs v2 normalizer must handle.  Writes NOTHING to disk.
 *
 * Usage:
 *   npx tsx scripts/dry-run-transcripts.ts [projectsDir]
 *
 * If projectsDir is omitted it defaults to <os.homedir()>/.claude/projects.
 * Output is a JSON summary to stdout.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileInfo {
  filePath: string
  project: string
  sizeBytes: number
  mtimeMs: number
}

interface Histogram {
  totalFiles: number
  totalSizeBytes: number
  filesAbove100MB: string[]
  sampledFiles: number
  sampledLines: number
  unparseableLines: number
  // entry-level breakdowns
  typeValues: Record<string, number>
  messageRoles: Record<string, number>
  contentPartTypes: Record<string, number>
  isSidechainCount: number
  missingTimestampCount: number
  peakHeapMB: number
  // concern flags — anything outside the expected normalizer surface
  concerns: string[]
  // summary of sampled file sizes
  sampleSizesBytes: number[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Increment a key in a frequency map. */
function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** Stream a JSONL file line-by-line without loading it all into memory. */
async function streamJsonl(
  filePath: string,
  onLine: (parsed: Record<string, unknown>, raw: string) => void,
  onUnparseable: (raw: string) => void,
): Promise<void> {
  const fh = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: fh, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        onLine(parsed, trimmed)
      } catch {
        onUnparseable(trimmed)
      }
    }
  } finally {
    rl.close()
    fh.destroy()
  }
}

/** Walk ~/.claude/projects, return all .jsonl file infos. */
function collectJsonlFiles(projectsDir: string): FileInfo[] {
  const results: FileInfo[] = []
  let projectDirs: string[]
  try {
    projectDirs = fs.readdirSync(projectsDir)
  } catch {
    return results
  }
  for (const proj of projectDirs) {
    const projPath = path.join(projectsDir, proj)
    let entries: string[]
    try {
      const stat = fs.statSync(projPath)
      if (!stat.isDirectory()) continue
      entries = fs.readdirSync(projPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const fullPath = path.join(projPath, entry)
      try {
        const stat = fs.statSync(fullPath)
        results.push({
          filePath: fullPath,
          project: proj,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      } catch {
        /* skip unreadable */
      }
    }
  }
  return results
}

/** Choose up to `n` files: top half by size, bottom half by recency (mtime desc). */
function pickSample(files: FileInfo[], n: number): FileInfo[] {
  if (files.length <= n) return [...files]
  const bySize = [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)
  const byRecent = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const half = Math.floor(n / 2)
  const picked = new Set<string>()
  const result: FileInfo[] = []
  for (const f of bySize) {
    if (result.length >= half) break
    if (!picked.has(f.filePath)) { picked.add(f.filePath); result.push(f) }
  }
  for (const f of byRecent) {
    if (result.length >= n) break
    if (!picked.has(f.filePath)) { picked.add(f.filePath); result.push(f) }
  }
  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const projectsDir = process.argv[2] ?? path.join(os.homedir(), '.claude', 'projects')

  console.error(`[scan] projectsDir = ${projectsDir}`)

  if (!fs.existsSync(projectsDir)) {
    console.error(`[error] directory not found: ${projectsDir}`)
    process.exit(1)
  }

  // Phase 1: collect file metadata
  console.error('[scan] collecting file metadata...')
  const allFiles = collectJsonlFiles(projectsDir)
  console.error(`[scan] found ${allFiles.length} .jsonl files`)

  const hist: Histogram = {
    totalFiles: allFiles.length,
    totalSizeBytes: allFiles.reduce((s, f) => s + f.sizeBytes, 0),
    filesAbove100MB: [],
    sampledFiles: 0,
    sampledLines: 0,
    unparseableLines: 0,
    typeValues: {},
    messageRoles: {},
    contentPartTypes: {},
    isSidechainCount: 0,
    missingTimestampCount: 0,
    peakHeapMB: 0,
    concerns: [],
    sampleSizesBytes: [],
  }

  const THRESHOLD_100MB = 100 * 1024 * 1024
  for (const f of allFiles) {
    if (f.sizeBytes > THRESHOLD_100MB) {
      hist.filesAbove100MB.push(`${f.filePath} (${(f.sizeBytes / (1024 * 1024)).toFixed(0)} MB)`)
    }
  }

  // Phase 2: sample
  const sample = pickSample(allFiles, 50)
  console.error(`[scan] sampling ${sample.length} files...`)

  let peakHeapMB = 0
  const heapTimer = setInterval(() => {
    const heapBytes = process.memoryUsage().heapUsed
    const heapMB = heapBytes / (1024 * 1024)
    if (heapMB > peakHeapMB) peakHeapMB = heapMB
  }, 200)

  for (const f of sample) {
    hist.sampledFiles++
    hist.sampleSizesBytes.push(f.sizeBytes)

    try {
      await streamJsonl(
        f.filePath,
        (entry) => {
          hist.sampledLines++

          // --- type field ---
          const entryType = typeof entry.type === 'string' ? entry.type : '(missing)'
          inc(hist.typeValues, entryType)

          // --- timestamp presence ---
          if (!entry.timestamp) {
            hist.missingTimestampCount++
          }

          // --- isSidechain ---
          if (entry.isSidechain === true) {
            hist.isSidechainCount++
          }

          // --- message role ---
          if (entry.message && typeof entry.message === 'object') {
            const msg = entry.message as Record<string, unknown>
            if (typeof msg.role === 'string') {
              inc(hist.messageRoles, msg.role)
            } else {
              inc(hist.messageRoles, '(missing)')
            }

            // --- content parts ---
            if (Array.isArray(msg.content)) {
              for (const part of msg.content as unknown[]) {
                if (part && typeof part === 'object') {
                  const p = part as Record<string, unknown>
                  const ptype = typeof p.type === 'string' ? p.type : '(missing)'
                  inc(hist.contentPartTypes, ptype)
                } else if (typeof part === 'string') {
                  inc(hist.contentPartTypes, '(raw-string)')
                }
              }
            } else if (typeof msg.content === 'string') {
              inc(hist.contentPartTypes, '(string-content)')
            }
          }
        },
        (_raw) => {
          hist.unparseableLines++
        },
      )
    } catch (err) {
      hist.concerns.push(`FILE_READ_ERROR: ${f.filePath} — ${String(err)}`)
    }

    if (hist.sampledFiles % 10 === 0 || hist.sampledFiles === sample.length) {
      const heapMB = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(0)
      console.error(
        `[scan] ${hist.sampledFiles}/${sample.length} files | ${hist.sampledLines.toLocaleString()} lines | heap ${heapMB} MB`,
      )
    }
  }

  clearInterval(heapTimer)
  hist.peakHeapMB = Math.round(peakHeapMB * 100) / 100

  // Phase 3: build concerns list
  if (hist.filesAbove100MB.length > 0) {
    hist.concerns.push(`FILES_ABOVE_100MB: ${hist.filesAbove100MB.length} file(s) exceed 100 MB — streaming is mandatory`)
  }
  if (hist.unparseableLines > 0) {
    hist.concerns.push(`UNPARSEABLE_LINES: ${hist.unparseableLines} lines could not be JSON-parsed`)
  }
  // Warn if we see type values outside the expected normalizer surface
  const expectedTypes = new Set(['user', 'assistant', 'system', 'summary', 'progress'])
  const unknownTypes = Object.keys(hist.typeValues).filter(
    (t) => !expectedTypes.has(t) && t !== '(missing)',
  )
  if (unknownTypes.length > 0) {
    hist.concerns.push(`UNKNOWN_TYPE_VALUES: ${unknownTypes.join(', ')} — normalizer must handle or classify as unknown`)
  }
  if (hist.missingTimestampCount > 0) {
    // Missing timestamps on summary/meta entries may be expected; flag for review
    hist.concerns.push(`MISSING_TIMESTAMPS: ${hist.missingTimestampCount} entries lack a timestamp field`)
  }
  if (hist.isSidechainCount > 0) {
    hist.concerns.push(`SIDECHAIN_ENTRIES: ${hist.isSidechainCount} entries with isSidechain=true (normalizer must classify separately)`)
  }
  // Content part types outside text/tool_use/tool_result
  const expectedParts = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'image', '(string-content)', '(missing)'])
  const unknownParts = Object.keys(hist.contentPartTypes).filter((p) => !expectedParts.has(p))
  if (unknownParts.length > 0) {
    hist.concerns.push(`UNKNOWN_CONTENT_PART_TYPES: ${unknownParts.join(', ')} — normalizer must handle or flag`)
  }

  // Phase 4: output
  const output = {
    scannedAt: new Date().toISOString(),
    projectsDir,
    totalFiles: hist.totalFiles,
    totalSizeMB: (hist.totalSizeBytes / (1024 * 1024)).toFixed(1),
    filesAbove100MB: hist.filesAbove100MB,
    sampledFiles: hist.sampledFiles,
    sampledLines: hist.sampledLines,
    unparseableLines: hist.unparseableLines,
    typeValues: hist.typeValues,
    messageRoles: hist.messageRoles,
    contentPartTypes: hist.contentPartTypes,
    isSidechainCount: hist.isSidechainCount,
    missingTimestampCount: hist.missingTimestampCount,
    peakHeapMB: hist.peakHeapMB,
    sampleFileSizeRange: hist.sampleSizesBytes.length
      ? {
          minBytes: hist.sampleSizesBytes.reduce((a, b) => Math.min(a, b)),
          maxBytes: hist.sampleSizesBytes.reduce((a, b) => Math.max(a, b)),
          meanBytes: Math.round(hist.sampleSizesBytes.reduce((a, b) => a + b, 0) / hist.sampleSizesBytes.length),
        }
      : null,
    concerns: hist.concerns,
  }

  console.log(JSON.stringify(output, null, 2))
}

void main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
