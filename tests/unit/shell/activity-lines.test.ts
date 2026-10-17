import { describe, expect, it } from 'vitest'
import { toConfirmation, type Names } from '@/app/admin/activity-lines'
import type { ActivityEntry } from '@/server/services/activity'

const names: Names = {
  outlets: new Map([['o1', { code: 'KTL', name: 'Kitale' }]]),
  staff: new Map([['m1', 'Jane Wanjiru']]),
}

function entry(partial: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'e',
    action: 'x',
    entityType: 'outlet',
    entityId: 'o1',
    data: null,
    reason: null,
    actorName: 'Olivia Owner',
    at: new Date('2026-10-17T07:00:00Z'),
    ...partial,
  }
}

describe('toConfirmation', () => {
  it('leads an outlet event with the outlet code', () => {
    const c = toConfirmation(entry({ action: 'outlet.create', data: { name: 'Kitale', code: 'KTL', connectionMode: null } }), names)
    expect(c).toMatchObject({ code: 'KTL', status: 'Outlet opened', by: 'Olivia Owner' })
    expect(c.detail).toBe('Kitale, business default mode.')
  })

  it('describes what changed on an outlet update', () => {
    const c = toConfirmation(
      entry({
        action: 'outlet.update',
        data: { before: { name: 'Kitale', connectionMode: null, active: true }, after: { name: 'Kitale', connectionMode: 'always_online', active: false } },
      }),
      names,
    )
    expect(c.detail).toBe('Kitale: connection mode set to Always online, closed.')
    expect(c.tone).toBeUndefined()
  })

  it('uses initials for staff and never mentions the PIN itself', () => {
    const c = toConfirmation(entry({ action: 'staff.set_pin', entityType: 'membership', entityId: 'm1' }), names)
    expect(c).toMatchObject({ code: 'JW', status: 'Till PIN set', detail: 'for Jane Wanjiru.' })
  })

  it('reads a business default mode change', () => {
    const c = toConfirmation(
      entry({ action: 'business.default_mode', entityType: 'business', entityId: 'b', data: { before: 'default', after: 'full_offline' } }),
      names,
    )
    expect(c).toMatchObject({ code: 'ALL', status: 'Default mode changed' })
    expect(c.detail).toContain('Default to Full offline')
  })
  describe('catalog and stock events', () => {
    const item = (action: string, data: unknown) => entry({ action, entityType: 'item', entityId: 'i1', data })

    it('says an item was added, led by its SKU', () => {
      const c = toConfirmation(item('item.create', { name: 'Cement 50kg', sku: 'CEM-50' }), names)
      expect(c).toMatchObject({ code: 'CEM-50', status: 'Item added', detail: 'Cement 50kg.' })
    })

    it('falls back to a generic code when an item has no SKU', () => {
      const c = toConfirmation(item('item.create', { name: 'Nails', sku: null }), names)
      expect(c.code).toBe('ITEM')
    })

    it('lists what changed on an item update', () => {
      const c = toConfirmation(
        item('item.update', {
          before: { name: 'Cement', sku: 'C1', priceCents: 100, floorCents: 90, active: true },
          after: { name: 'Cement', sku: 'C1', priceCents: 120, floorCents: 90, active: true },
        }),
        names,
      )
      expect(c).toMatchObject({ code: 'C1', status: 'Item updated', detail: 'Cement: price changed.' })
    })

    it('reads deactivation and rename on an item update', () => {
      const c = toConfirmation(
        item('item.update', {
          before: { name: 'Cement', sku: null, active: true },
          after: { name: 'Cement 50kg', sku: null, active: false },
        }),
        names,
      )
      expect(c.detail).toBe('Cement 50kg: name changed, deactivated.')
    })

    it('reads pack events with a quantity', () => {
      const created = toConfirmation(
        entry({ action: 'pack.create', entityType: 'item_pack', data: { itemId: 'i1', name: 'Box of 12', baseQtyMilli: 12000 } }),
        names,
      )
      expect(created).toMatchObject({ code: 'PACK', status: 'Pack added', detail: 'Box of 12, 12 units.' })
      const updated = toConfirmation(
        entry({
          action: 'pack.update',
          entityType: 'item_pack',
          data: {
            itemId: 'i1',
            before: { name: 'Box of 12', baseQtyMilli: 12000, active: true },
            after: { name: 'Box of 12', baseQtyMilli: 12000, active: false },
          },
        }),
        names,
      )
      expect(updated).toMatchObject({ status: 'Pack updated', detail: 'Box of 12: deactivated.' })
    })

    it('leads barcode events with the barcode', () => {
      const added = toConfirmation(
        entry({ action: 'barcode.add', entityType: 'item_barcode', data: { itemId: 'i1', barcode: '6001', packId: null } }),
        names,
      )
      expect(added).toMatchObject({ code: '6001', status: 'Barcode added', detail: 'to an item.' })
      const removed = toConfirmation(
        entry({ action: 'barcode.remove', entityType: 'item_barcode', data: { itemId: 'i1', barcode: '6001', packId: 'p1' } }),
        names,
      )
      expect(removed).toMatchObject({ code: '6001', status: 'Barcode removed', detail: 'from a pack.' })
    })

    it('reads taxonomy events', () => {
      expect(
        toConfirmation(entry({ action: 'category.create', entityType: 'category', data: { name: 'Plumbing', parentId: null } }), names),
      ).toMatchObject({ code: 'CAT', status: 'Category added', detail: 'Plumbing.' })
      expect(
        toConfirmation(
          entry({
            action: 'category.update',
            entityType: 'category',
            data: { before: { name: 'Plumbing', active: true }, after: { name: 'Pipes', active: true } },
          }),
          names,
        ),
      ).toMatchObject({ status: 'Category updated', detail: 'Pipes: renamed from Plumbing.' })
      expect(
        toConfirmation(entry({ action: 'brand.create', entityType: 'brand', data: { name: 'Bamburi' } }), names),
      ).toMatchObject({ code: 'BRND', status: 'Brand added', detail: 'Bamburi.' })
      expect(
        toConfirmation(
          entry({
            action: 'brand.update',
            entityType: 'brand',
            data: { before: { name: 'Bamburi', active: true }, after: { name: 'Bamburi', active: false } },
          }),
          names,
        ),
      ).toMatchObject({ status: 'Brand updated', detail: 'Bamburi: deactivated.' })
      expect(
        toConfirmation(entry({ action: 'group.create', entityType: 'item_group', data: { name: 'Paint', attributeKeys: [] } }), names),
      ).toMatchObject({ code: 'GRP', status: 'Group added', detail: 'Paint.' })
      expect(
        toConfirmation(
          entry({
            action: 'group.update',
            entityType: 'item_group',
            data: {
              before: { name: 'Paint', attributeKeys: ['colour'], active: true },
              after: { name: 'Paint', attributeKeys: ['colour', 'size'], active: true },
            },
          }),
          names,
        ),
      ).toMatchObject({ status: 'Group updated', detail: 'Paint: attributes changed.' })
    })

    it('reads a stock adjustment with the outlet code, signed quantity and reason', () => {
      const c = toConfirmation(
        entry({
          action: 'stock.adjust',
          entityType: 'stock_movement',
          data: { outletId: 'o1', itemId: 'i1', itemName: 'Cement', baseUnit: 'bag', deltaMilli: -3000, reason: 'damaged' },
        }),
        names,
      )
      expect(c).toMatchObject({ code: 'KTL', status: 'Stock adjusted', detail: 'Cement -3 bag, damaged.' })
    })

    it('still reads an older stock adjustment that has no item name', () => {
      const c = toConfirmation(
        entry({
          action: 'stock.adjust',
          entityType: 'stock_movement',
          data: { outletId: 'o1', itemId: 'i1', deltaMilli: 2500, reason: 'count_correction' },
        }),
        names,
      )
      expect(c).toMatchObject({ code: 'KTL', status: 'Stock adjusted', detail: 'An item +2.5, count correction.' })
    })

    it('reads a catalog import summary', () => {
      const c = toConfirmation(
        entry({
          action: 'catalog.import',
          entityType: 'catalog_import',
          entityId: 'x',
          data: { itemCount: 40, packCount: 5, stockCells: 60, importId: 'x' },
        }),
        names,
      )
      expect(c).toMatchObject({ code: 'IMP', status: 'Catalog imported' })
      expect(c.detail).toBe('40 items, 5 packs, 60 opening stock entries.')
    })
  })
})
