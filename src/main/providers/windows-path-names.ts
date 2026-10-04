// Windows path names as Windows itself reads them when it starts a program
// (WP2 PR 4 review, ADR-009 L3). Shared by the provider packages' PATH
// lookups and their discovery, so the file a lookup reads and discovery proves
// is the file that runs. Pure; imports nothing; no provider-specific rule.

/** A folder named as Windows names it when it starts a program from it: in a
 *  path that goes on below it, a name that ends in one dot after another
 *  character loses that dot (`C:\tools.` and `C:\tools.\bin` are `C:\tools`
 *  and `C:\tools\bin`), while a name ending in a space, or in two dots, is
 *  kept as it is spelled; a share's own two names are kept. `.` and `..`
 *  steps are folded when a candidate is joined (path.win32). Node reads every
 *  name as it is spelled, so without this a lookup would read another folder
 *  than the one a terminal runs from. */
export function windowsFolderAsRun(dir: string): string {
  const parts = dir.split(/([\\/])/)
  // A share keeps `\\server\share` as it is: parts '', sep, '', sep, server, sep, share.
  const root = /^[\\/]{2}/.test(dir) ? 7 : 1
  return parts.map((part, i) => (i < root || i % 2 === 1 ? part : part.replace(/([^.])\.$/, '$1'))).join('')
}

/** A Windows path with a folder or file name that ends in a dot or a space
 *  (`C:\tools.\app.exe`), or a `.` or `..` step. Node reads such a name as it
 *  is spelled, while Windows' own path handling, which starts the program,
 *  can drop that dot or space (a folder name's last dot; a file name's
 *  trailing dots and spaces) and reach another file, so a proof of one would
 *  not be a proof of the other. A resolved path with any such name is never
 *  proved or run (the resources folder follows the same rule, realm-folders.ts). */
export function windowsPathHasTrailingDotOrSpace(p: string): boolean {
  return p.split(/[\\/]/).slice(1).some((seg) => /[. ]$/.test(seg))
}

/** A PATH folder a lookup reads: a fully qualified folder on a drive
 *  (`C:\tools`, either slash) or on a share (`\\server\share`, two leading
 *  slashes of either kind), as a terminal reads it. One rule for both
 *  providers' PATH walks (WP2 PR 4, final review nits, L3). */
export function windowsPathFolderIsFullyQualified(dir: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+)/.test(dir)
}
