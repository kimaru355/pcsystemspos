import type { Category } from '@/server/services/taxonomy'

export type CategoryNode = { id: string; name: string; active: boolean; children: CategoryNode[] }

/**
 * Two-level tree. Inactive categories are left out unless listed in `keep` (the one an
 * item or group already uses), so a saved choice never silently disappears from its select.
 */
export function buildCategoryTree(
  categories: Category[],
  { includeInactive = false, keep = [] }: { includeInactive?: boolean; keep?: (string | null)[] } = {},
): CategoryNode[] {
  const visible = (c: Category) => includeInactive || c.active || keep.includes(c.id)
  const kids = new Map<string, CategoryNode[]>()
  for (const c of categories) {
    if (c.parentId !== null && visible(c)) {
      const list = kids.get(c.parentId) ?? []
      list.push({ id: c.id, name: c.name, active: c.active, children: [] })
      kids.set(c.parentId, list)
    }
  }
  return categories
    .filter((c) => c.parentId === null && (visible(c) || (kids.get(c.id)?.length ?? 0) > 0))
    .map((c) => ({ id: c.id, name: c.name, active: c.active, children: kids.get(c.id) ?? [] }))
}
