/**
 * Read the Windows PE subsystem out of an executable (#379).
 *
 * `Subsystem = 2` (GUI) is the marker for the AttachConsole/freopen family that
 * bleeds its log over whatever TUI owns the console; `Subsystem = 3` (console)
 * is safe. See `shared/gui-exe.ts` for the mechanism and the measured matrix.
 *
 * The layout, from the PE/COFF specification:
 *
 *   0x00        'M','Z'                     DOS signature
 *   0x3C        e_lfanew (u32 LE)           file offset of the PE header
 *   e_lfanew    'P','E',0,0                 PE signature
 *   +0x04       COFF file header (20 bytes)
 *   +0x14       SizeOfOptionalHeader (u16)  (inside the COFF header)
 *   +0x18       optional header starts here
 *   +0x18+0x44  Subsystem (u16)             => e_lfanew + 0x5C
 *
 * The Subsystem field is at the SAME offset for PE32 and PE32+ even though the
 * two headers differ earlier on: PE32+ drops `BaseOfData` (-4 bytes) and widens
 * `ImageBase` from 4 to 8 bytes (+4), and the two cancel out exactly at
 * `SectionAlignment`. So one offset serves both, which is why the issue could
 * state a single `peOffset + 0x5C`.
 *
 * Parsing is split from I/O on purpose: `readPeSubsystem` takes a Buffer, so the
 * unit tests build headers byte by byte and never need a real .exe on the box
 * (there are no GUI-subsystem binaries to rely on in CI, and shipping one would
 * be worse).
 */
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import type { ExeSubsystem } from '../shared/gui-exe'

/** IMAGE_SUBSYSTEM_WINDOWS_GUI — attaches to the parent console, will bleed. */
export const PE_SUBSYSTEM_GUI = 2
/** IMAGE_SUBSYSTEM_WINDOWS_CUI — a real console program, safe. */
export const PE_SUBSYSTEM_CONSOLE = 3

/** Offset of `e_lfanew` in the DOS header. */
const E_LFANEW_OFFSET = 0x3c
/** Offset of `Subsystem` relative to the PE signature. */
const SUBSYSTEM_OFFSET = 0x5c
/** Offset of `SizeOfOptionalHeader` relative to the PE signature. */
const SIZE_OF_OPTIONAL_HEADER_OFFSET = 0x14
/** Offset of the optional header `Magic` relative to the PE signature. */
const OPTIONAL_MAGIC_OFFSET = 0x18
/** Bytes of optional header needed for `Subsystem` to exist at all
 *  (0x44 to reach the field + 2 for the field itself). */
const MIN_OPTIONAL_HEADER_SIZE = 0x46

const PE32_MAGIC = 0x10b
const PE32PLUS_MAGIC = 0x20b

/**
 * An upper bound on `e_lfanew`. The specification does not bound it, but real
 * images put the PE header within the first few hundred bytes and a DOS stub
 * that long does not exist. Bounding it stops a corrupt or hostile file from
 * asking us to read at a 4 GB offset before we have decided it is even a PE.
 */
const MAX_PE_OFFSET = 1024 * 1024

/** Enough for the DOS stub plus a PE header in every real image. */
const HEADER_WINDOW = 4096

/**
 * The raw `Subsystem` value, or null when `buf` is not a parseable PE image.
 *
 * `buf` must start at file offset 0. Every field is bounds-checked before it is
 * read: a truncated file, a script, an ELF/Mach-O binary and a deliberately
 * malformed header all return null rather than throwing.
 */
export function readPeSubsystem(buf: Buffer): number | null {
  // 'MZ'. Checked before anything else so a text file costs two comparisons.
  if (buf.length < E_LFANEW_OFFSET + 4) return null
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null

  const peOffset = buf.readUInt32LE(E_LFANEW_OFFSET)
  if (peOffset < E_LFANEW_OFFSET + 4 || peOffset > MAX_PE_OFFSET) return null

  return readPeSubsystemAt(buf, peOffset)
}

/**
 * The raw `Subsystem` value given a buffer and the offset of the PE signature
 * within it. Split out so a file whose PE header sits past the first read window
 * can be finished with a second, targeted read.
 */
export function readPeSubsystemAt(buf: Buffer, peOffset: number): number | null {
  if (!Number.isInteger(peOffset) || peOffset < 0) return null
  // Everything below reads within [peOffset, peOffset + SUBSYSTEM_OFFSET + 2).
  if (peOffset + SUBSYSTEM_OFFSET + 2 > buf.length) return null

  // 'P','E',0,0
  if (
    buf[peOffset] !== 0x50 ||
    buf[peOffset + 1] !== 0x45 ||
    buf[peOffset + 2] !== 0x00 ||
    buf[peOffset + 3] !== 0x00
  ) return null

  // An object file or a DLL-less image can have no optional header at all, and a
  // truncated one can stop before Subsystem. Trust the header's own size field
  // rather than assuming the field is there.
  const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + SIZE_OF_OPTIONAL_HEADER_OFFSET)
  if (sizeOfOptionalHeader < MIN_OPTIONAL_HEADER_SIZE) return null

  // PE32 or PE32+ only. 0x107 is a ROM image, which has a different layout and
  // no Subsystem field where we would look for it.
  const magic = buf.readUInt16LE(peOffset + OPTIONAL_MAGIC_OFFSET)
  if (magic !== PE32_MAGIC && magic !== PE32PLUS_MAGIC) return null

  return buf.readUInt16LE(peOffset + SUBSYSTEM_OFFSET)
}

/** Name the raw value. Anything that is neither GUI nor console (native driver,
 *  EFI, POSIX) is `other`: not our problem, and not to be treated as one. */
export function classifySubsystem(value: number | null): ExeSubsystem {
  if (value === null) return 'not-pe'
  if (value === PE_SUBSYSTEM_GUI) return 'gui'
  if (value === PE_SUBSYSTEM_CONSOLE) return 'console'
  return 'other'
}

/** Parse a whole-file-prefix buffer straight to a classification. */
export function classifyPeBuffer(buf: Buffer): ExeSubsystem {
  return classifySubsystem(readPeSubsystem(buf))
}

interface CacheEntry {
  mtimeMs: number
  size: number
  subsystem: ExeSubsystem
}

/** Bounded so a session that probes many paths cannot grow the map without end. */
const CACHE_MAX = 256
const cache = new Map<string, CacheEntry>()

/** Test seam: drop everything remembered about probed files. */
export function clearSubsystemCache(): void {
  cache.clear()
}

function cacheGet(key: string, mtimeMs: number, size: number): ExeSubsystem | null {
  const hit = cache.get(key)
  if (!hit) return null
  // Keyed on identity, not just path: an upgraded tool must be re-sniffed.
  if (hit.mtimeMs !== mtimeMs || hit.size !== size) {
    cache.delete(key)
    return null
  }
  return hit.subsystem
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, entry)
}

/**
 * Classify the executable at `filePath`. Reads at most two small windows of the
 * file and never executes anything. A missing, unreadable or non-PE file is
 * `not-pe` — this is a hint used to pick a launch strategy, so it fails toward
 * "treat it normally" rather than throwing at a call site that only wanted UX
 * advice.
 */
export async function sniffExecutableSubsystem(filePath: string): Promise<ExeSubsystem> {
  let handle: fsp.FileHandle | null = null
  try {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile()) return 'not-pe'

    const cached = cacheGet(filePath, stat.mtimeMs, stat.size)
    if (cached !== null) return cached

    handle = await fsp.open(filePath, 'r')
    const head = Buffer.alloc(Math.min(HEADER_WINDOW, Math.max(stat.size, 0)))
    if (head.length === 0) return 'not-pe'
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const window = head.subarray(0, bytesRead)

    let subsystem = classifyPeBuffer(window)

    // A PE header past the first window is legal (a long DOS stub, or a packer).
    // `readPeSubsystem` said not-pe only because the bytes were absent, so read
    // the header where e_lfanew points and try once more before believing it.
    if (subsystem === 'not-pe' && window.length >= E_LFANEW_OFFSET + 4 && window[0] === 0x4d && window[1] === 0x5a) {
      const peOffset = window.readUInt32LE(E_LFANEW_OFFSET)
      const end = peOffset + SUBSYSTEM_OFFSET + 2
      if (peOffset >= E_LFANEW_OFFSET + 4 && peOffset <= MAX_PE_OFFSET && end > window.length && end <= stat.size) {
        const tail = Buffer.alloc(SUBSYSTEM_OFFSET + 2)
        const read2 = await handle.read(tail, 0, tail.length, peOffset)
        subsystem = classifySubsystem(readPeSubsystemAt(tail.subarray(0, read2.bytesRead), 0))
      }
    }

    cacheSet(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, subsystem })
    return subsystem
  } catch {
    return 'not-pe'
  } finally {
    if (handle) await handle.close().catch(() => { /* already gone */ })
  }
}

/** Synchronous variant for the few call sites already inside sync code. Same
 *  contract, same cache. */
export function sniffExecutableSubsystemSync(filePath: string): ExeSubsystem {
  let fd: number | null = null
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return 'not-pe'

    const cached = cacheGet(filePath, stat.mtimeMs, stat.size)
    if (cached !== null) return cached

    fd = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(Math.min(HEADER_WINDOW, Math.max(stat.size, 0)))
    if (head.length === 0) return 'not-pe'
    const bytesRead = fs.readSync(fd, head, 0, head.length, 0)
    const subsystem = classifyPeBuffer(head.subarray(0, bytesRead))

    cacheSet(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, subsystem })
    return subsystem
  } catch {
    return 'not-pe'
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* already gone */ } }
  }
}
