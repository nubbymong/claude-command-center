/**
 * Reorder among the LOOSE configs — the ones in no section and no group.
 *
 * Drag-to-reorder used to apply to every config row and splice the flat
 * `configs` array. That array is the source of order for everything, but the
 * sidebar renders it filtered into sections and groups, so dropping a loose
 * config onto a grouped one moved it in the array and changed nothing visible —
 * or changed the order INSIDE a group the user had not touched. The loose list
 * is the one place where the array order IS the visible order, so it is the
 * one place a drag can mean something.
 *
 * Pure: takes the whole config list plus which ids are loose, and returns the
 * whole list with the moved config placed at the target's position, every
 * other config — grouped, sectioned, or loose — keeping its relative place.
 * Returns null when the drop should be ignored (either end is not loose, or
 * nothing would change), so the caller can leave the store untouched.
 */
export function reorderLoose<T extends { id: string }>(
  configs: readonly T[],
  looseIds: ReadonlySet<string>,
  dragId: string,
  targetId: string,
): T[] | null {
  if (dragId === targetId) return null
  if (!looseIds.has(dragId) || !looseIds.has(targetId)) return null
  const fromIdx = configs.findIndex((c) => c.id === dragId)
  const toIdx = configs.findIndex((c) => c.id === targetId)
  if (fromIdx === -1 || toIdx === -1) return null
  const next = [...configs]
  const [moved] = next.splice(fromIdx, 1)
  next.splice(toIdx, 0, moved)
  return next
}
