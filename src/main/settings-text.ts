// How a settings file's BYTES become the text the classifier and the sanitiser
// parse -- mirrored from the Claude CLI, because a file the CLI can read and
// this app cannot is a file the gate reports as clean while the CLI applies it.
//
// Measured on the pinned Claude Code 2.1.278 (win32-x64) read path: the reader
// sniffs the first bytes and decodes `FF FE` as UTF-16LE, everything else as
// UTF-8 (a UTF-8 BOM `EF BB BF` selects UTF-8 too); the settings parser then
// drops a leading U+FEFF and hands the rest to a strict `JSON.parse` -- no
// comments, no trailing commas. Before this helper the gate decoded every file
// as UTF-8 and parsed it as it stood, so a settings file written with a BOM
// (Notepad's default for years) or as UTF-16 parsed as nothing at all and was
// reported CLEAN, with its credential helper intact for the CLI to read
// (adversarial review, design lens). The parser's tolerance was UNVERIFIED in
// the round before; it is verified now, and it is exactly this.
import { stripLeadingBom } from '../shared/providers'

/** The text of a settings file, decoded the way the CLI decodes it. `length`
 *  bounds the bytes read from `bytes` (the readers hand over a fixed buffer
 *  larger than the file). A leading byte-order mark selects the encoding and
 *  is removed from the text. */
export function decodeSettingsText(bytes: Buffer, length: number): string {
  const encoding = length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8'
  return stripLeadingBom(bytes.toString(encoding, 0, length))
}
