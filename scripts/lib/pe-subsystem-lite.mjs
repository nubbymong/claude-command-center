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

/** @returns {number|null} the raw Subsystem value, or null if this is not a PE. */
export function readPeSubsystem(buf) {
  if (buf.length < 0x40) return null
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null

  const peOffset = buf.readUInt32LE(0x3c)
  if (peOffset < 0x40 || peOffset > 1024 * 1024) return null
  if (peOffset + 0x5e > buf.length) return null

  if (buf[peOffset] !== 0x50 || buf[peOffset + 1] !== 0x45 || buf[peOffset + 2] !== 0 || buf[peOffset + 3] !== 0) return null

  const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + 0x14)
  if (sizeOfOptionalHeader < 0x46) return null

  const magic = buf.readUInt16LE(peOffset + 0x18)
  if (magic !== 0x10b && magic !== 0x20b) return null

  return buf.readUInt16LE(peOffset + 0x5c)
}
