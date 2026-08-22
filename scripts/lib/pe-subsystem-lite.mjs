/**
 * The PE subsystem read, in plain ESM, for `scripts/verify-console-bleed.mjs`.
 *
 * The app's copy is `src/main/pe-subsystem.ts` and is the one that matters; this
 * exists only because the verification script runs under bare node with no
 * TypeScript build step. Keep the two in step — `tests/unit/pe-subsystem.test.ts`
 * pins the behaviour both are expressing.
 *
 * Layout: 'MZ' at 0, e_lfanew (u32 LE) at 0x3C, 'PE\0\0' there, and Subsystem
 * (u16 LE) at e_lfanew + 0x5C — the same offset for PE32 and PE32+.
 */

import * as fs from 'fs'

/** @returns {number|null} the raw Subsystem value, or null if this is not a PE. */
export function readPeSubsystem(buf) {
  if (buf.length < 0x40) return null
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null

  const peOffset = buf.readUInt32LE(0x3c)
  if (peOffset < 0x40 || peOffset > 1024 * 1024) return null

  return readPeSubsystemAt(buf, peOffset)
}

/** @returns {number|null} same, given the offset of the PE signature in `buf`. */
export function readPeSubsystemAt(buf, peOffset) {
  if (peOffset + 0x5e > buf.length) return null
  if (buf[peOffset] !== 0x50 || buf[peOffset + 1] !== 0x45 || buf[peOffset + 2] !== 0 || buf[peOffset + 3] !== 0) return null

  const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + 0x14)
  if (sizeOfOptionalHeader < 0x46) return null

  const magic = buf.readUInt16LE(peOffset + 0x18)
  if (magic !== 0x10b && magic !== 0x20b) return null

  return buf.readUInt16LE(peOffset + 0x5c)
}

/**
 * Read a file's Subsystem, following `e_lfanew` past the first window when it
 * points there. Without this second read, a binary with a long DOS stub (or a
 * packer) reads as "not a PE" and the verification aborts on exactly the class
 * of executable it exists to check. (Review MINOR-5.)
 *
 * @returns {number|null}
 */
export function readPeSubsystemOfFile(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(4096)
    const n = fs.readSync(fd, head, 0, head.length, 0)
    const window = head.subarray(0, n)

    const direct = readPeSubsystem(window)
    if (direct !== null) return direct

    if (window.length < 0x40 || window[0] !== 0x4d || window[1] !== 0x5a) return null
    const peOffset = window.readUInt32LE(0x3c)
    if (peOffset < 0x40 || peOffset > 1024 * 1024) return null
    // Already covered by the first read: it is genuinely not a PE.
    if (peOffset + 0x5e <= window.length) return null

    const tail = Buffer.alloc(0x5e)
    const n2 = fs.readSync(fd, tail, 0, tail.length, peOffset)
    return readPeSubsystemAt(tail.subarray(0, n2), 0)
  } finally {
    fs.closeSync(fd)
  }
}
