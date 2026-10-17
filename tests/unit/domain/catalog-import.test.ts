import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/domain/csv'
import {
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  importTemplateCsv,
  validateImport,
} from '@/domain/catalog-import'

const HEADER = ['name', 'base_unit', 'price', 'sku', 'fractional', 'stock_KTL']
const CODES = ['KTL', 'ELD']

function table(...rows: string[][]): string[][] {
  return [HEADER, ...rows]
}

describe('IMPORT_COLUMNS', () => {
  it('lists the columns in the documented order', () => {
    expect(IMPORT_COLUMNS.join(',')).toBe(
      'name,group,category,subcategory,brand,sku,barcode,base_unit,fractional,price,floor,tax_category,low_stock,' +
        'pack1_name,pack1_qty,pack1_price,pack1_floor,pack1_barcode,' +
        'pack2_name,pack2_qty,pack2_price,pack2_floor,pack2_barcode',
    )
    expect(MAX_IMPORT_ROWS).toBe(5000)
  })
})

describe('validateImport', () => {
  it('accepts a valid two-row table with a pack and opening stock', () => {
    const t = [
      [...IMPORT_COLUMNS, 'stock_KTL'],
      ['Iron sheet', '', 'Roofing', '', 'Brand X', 'IS-1', '111', 'sheet', 'no', '950', '900', 'B', '10',
        'Bundle', '20', '18,000', '', '222', '', '', '', '', '', '25'],
      ['Wire mesh', '', '', '', '', 'WM-1', '', 'm', 'yes', '200.50', '', '', '', '', '', '', '', '',
        '', '', '', '', '', '2.5'],
    ]
    const r = validateImport(t, CODES)
    expect(r.errors).toEqual([])
    expect(r.rows).toHaveLength(2)
    const [a, b] = r.rows
    expect(a).toMatchObject({
      line: 2,
      name: 'Iron sheet',
      group: null,
      category: 'Roofing',
      subcategory: null,
      brand: 'Brand X',
      sku: 'IS-1',
      barcode: '111',
      baseUnit: 'sheet',
      fractional: false,
      priceCents: 95000,
      floorCents: 90000,
      taxCategory: 'B',
      lowStockMilli: 10000,
    })
    expect(a.packs).toEqual([
      { name: 'Bundle', baseQtyMilli: 20000, priceCents: 1800000, floorCents: 1800000, barcode: '222' },
    ])
    expect(a.stock).toEqual({ KTL: 25000 })
    expect(b).toMatchObject({ line: 3, fractional: true, priceCents: 20050, floorCents: 20050, taxCategory: 'B' })
    expect(b.stock).toEqual({ KTL: 2500 })
  })

  it('matches columns case-insensitively and trims header cells', () => {
    const r = validateImport([[' Name ', 'BASE_UNIT', 'Price', 'Stock_ktl'], ['x', 'pc', '1', '3']], CODES)
    expect(r.errors).toEqual([])
    expect(r.rows[0].stock).toEqual({ KTL: 3000 })
  })

  it('reports a duplicate SKU on the later line, case-insensitively', () => {
    const r = validateImport(table(['A', 'pc', '1', 'S1', '', ''], ['B', 'pc', '1', 's1', '', '']), CODES)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ line: 3, column: 'sku' })
    expect(r.rows).toHaveLength(1)
  })

  it('reports a duplicate barcode across item and pack columns', () => {
    const t = [
      ['name', 'base_unit', 'price', 'barcode', 'pack1_name', 'pack1_qty', 'pack1_price', 'pack1_barcode'],
      ['A', 'pc', '1', '999', '', '', '', ''],
      ['B', 'pc', '1', '', 'Box', '6', '5', '999'],
    ]
    const r = validateImport(t, CODES)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ line: 3, column: 'pack1_barcode' })
  })

  it('reports an unknown column on line 1', () => {
    const r = validateImport([[...HEADER, 'colour'], ['A', 'pc', '1', '', '', '', 'red']], CODES)
    expect(r.errors).toContainEqual(expect.objectContaining({ line: 1, column: 'colour' }))
    expect(r.rows).toEqual([])
  })

  it('reports a stock column for an unknown outlet code', () => {
    const r = validateImport([[...HEADER, 'stock_XYZ'], ['A', 'pc', '1', '', '', '', '']], CODES)
    expect(r.errors).toContainEqual(expect.objectContaining({ line: 1, column: 'stock_XYZ' }))
  })

  it('reports an invalid price', () => {
    const r = validateImport(table(['A', 'pc', 'abc', '', '', '']), CODES)
    expect(r.errors).toEqual([expect.objectContaining({ line: 2, column: 'price' })])
  })

  it('refuses fractional stock for a non-fractional item but accepts it for a fractional one', () => {
    const r = validateImport(table(['A', 'pc', '1', '', 'no', '2.5'], ['B', 'm', '1', '', 'yes', '2.5']), CODES)
    expect(r.errors).toEqual([expect.objectContaining({ line: 2, column: 'stock_KTL' })])
    expect(r.rows.map((x) => x.name)).toEqual(['B'])
  })

  it('treats blank and 0 stock as none', () => {
    const r = validateImport(table(['A', 'pc', '1', '', '', ''], ['B', 'pc', '1', '', '', '0']), CODES)
    expect(r.errors).toEqual([])
    expect(r.rows.map((x) => x.stock)).toEqual([{}, {}])
  })

  it('allows exactly the maximum number of rows but not one more', () => {
    const mk = (n: number) =>
      table(...Array.from({ length: n }, (_, i) => [`I${i}`, 'pc', '1', `S${i}`, '', '']))
    expect(validateImport(mk(MAX_IMPORT_ROWS), CODES).errors).toEqual([])
    const r = validateImport(mk(5001), CODES)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].line).toBeNull()
  })

  it('reports a missing required column', () => {
    const r = validateImport([['base_unit', 'price'], ['pc', '1']], CODES)
    expect(r.errors).toContainEqual(expect.objectContaining({ line: 1, column: 'name' }))
  })

  it('reports an empty file and a repeated column', () => {
    expect(validateImport([], CODES).errors).toHaveLength(1)
    const r = validateImport([['name', 'name', 'base_unit', 'price']], CODES)
    expect(r.errors).toContainEqual(expect.objectContaining({ line: 1, column: 'name' }))
  })

  it('reports an unparseable fractional value', () => {
    const r = validateImport(table(['A', 'pc', '1', '', 'maybe', '']), CODES)
    expect(r.errors).toEqual([expect.objectContaining({ line: 2, column: 'fractional' })])
  })

  it('accepts every documented fractional spelling', () => {
    const values = ['yes', 'No', 'TRUE', 'false', '1', '0', '']
    const r = validateImport(table(...values.map((v, i) => [`I${i}`, 'pc', '1', '', v, ''])), CODES)
    expect(r.errors).toEqual([])
    expect(r.rows.map((x) => x.fractional)).toEqual([true, false, true, false, true, false, false])
  })

  it('reports missing required values', () => {
    const r = validateImport(table(['', 'pc', '1', '', '', ''], ['B', '', '1', '', '', ''], ['C', 'pc', '', '', '', '']), CODES)
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [2, 'name'],
      [3, 'base_unit'],
      [4, 'price'],
    ])
  })

  it('validates tax category, floor and low stock values', () => {
    const t = [
      ['name', 'base_unit', 'price', 'floor', 'tax_category', 'low_stock'],
      ['A', 'pc', '10', '', 'e', ''],
      ['B', 'pc', '10', '', 'Z', ''],
      ['C', 'pc', '10', 'x', '', ''],
      ['D', 'pc', '10', '', '', '2.5'],
    ]
    const r = validateImport(t, CODES)
    expect(r.rows[0]).toMatchObject({ taxCategory: 'E', floorCents: 1000 })
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [3, 'tax_category'],
      [4, 'floor'],
      [5, 'low_stock'],
    ])
  })

  it('requires subcategory to have a category', () => {
    const t = [
      ['name', 'base_unit', 'price', 'category', 'subcategory'],
      ['A', 'pc', '1', '', 'Sheets'],
      ['B', 'pc', '1', 'Roofing', 'Sheets'],
    ]
    const r = validateImport(t, CODES)
    expect(r.errors).toEqual([expect.objectContaining({ line: 2, column: 'subcategory' })])
    expect(r.rows[0]).toMatchObject({ category: 'Roofing', subcategory: 'Sheets' })
  })

  it('requires a complete pack and whole pack sizes for non-fractional items', () => {
    const t = [
      ['name', 'base_unit', 'price', 'fractional', 'pack1_name', 'pack1_qty', 'pack1_price', 'pack2_name', 'pack2_qty', 'pack2_price', 'pack2_floor'],
      ['A', 'pc', '1', '', 'Box', '', '5', '', '', '', ''],
      ['B', 'pc', '1', '', 'Box', '2.5', '5', '', '', '', ''],
      ['C', 'm', '1', 'yes', 'Roll', '2.5', '5', 'Big', '10', '9', '8'],
      ['D', 'pc', '1', '', '', '', '', '', '', '', '7'],
      ['E', 'pc', '1', '', 'Box', '6', 'x', '', '', '', ''],
    ]
    const r = validateImport(t, CODES)
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [2, 'pack1_qty'],
      [3, 'pack1_qty'],
      [5, 'pack2_name'],
      [5, 'pack2_qty'],
      [5, 'pack2_price'],
      [6, 'pack1_price'],
    ])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].packs).toEqual([
      { name: 'Roll', baseQtyMilli: 2500, priceCents: 500, floorCents: 500, barcode: null },
      { name: 'Big', baseQtyMilli: 10000, priceCents: 900, floorCents: 800, barcode: null },
    ])
  })

  it('refuses two packs of one item with the same name', () => {
    const t = [
      ['name', 'base_unit', 'price', 'pack1_name', 'pack1_qty', 'pack1_price', 'pack2_name', 'pack2_qty', 'pack2_price'],
      ['A', 'pc', '1', 'Box', '6', '5', 'box', '12', '9'],
    ]
    expect(validateImport(t, CODES).errors).toEqual([expect.objectContaining({ line: 2, column: 'pack2_name' })])
  })

  it('skips blank rows but keeps line numbers', () => {
    const r = validateImport(table(['A', 'pc', '1', '', '', ''], [''], ['B', 'pc', 'bad', '', '', '']), CODES)
    expect(r.rows).toHaveLength(1)
    expect(r.errors).toEqual([expect.objectContaining({ line: 4, column: 'price' })])
  })

  it('reports a row with more values than columns', () => {
    const r = validateImport(table(['A', 'pc', '1', '', '', '', 'extra']), CODES)
    expect(r.errors).toEqual([expect.objectContaining({ line: 2 })])
  })

  it('stores group, brand and trims values', () => {
    const t = [
      ['name', 'base_unit', 'price', 'group', 'brand'],
      ['  A  ', ' pc ', ' 1 ', ' Sheets ', ' Acme '],
    ]
    const r = validateImport(t, CODES)
    expect(r.rows[0]).toMatchObject({ name: 'A', baseUnit: 'pc', group: 'Sheets', brand: 'Acme' })
  })
})

describe('importTemplateCsv', () => {
  it('is a header plus one example row that validates cleanly', () => {
    const t = parseCsv(importTemplateCsv(CODES))
    expect(t).toHaveLength(2)
    expect(t[0]).toEqual([...IMPORT_COLUMNS, 'stock_KTL', 'stock_ELD'])
    expect(t[1][0]).toBe('Iron sheet 30G 3m')
    const r = validateImport(t, CODES)
    expect(r.errors).toEqual([])
    expect(r.rows[0].packs[0]).toMatchObject({ name: 'Bundle', baseQtyMilli: 20000, priceCents: 1800000 })
    expect(r.rows[0].priceCents).toBe(95000)
  })
})
