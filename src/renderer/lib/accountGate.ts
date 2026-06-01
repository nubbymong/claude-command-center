/** Whether the forced multi-account gate should appear on this launch.
 *  - !decided  -> first install OR first launch after updating into the feature
 *    (the field is new, so existing users read undefined => the gate shows once).
 *  - decided + the global account changed while multi-account is OFF -> re-surface.
 *  - decided + multi-account ON -> never the gate (the Default chip reads live). */
export function shouldShowAccountGate(s: { decided: boolean; multiEnabled: boolean; globalChanged: boolean }): boolean {
  if (!s.decided) return true
  if (s.globalChanged && !s.multiEnabled) return true
  return false
}
