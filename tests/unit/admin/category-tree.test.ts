import { describe, expect, it } from 'vitest'
import { buildCategoryTree, parentOptions } from '@/app/admin/items/category-tree'
import type { Category } from '@/server/services/taxonomy'

const cat = (id: string, name: string, parentId: string | null, active = true): Category => ({
  id,
  name,
  parentId,
  sortOrder: 0,
  active,
})

const roofing = cat('roofing', 'Roofing', null)
const sheets = cat('sheets', 'Iron sheets', 'roofing')
const old = cat('old', 'Old stock', null, false)
const oldKid = cat('old-kid', 'Old kid', 'old')
const gone = cat('gone', 'Gone', 'roofing', false)

describe('buildCategoryTree', () => {
  const all = [roofing, sheets, old, oldKid, gone]

  it('builds two levels and leaves out inactive categories by default', () => {
    expect(buildCategoryTree(all).map((n) => [n.name, n.children.map((c) => c.name)])).toEqual([
      ['Roofing', ['Iron sheets']],
      // An inactive parent still shows when it has a visible child.
      ['Old stock', ['Old kid']],
    ])
  })

  it('keeps an inactive category that is in use', () => {
    const tree = buildCategoryTree(all, { keep: ['gone'] })
    expect(tree[0].children.map((c) => c.name)).toEqual(['Iron sheets', 'Gone'])
    expect(buildCategoryTree([roofing, old], { keep: ['old'] }).map((n) => n.name)).toEqual(['Roofing', 'Old stock'])
    expect(buildCategoryTree([roofing, old]).map((n) => n.name)).toEqual(['Roofing'])
  })

  it('ignores null keep entries and shows everything when asked', () => {
    expect(buildCategoryTree([roofing, old], { keep: [null] }).map((n) => n.name)).toEqual(['Roofing'])
    const tree = buildCategoryTree(all, { includeInactive: true })
    expect(tree.map((n) => n.name)).toEqual(['Roofing', 'Old stock'])
    expect(tree[0].children.map((c) => c.name)).toEqual(['Iron sheets', 'Gone'])
  })
})

describe('parentOptions', () => {
  const tree = buildCategoryTree([roofing, sheets, old, oldKid, cat('paint', 'Paint', null)], {
    includeInactive: true,
  })

  it('offers active top-level categories only', () => {
    expect(parentOptions(tree, null).map((p) => p.id)).toEqual(['roofing', 'paint'])
  })

  it('keeps the current parent even when inactive, marked as such', () => {
    const opts = parentOptions(tree, 'old', 'old-kid')
    expect(opts.find((p) => p.id === 'old')).toEqual({ id: 'old', name: 'Old stock (inactive)' })
    expect(opts.map((p) => p.id)).toEqual(['roofing', 'old', 'paint'])
  })

  it('leaves out the category itself', () => {
    expect(parentOptions(tree, null, 'roofing').map((p) => p.id)).toEqual(['paint'])
  })
})
