// ONE rule for "text a page wrote that a human will read", in one place.
//
// Two sides of the canvas pipeline have to agree about this text CHARACTER FOR
// CHARACTER, because the anchoring in spec §4 re-finds an element by comparing
// strings for exact equality:
//
//   · the CONTENT side (src/main/canvas/bridge/*, injected into the canvas page)
//     computes an element's role, accessible name and ancestor path, mints them
//     into a fingerprint, and later recomputes them to decide whether a stored
//     fingerprint still matches a live element;
//   · the HOST side (src/renderer/utils/canvas-geometry-guard.ts) cleans and
//     bounds whatever the page reports before it is STORED, and then checks a
//     later resolution reply against the anchor it holds.
//
// So the host cleaning a string the content side did not is not a cosmetic
// difference — it is a permanent re-anchoring failure. It shipped exactly that
// way: the host began stripping the format class while the content side only
// collapsed whitespace, and every element whose accessible name held an emoji
// ZWJ sequence, a Persian ZWNJ, a bidi isolate or a zero-width space stopped
// re-anchoring on EVERY re-render although it was present and unchanged — the
// resolution checklist said "needs re-pointing" forever (adversarial re-attack,
// 2026-08-15). Two cleaners that must agree while only one is maintained is
// this pipeline's recurring bug, so there is now only one.
//
// This module is imported by BOTH: the renderer bundles it normally, and the
// bridge's esbuild bundle inlines it the same way it already inlines
// src/shared/canvas.ts. Anything added here must therefore stay dependency-free
// and browser-safe.

/**
 * The whole FORMAT class, not just C0 and DEL.
 *
 * A guard that stripped only those left every bidi override and isolate
 * standing, and those ride through into `focus.label`, the focus chip on the
 * stage, the notes panel and the `canvas_review` payload handed to the agent —
 * one right-to-left override reverses the rest of the line, so the reviewer
 * reads a label that is not what was stored and the agent is sent one thing
 * while a person is shown another (adversarial review, 2026-08-15).
 *
 * Cc is C0, C1 and DEL; Cf is the bidi family (overrides, embeddings and
 * isolates), the zero-width space and joiners, the Arabic letter mark and the
 * byte-order mark; Zl/Zp are the two line separators a single-line chip cannot
 * survive. The same expression `canvas-snapshot-serialize.ts` uses on the
 * strings it puts on the wire. (The `u` flag is fine at this repo's ES2022
 * target; several shipped modules already depend on it.)
 *
 * Module-level and global-flagged: safe only because it is used with
 * `String.prototype.replace`, which resets `lastIndex` — never call `.test()`
 * on it.
 */
const FORMAT_CONTROLS_G = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Longest role/name either side keeps. */
export const CANVAS_TEXT_MAX = 120
/** Longest ancestor path / ux-id either side keeps. */
export const CANVAS_PATH_MAX = 512

/**
 * Shed the format class. Nothing else — no case folding, no NFKC, no trimming:
 * the two sides must produce the same bytes, so every transform in here has to
 * be one both of them can run over an arbitrary DOM string.
 */
export function stripFormatControls(value: string): string {
  return value.replace(FORMAT_CONTROLS_G, '')
}

/**
 * A page-authored string as BOTH sides keep it: format class shed, length
 * bounded, non-strings flattened to empty.
 *
 * The cap is part of the rule, not a separate concern. A host that truncated a
 * 5,000-character `role="…"` to 120 while the content side compared the whole
 * thing diverges exactly as the strip did, so the two travel together.
 */
export function canvasPageText(value: unknown, max: number): string {
  return typeof value === 'string' ? stripFormatControls(value).slice(0, max) : ''
}
