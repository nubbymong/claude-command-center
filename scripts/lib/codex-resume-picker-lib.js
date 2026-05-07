// Helper module for scripts/codex-resume-picker.js. Lives in scripts/lib so
// the unit test (tests/unit/scripts/codex-resume-picker.test.ts) can require()
// these helpers without running main(). The picker script require()s this lib
// at runtime; both files are bundled together at deploy time.
//
// Self-contained Node.js, stdlib only.

const fs = require('fs')
const path = require('path')

// -- parseRollout ---------------------------------------------------
// Reads the first ~32KB head of a rollout buffer and extracts:
//   { id, cwd, model, effort?, label, mtime? }
// Returns null when the first line is malformed or session_meta is absent.
function parseRollout(text) {
  if (!text || typeof text !== 'string') return null
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) return null

  // First line must be session_meta
  let meta = null
  try {
    const first = JSON.parse(lines[0])
    if (first && first.type === 'session_meta' && first.payload) {
      meta = {
        id: String(first.payload.id || ''),
        cwd: String(first.payload.cwd || ''),
        model: String(first.payload.model || ''),
      }
    }
  } catch {
    return null
  }
  if (!meta) return null

  // Walk subsequent lines for turn_context (any position) and first user_message.
  let model = meta.model
  let effort
  let label = '(continued session)'
  let foundLabel = false

  for (let i = 1; i < lines.length; i++) {
    let evt
    try { evt = JSON.parse(lines[i]) } catch { continue }
    if (!evt || typeof evt !== 'object') continue

    if (evt.type === 'turn_context' && evt.payload) {
      if (typeof evt.payload.model === 'string' && evt.payload.model) model = evt.payload.model
      if (typeof evt.payload.effort === 'string' && evt.payload.effort) effort = evt.payload.effort
      continue
    }

    if (!foundLabel && evt.type === 'event_msg' && evt.payload && evt.payload.type === 'user_message') {
      const m = evt.payload.message
      if (typeof m === 'string' && m.trim()) {
        label = m.replace(/[\r\n]+/g, ' ').trim()
        foundLabel = true
      }
    }
  }

  return { id: meta.id, cwd: meta.cwd, model, effort, label }
}

// -- walkRollouts ---------------------------------------------------
// Walks <home>/sessions/YYYY/MM/DD/ newest-first, up to maxDays back.
// For each rollout-*.jsonl, reads first 32KB and parseRollout()s it.
// Filters to entries whose meta.cwd === cwd. Sorts by mtime desc.
// Bails after collecting 15 matches to avoid full 30-day walk.
function walkRollouts(home, maxDays, cwd) {
  const sessionsDir = path.join(home, 'sessions')
  if (!fs.existsSync(sessionsDir)) return []
  const matches = []
  const today = new Date()

  for (let dayOffset = 0; dayOffset < maxDays; dayOffset++) {
    if (matches.length >= 15) break
    const d = new Date(today.getTime() - dayOffset * 24 * 3600 * 1000)
    const y = String(d.getUTCFullYear())
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    const dayDir = path.join(sessionsDir, y, m, dd)
    if (!fs.existsSync(dayDir)) continue

    let files
    try {
      files = fs.readdirSync(dayDir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
    } catch { continue }

    // Sort newest-first within day by mtime
    const dayEntries = []
    for (const f of files) {
      const fp = path.join(dayDir, f)
      let st
      try { st = fs.statSync(fp) } catch { continue }
      dayEntries.push({ fp, mtime: st.mtimeMs })
    }
    dayEntries.sort((a, b) => b.mtime - a.mtime)

    for (const { fp, mtime } of dayEntries) {
      if (matches.length >= 15) break
      let buf
      let fd = null
      try {
        fd = fs.openSync(fp, 'r')
        const st = fs.fstatSync(fd)
        const size = Math.min(32768, st.size)
        buf = Buffer.alloc(size)
        fs.readSync(fd, buf, 0, size, 0)
      } catch { continue }
      finally {
        if (fd !== null) {
          try { fs.closeSync(fd) } catch {}
        }
      }
      const parsed = parseRollout(buf.toString('utf-8'))
      if (!parsed) continue
      if (parsed.cwd !== cwd) continue
      matches.push({ id: parsed.id, cwd: parsed.cwd, model: parsed.model, effort: parsed.effort, label: parsed.label, mtime })
    }
  }

  // Final sort across days
  matches.sort((a, b) => b.mtime - a.mtime)
  return matches.slice(0, 15)
}

// -- buildResumeArgs ------------------------------------------------
// Returns argv for `codex` (or the picker's wrapping spawn).
//   uuid != null -> ['resume', uuid, ...flags]
//   uuid == null -> [...flags] (fresh session)
function buildResumeArgs(uuid, flags) {
  if (uuid) return ['resume', uuid, ...flags]
  return [...flags]
}

// -- shouldFallback -------------------------------------------------
// Decides whether `launchCodex` should retry as a fresh `codex` session.
// Only retries when (a) we tried a `codex resume <uuid>` (resumeUuid is set)
// AND (b) the resume exited non-zero with a real status code. A null status
// means spawnSync failed to launch the process at all (e.g. ENOENT) -- no
// point retrying with a fresh session because the same binary is missing;
// caller should surface the error instead.
function shouldFallback(resumeUuid, exitStatus) {
  if (!resumeUuid) return false
  if (exitStatus === null || exitStatus === undefined) return false
  return exitStatus !== 0
}

// -- shouldUseShell -------------------------------------------------
// Decides whether spawnSync should wrap the command in cmd.exe. Mirrors
// src/main/providers/codex/spawn.ts:50-53: only wrap on win32 when the
// resolved command is a .cmd or .bat shim. A real codex.exe path needs
// no shell -- wrapping it adds quoting/injection edge cases.
function shouldUseShell(cmd, platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
}

module.exports = { parseRollout, walkRollouts, buildResumeArgs, shouldFallback, shouldUseShell }
