/**
 * The file name electron-builder gives a build from a `build.*.artifactName`
 * template in package.json: `${version}`, `${ext}` and `${arch}` are
 * substituted. Null when any other macro is left, or the name holds a path
 * separator, so a caller only ever looks for a file under a plain name that
 * electron-builder could have made. The dev-only local installer lookup
 * (ipc/update-handlers.ts) and the updater tests share this one rule.
 */
export function expandArtifactName(template: string, values: { version: string; ext: string; arch: string }): string | null {
  const name = template
    .replace(/\$\{version\}/g, () => values.version)
    .replace(/\$\{ext\}/g, () => values.ext)
    .replace(/\$\{arch\}/g, () => values.arch)
  return /\$\{|[\\/]/.test(name) ? null : name
}
