import { toCsv } from './csv'
import { parseMoney, parseQty, type Cents, type Milli } from './money'
import { isWholeUnits } from './stock'
import { DEFAULT_TAX_CATEGORY, isTaxCategory, type TaxCategory } from './tax'

/*
 * CSV catalog import: format-level validation. Pure, no I/O.
 *
 * This checks the shape of the file and parses every cell (header, required values, money,
 * quantities, booleans, tax category, pack completeness, whole units, duplicates inside the
 * file, the row limit, unknown outlet codes). The item rules (lengths, floor <= price, barcode
 * format, ...) are NOT repeated here: the server runs each parsed row through the same
 * validateItemInput / validatePackInput / normalizeBarcode as the item service.
 */

export const IMPORT_COLUMNS: readonly string[] = [
  'name',
  'group',
  'category',
  'subcategory',
  'brand',
  'sku',
  'barcode',
  'base_unit',
  'fractional',
  'price',
  'floor',
  'tax_category',
  'low_stock',
  'pack1_name',
  'pack1_qty',
  'pack1_price',
  'pack1_floor',
  'pack1_barcode',
  'pack2_name',
  'pack2_qty',
  'pack2_price',
  'pack2_floor',
  'pack2_barcode',
]

export const MAX_IMPORT_ROWS = 5000

const REQUIRED_COLUMNS = ['name', 'base_unit', 'price'] as const
const PACK_NUMBERS = [1, 2] as const
const STOCK_PREFIX = 'stock_'

export type ImportPack = {
  name: string
  baseQtyMilli: Milli
  priceCents: Cents
  floorCents: Cents
  barcode: string | null
}

export type ImportRow = {
  /** File line of the row (the header is line 1). */
  line: number
  name: string
  group: string | null
  category: string | null
  subcategory: string | null
  brand: string | null
  sku: string | null
  barcode: string | null
  baseUnit: string
  fractional: boolean
  priceCents: Cents
  floorCents: Cents
  taxCategory: TaxCategory
  lowStockMilli: Milli | null
  packs: ImportPack[]
  /** Opening stock by outlet code; zero or blank cells are left out. */
  stock: Record<string, Milli>
}

export type ImportError = { line: number | null; column: string | null; message: string }

const BOOLEANS: Record<string, boolean> = {
  yes: true,
  true: true,
  '1': true,
  no: false,
  false: false,
  '0': false,
}

function parseMoneyCell(raw: string): Cents | null {
  try {
    return parseMoney(raw)
  } catch {
    return null
  }
}

function parseQtyCell(raw: string): Milli | null {
  try {
    return parseQty(raw)
  } catch {
    return null
  }
}

/**
 * Validate a parsed CSV table (header first). `outletCodes` are the codes that may appear in
 * `stock_<CODE>` columns. Rows with an error are left out of `rows`.
 * Line numbers count records, so they match file lines unless a quoted field spans lines.
 */
export function validateImport(
  table: string[][],
  outletCodes: string[],
): { rows: ImportRow[]; errors: ImportError[] } {
  const errors: ImportError[] = []
  if (table.length === 0) {
    return { rows: [], errors: [{ line: 1, column: null, message: 'The file is empty. It needs a header row.' }] }
  }

  // ---- header
  const knownCodes = new Map(outletCodes.map((c) => [c.trim().toUpperCase(), c]))
  const columnIndex = new Map<string, number>() // normalized column name -> cell index
  const stockColumns: { index: number; code: string; column: string }[] = []
  const seen = new Set<string>()
  table[0].forEach((cell, index) => {
    const name = cell.trim().toLowerCase()
    if (name === '') {
      errors.push({ line: 1, column: null, message: 'The header has an empty column name.' })
      return
    }
    if (seen.has(name)) {
      errors.push({ line: 1, column: name, message: `The column "${name}" appears more than once.` })
      return
    }
    seen.add(name)
    if (IMPORT_COLUMNS.includes(name)) {
      columnIndex.set(name, index)
    } else if (name.startsWith(STOCK_PREFIX)) {
      const code = name.slice(STOCK_PREFIX.length).toUpperCase()
      const known = knownCodes.get(code)
      if (known === undefined) {
        errors.push({
          line: 1,
          column: `${STOCK_PREFIX}${code}`,
          message: `"${cell.trim()}" is not an outlet code of this business, or that outlet is not active.`,
        })
      } else {
        stockColumns.push({ index, code: known, column: `${STOCK_PREFIX}${known}` })
      }
    } else {
      errors.push({ line: 1, column: name, message: `Unknown column "${cell.trim()}".` })
    }
  })
  for (const required of REQUIRED_COLUMNS) {
    if (!columnIndex.has(required)) {
      errors.push({ line: 1, column: required, message: `The "${required}" column is missing.` })
    }
  }
  if (errors.length > 0) return { rows: [], errors }

  // ---- rows
  const dataRows: { line: number; cells: string[] }[] = []
  for (let i = 1; i < table.length; i++) {
    if (table[i].every((c) => c.trim() === '')) continue
    dataRows.push({ line: i + 1, cells: table[i] })
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return {
      rows: [],
      errors: [
        {
          line: null,
          column: null,
          message: `The file has ${dataRows.length} rows; the limit is ${MAX_IMPORT_ROWS}. Split it into smaller files.`,
        },
      ],
    }
  }

  const rows: ImportRow[] = []
  const skus = new Map<string, number>() // lower-case sku -> first line
  const barcodes = new Map<string, number>() // barcode -> first line

  for (const { line, cells } of dataRows) {
    const before = errors.length
    const fail = (column: string | null, message: string) => errors.push({ line, column, message })
    const get = (column: string): string => {
      const i = columnIndex.get(column)
      return i === undefined ? '' : (cells[i] ?? '').trim()
    }
    const text = (column: string): string | null => get(column) || null

    if (cells.length > table[0].length && cells.slice(table[0].length).some((c) => c.trim() !== '')) {
      fail(null, `This row has more values than the header has columns (${table[0].length}).`)
    }

    const name = get('name')
    if (name === '') fail('name', 'Name is required.')
    const baseUnit = get('base_unit')
    if (baseUnit === '') fail('base_unit', 'Unit is required.')

    let fractional = false
    const rawFractional = get('fractional').toLowerCase()
    if (rawFractional !== '') {
      if (rawFractional in BOOLEANS) fractional = BOOLEANS[rawFractional]
      else fail('fractional', 'Fractional must be yes, no, true, false, 1 or 0.')
    }

    let priceCents: Cents = 0
    if (get('price') === '') {
      fail('price', 'Price is required.')
    } else {
      const p = parseMoneyCell(get('price'))
      if (p === null) fail('price', `"${get('price')}" is not a valid price (for example 1,250.50).`)
      else priceCents = p
    }
    let floorCents: Cents = priceCents
    if (get('floor') !== '') {
      const f = parseMoneyCell(get('floor'))
      if (f === null) fail('floor', `"${get('floor')}" is not a valid lowest price.`)
      else floorCents = f
    }

    let taxCategory: TaxCategory = DEFAULT_TAX_CATEGORY
    if (get('tax_category') !== '') {
      const t = get('tax_category').toUpperCase()
      if (isTaxCategory(t)) taxCategory = t
      else fail('tax_category', 'Tax category must be A, B, C, D or E.')
    }

    let lowStockMilli: Milli | null = null
    if (get('low_stock') !== '') {
      const q = parseQtyCell(get('low_stock'))
      if (q === null) fail('low_stock', `"${get('low_stock')}" is not a valid quantity.`)
      else if (!fractional && !isWholeUnits(q)) {
        fail('low_stock', 'The low stock level must be a whole number for this item.')
      } else lowStockMilli = q
    }

    const category = text('category')
    const subcategory = text('subcategory')
    if (subcategory !== null && category === null) {
      fail('subcategory', 'A subcategory needs a category.')
    }

    // ---- packs
    const packs: ImportPack[] = []
    for (const n of PACK_NUMBERS) {
      const col = (f: string) => `pack${n}_${f}`
      const fields = ['name', 'qty', 'price', 'floor', 'barcode'].map((f) => get(col(f)))
      if (fields.every((f) => f === '')) continue
      const [packName, packQty, packPrice, packFloor, packBarcode] = fields
      const packFailsBefore = errors.length
      if (packName === '') fail(col('name'), `Pack ${n} needs a name.`)
      let qty: Milli = 0
      if (packQty === '') {
        fail(col('qty'), `Pack ${n} needs a quantity.`)
      } else {
        const q = parseQtyCell(packQty)
        if (q === null) fail(col('qty'), `"${packQty}" is not a valid pack quantity.`)
        else if (!fractional && !isWholeUnits(q)) {
          fail(col('qty'), 'A pack of this item must hold a whole number of units.')
        } else qty = q
      }
      let price: Cents = 0
      if (packPrice === '') {
        fail(col('price'), `Pack ${n} needs a price.`)
      } else {
        const p = parseMoneyCell(packPrice)
        if (p === null) fail(col('price'), `"${packPrice}" is not a valid price.`)
        else price = p
      }
      let floor: Cents = price
      if (packFloor !== '') {
        const f = parseMoneyCell(packFloor)
        if (f === null) fail(col('floor'), `"${packFloor}" is not a valid lowest price.`)
        else floor = f
      }
      if (packName !== '' && packs.some((p) => p.name.toLowerCase() === packName.toLowerCase())) {
        fail(col('name'), 'This item already has a pack with that name.')
      }
      if (errors.length === packFailsBefore) {
        packs.push({
          name: packName,
          baseQtyMilli: qty,
          priceCents: price,
          floorCents: floor,
          barcode: packBarcode === '' ? null : packBarcode,
        })
      }
    }

    // ---- opening stock
    const stock: Record<string, Milli> = {}
    for (const sc of stockColumns) {
      const raw = (cells[sc.index] ?? '').trim()
      if (raw === '') continue
      const q = parseQtyCell(raw)
      if (q === null) fail(sc.column, `"${raw}" is not a valid stock quantity.`)
      else if (q === 0) continue
      else if (!fractional && !isWholeUnits(q)) {
        fail(sc.column, 'Opening stock must be a whole number for this item.')
      } else stock[sc.code] = q
    }

    // ---- duplicates inside the file
    const sku = text('sku')
    if (sku !== null) {
      const key = sku.toLowerCase()
      const first = skus.get(key)
      if (first !== undefined) fail('sku', `The SKU "${sku}" is already used on line ${first}.`)
      else skus.set(key, line)
    }
    const codes: { column: string; value: string }[] = []
    if (text('barcode') !== null) codes.push({ column: 'barcode', value: get('barcode') })
    for (const n of PACK_NUMBERS) {
      const v = get(`pack${n}_barcode`)
      if (v !== '') codes.push({ column: `pack${n}_barcode`, value: v })
    }
    for (const { column, value } of codes) {
      const first = barcodes.get(value)
      if (first !== undefined) {
        fail(column, `The barcode "${value}" is already used on line ${first}.`)
      } else barcodes.set(value, line)
    }

    if (errors.length === before) {
      rows.push({
        line,
        name,
        group: text('group'),
        category,
        subcategory,
        brand: text('brand'),
        sku,
        barcode: text('barcode'),
        baseUnit,
        fractional,
        priceCents,
        floorCents,
        taxCategory,
        lowStockMilli,
        packs,
        stock,
      })
    }
  }
  return { rows, errors }
}

/** The downloadable template: the header (with one stock column per outlet) and one example row. */
export function importTemplateCsv(outletCodes: string[]): string {
  const header = [...IMPORT_COLUMNS, ...outletCodes.map((c) => `${STOCK_PREFIX}${c}`)]
  const example: Record<string, string> = {
    name: 'Iron sheet 30G 3m',
    category: 'Roofing',
    subcategory: 'Iron sheets',
    brand: 'Mabati',
    sku: 'IS-30G-3M',
    base_unit: 'sheet',
    fractional: 'no',
    price: '950',
    floor: '900',
    tax_category: 'B',
    low_stock: '10',
    pack1_name: 'Bundle',
    pack1_qty: '20',
    pack1_price: '18,000',
    pack1_floor: '17,500',
  }
  const row = header.map((h) => example[h] ?? '')
  return toCsv([header, row])
}
