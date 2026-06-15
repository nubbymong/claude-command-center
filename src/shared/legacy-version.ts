/**
 * Strict semver validation for managed ("legacy") Claude CLI versions.
 *
 * SECURITY CONTROL. A `version` string becomes both:
 *   - a filesystem path segment: <resources>/claude-versions/<version>/
 *   - a value shell-interpolated into
 *     `npm install @anthropic-ai/claude-code@<version>` (spawn with shell:true),
 *     and the resolved binary is then itself spawned.
 *
 * Strict semver guarantees the value has no path separators, no `..`, no shell
 * metacharacters, and always starts with a digit (so it can never be parsed as
 * an npm `-flag`). This single check closes the path-traversal sink in
 * legacy-version-manager AND the npm-arg / shell-interpolation injection sink.
 *
 * Mirrors the official semver.org regex, with a defensive length cap. JS `$`
 * (no `m` flag) does not match before a trailing newline, so embedded/trailing
 * newlines are rejected too.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export function isValidLegacyVersion(version: unknown): version is string {
  return typeof version === 'string' && version.length > 0 && version.length <= 64 && SEMVER.test(version)
}
