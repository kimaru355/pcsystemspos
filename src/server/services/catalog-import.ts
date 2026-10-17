import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import { auditLog, brands, categories, itemBarcodes, itemGroups, items, outlets } from '@/db/schema'
import { validateImport, type ImportError, type ImportRow } from '@/domain/catalog-import'
import { parseCsv } from '@/domain/csv'
import { isUniqueViolation } from '@/server/db-errors'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'
import {
  insertBarcodeTx,
  insertItemTx,
  insertPackTx,
  normalizeBarcode,
  validateItemInput,
  validatePackInput,
  type ValidItem,
  type ValidPack,
} from './items'
import { applyMovement } from './stock'
import {
  findOrCreateBrandTx,
  findOrCreateCategoryTx,
  findOrCreateGroupTx,
  validateBrandInput,
  validateCategoryInput,
  validateGroupInput,
} from './taxonomy'

/*
 * CSV catalog import (create-only): preview, then apply in one transaction.
 *
 * Rule sharing: `validateImport` (pure, src/domain) checks the file's format. Each parsed row is
 * then run through the item service's own validateItemInput / validatePackInput /
 * normalizeBarcode, so there is a single rule set; a DomainError from those becomes an
 * ImportError on the row's line. Database checks (existing SKUs and barcodes) are added here.
 * `applyImport` re-runs the whole plan inside its transaction and writes nothing on any error.
 */

export type ImportPreview = {
  /** Rows that passed every check. */
  rowCount: number
  itemCount: number
  packCount: number
  /** Top-level names, or "Parent > Child" for a subcategory, that would be created. */
  newCategories: string[]
  newBrands: string[]
  newGroups: string[]
  /** Non-zero opening-stock cells. */
  stockCells: number
  errors: ImportError[]
  /** ISO time of the most recent import of this same file (by content hash) in this business. */
  alreadyImportedAt: string | null
  /** Row item names that already exist in the business (case-insensitive), as spelled in the file; at most 20. */
  existingNames: string[]
}

export type ImportResult = { itemCount: number; packCount: number; stockCells: number }

const MAX_TEXT_CHARS = 2_000_000
const MAX_EXISTING_NAMES = 20
const IN_CHUNK = 1000
const OPENING_STOCK_NOTE = 'Opening stock'

/** sha256 hex of the CSV text with CRLF normalised to LF and trailing whitespace trimmed. */
function fileHashOf(csvText: string): string {
  return createHash('sha256').update(csvText.replace(/\r\n/g, '\n').trimEnd()).digest('hex')
}

type PlannedPack = ValidPack & { barcode: string | null }
type PlannedRow = {
  row: ImportRow
  item: ValidItem
  barcode: string | null
  packs: PlannedPack[]
}
type Plan = {
  preview: ImportPreview
  planned: PlannedRow[]
  outletIds: Map<string, string>
  fileHash: string
}

// ------------------------------------------------------------------ row rules

/** Best-effort column for a message from the item service's validators. */
function itemColumn(message: string): string | null {
  const m = message.toLowerCase()
  if (m.startsWith('name')) return 'name'
  if (m.startsWith('unit')) return 'base_unit'
  if (m.includes('lowest price')) return 'floor'
  if (m.startsWith('price')) return 'price'
  if (m.startsWith('sku')) return 'sku'
  if (m.includes('low stock')) return 'low_stock'
  if (m.includes('tax category')) return 'tax_category'
  if (m.includes('fractions')) return 'fractional'
  return null
}

function packColumn(n: number, message: string): string | null {
  const m = message.toLowerCase()
  if (m.startsWith('pack name')) return `pack${n}_name`
  if (m.includes('lowest price')) return `pack${n}_floor`
  if (m.startsWith('price')) return `pack${n}_price`
  if (m.includes('pack')) return `pack${n}_qty`
  return null
}

function messageOf(e: unknown): string {
  if (e instanceof DomainError) return e.message
  throw e
}

/** Run a parsed row through the item service's own validators. */
function planRow(row: ImportRow, errors: ImportError[]): PlannedRow | null {
  const before = errors.length
  const fail = (column: string | null, e: unknown) =>
    errors.push({ line: row.line, column, message: messageOf(e) })

  let item: ValidItem | undefined
  try {
    item = validateItemInput({
      name: row.name,
      groupId: null,
      categoryId: null,
      brandId: null,
      attributes: {},
      sku: row.sku,
      baseUnit: row.baseUnit,
      fractional: row.fractional,
      priceCents: row.priceCents,
      floorCents: row.floorCents,
      taxCategory: row.taxCategory,
      lowStockMilli: row.lowStockMilli,
    })
  } catch (e) {
    fail(itemColumn(messageOf(e)), e)
  }

  // Taxonomy names: the same checks the find-or-create helpers make at apply time.
  const taxonomy: [string, string | null, (name: string) => unknown][] = [
    ['category', row.category, (name) => validateCategoryInput({ name, parentId: null })],
    ['subcategory', row.subcategory, (name) => validateCategoryInput({ name, parentId: null })],
    ['brand', row.brand, (name) => validateBrandInput({ name })],
    ['group', row.group, (name) => validateGroupInput({ name, attributeKeys: [] })],
  ]
  for (const [column, name, check] of taxonomy) {
    if (name === null) continue
    try {
      check(name)
    } catch (e) {
      fail(column, e)
    }
  }

  let barcode: string | null = null
  if (row.barcode !== null) {
    try {
      barcode = normalizeBarcode(row.barcode)
    } catch (e) {
      fail('barcode', e)
    }
  }

  const packs: PlannedPack[] = []
  row.packs.forEach((p, i) => {
    const n = i + 1
    try {
      const v = validatePackInput(
        { name: p.name, baseQtyMilli: p.baseQtyMilli, priceCents: p.priceCents, floorCents: p.floorCents },
        row.fractional,
      )
      let packBarcode: string | null = null
      if (p.barcode !== null) {
        try {
          packBarcode = normalizeBarcode(p.barcode)
        } catch (e) {
          fail(`pack${n}_barcode`, e)
        }
      }
      packs.push({ ...v, barcode: packBarcode })
    } catch (e) {
      fail(packColumn(n, messageOf(e)), e)
    }
  })

  if (errors.length > before || !item) return null
  return { row, item, barcode, packs }
}

// ------------------------------------------------------------------ DB checks

async function existingSet(
  db: Db | Tx,
  values: string[],
  fetch: (chunk: string[]) => Promise<(string | null)[]>,
): Promise<Set<string>> {
  const found = new Set<string>()
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    for (const v of await fetch(values.slice(i, i + IN_CHUNK))) if (v !== null) found.add(v)
  }
  return found
}

async function loadOutletIds(db: Db | Tx, ctx: TenantCtx): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: outlets.id, code: outlets.code })
    .from(outlets)
    .where(and(eq(outlets.businessId, ctx.businessId), eq(outlets.active, true)))
  return new Map(rows.map((r) => [r.code, r.id]))
}

/** Which categories, brands and groups the rows would create (case-insensitive match, first spelling wins). */
async function newTaxonomy(db: Db | Tx, ctx: TenantCtx, rows: ImportRow[]) {
  // One after another: inside applyImport `db` is a single transaction connection.
  const cats = await db
    .select({ id: categories.id, parentId: categories.parentId, name: categories.name })
    .from(categories)
    .where(eq(categories.businessId, ctx.businessId))
  const brandRows = await db.select({ name: brands.name }).from(brands).where(eq(brands.businessId, ctx.businessId))
  const groupRows = await db
    .select({ name: itemGroups.name })
    .from(itemGroups)
    .where(eq(itemGroups.businessId, ctx.businessId))
  const topByName = new Map(cats.filter((c) => c.parentId === null).map((c) => [c.name.toLowerCase(), c.id]))
  const childKeys = new Set(
    cats.filter((c) => c.parentId !== null).map((c) => `${c.parentId}|${c.name.toLowerCase()}`),
  )
  const brandNames = new Set(brandRows.map((b) => b.name.toLowerCase()))
  const groupNames = new Set(groupRows.map((g) => g.name.toLowerCase()))

  // First spelling wins, as it does when the rows are applied.
  const firstSeen = (m: Map<string, string>, key: string, label: string) => {
    if (!m.has(key)) m.set(key, label)
  }
  const newCategories = new Map<string, string>()
  const newBrands = new Map<string, string>()
  const newGroups = new Map<string, string>()
  for (const r of rows) {
    if (r.category !== null) {
      const topKey = r.category.toLowerCase()
      const parentId = topByName.get(topKey)
      if (parentId === undefined) firstSeen(newCategories, topKey, r.category)
      if (r.subcategory !== null) {
        const subKey = r.subcategory.toLowerCase()
        if (parentId === undefined || !childKeys.has(`${parentId}|${subKey}`)) {
          firstSeen(newCategories, `${topKey}|${subKey}`, `${r.category} > ${r.subcategory}`)
        }
      }
    }
    if (r.brand !== null && !brandNames.has(r.brand.toLowerCase())) firstSeen(newBrands, r.brand.toLowerCase(), r.brand)
    if (r.group !== null && !groupNames.has(r.group.toLowerCase())) firstSeen(newGroups, r.group.toLowerCase(), r.group)
  }
  return {
    newCategories: [...newCategories.values()],
    newBrands: [...newBrands.values()],
    newGroups: [...newGroups.values()],
  }
}

/** Row names that already exist as items (case-insensitive), as spelled in the file, at most MAX_EXISTING_NAMES. */
async function existingItemNames(db: Db | Tx, ctx: TenantCtx, rows: ImportRow[]): Promise<string[]> {
  const byKey = new Map<string, string>()
  for (const r of rows) if (!byKey.has(r.name.toLowerCase())) byKey.set(r.name.toLowerCase(), r.name)
  const found = await existingSet(db, [...byKey.keys()], async (chunk) =>
    (
      await db
        .select({ name: sql<string>`lower(${items.name})` })
        .from(items)
        .where(and(eq(items.businessId, ctx.businessId), inArray(sql`lower(${items.name})`, chunk)))
    ).map((r) => r.name),
  )
  return [...byKey].filter(([key]) => found.has(key)).map(([, name]) => name).slice(0, MAX_EXISTING_NAMES)
}

// ----------------------------------------------------------------------- plan

function emptyPreview(errors: ImportError[], alreadyImportedAt: string | null): ImportPreview {
  return {
    rowCount: 0,
    itemCount: 0,
    packCount: 0,
    newCategories: [],
    newBrands: [],
    newGroups: [],
    stockCells: 0,
    errors,
    alreadyImportedAt,
    existingNames: [],
  }
}

/** When this business last imported a file with this hash (ISO), or null. */
async function lastImportOf(db: Db | Tx, ctx: TenantCtx, fileHash: string): Promise<string | null> {
  const [row] = await db
    .select({ at: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.businessId, ctx.businessId),
        eq(auditLog.action, 'catalog.import'),
        sql`${auditLog.data} ->> 'fileHash' = ${fileHash}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.seq))
    .limit(1)
  return row ? row.at.toISOString() : null
}

const importedOn = new Intl.DateTimeFormat('en-KE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Nairobi',
})

async function planImport(db: Db | Tx, ctx: TenantCtx, csvText: string): Promise<Plan> {
  if (typeof csvText !== 'string') throw new DomainError('invalid_input', 'Upload a CSV file.')
  if (csvText.length > MAX_TEXT_CHARS) {
    throw new DomainError('invalid_input', 'The file is too large. The limit is 2 MB.')
  }
  const outletIds = await loadOutletIds(db, ctx)
  const fileHash = fileHashOf(csvText)
  const alreadyImportedAt = await lastImportOf(db, ctx, fileHash)

  let table: string[][]
  try {
    table = parseCsv(csvText)
  } catch (e) {
    if (e instanceof RangeError) {
      return {
        preview: emptyPreview([{ line: null, column: null, message: e.message }], alreadyImportedAt),
        planned: [],
        outletIds,
        fileHash,
      }
    }
    throw e
  }

  const { rows, errors } = validateImport(table, [...outletIds.keys()])

  // The item service's own rules, per row.
  const planned: PlannedRow[] = []
  for (const row of rows) {
    const p = planRow(row, errors)
    if (p) planned.push(p)
  }

  // Database checks: SKUs and barcodes already in this business.
  const skus = planned.flatMap((p) => (p.item.sku === null ? [] : [p.item.sku.toLowerCase()]))
  const takenSkus = await existingSet(db, skus, async (chunk) =>
    (
      await db
        .select({ sku: sql<string>`lower(${items.sku})` })
        .from(items)
        .where(and(eq(items.businessId, ctx.businessId), inArray(sql`lower(${items.sku})`, chunk)))
    ).map((r) => r.sku),
  )
  const codes = planned.flatMap((p) => [p.barcode, ...p.packs.map((k) => k.barcode)]).filter((b) => b !== null)
  const takenCodes = await existingSet(db, codes, async (chunk) =>
    (
      await db
        .select({ barcode: itemBarcodes.barcode })
        .from(itemBarcodes)
        .where(and(eq(itemBarcodes.businessId, ctx.businessId), inArray(itemBarcodes.barcode, chunk)))
    ).map((r) => r.barcode),
  )
  const failedLines = new Set<number>()
  for (const p of planned) {
    const line = p.row.line
    const fail = (column: string, message: string) => {
      errors.push({ line, column, message })
      failedLines.add(line)
    }
    if (p.item.sku !== null && takenSkus.has(p.item.sku.toLowerCase())) {
      fail('sku', 'That SKU is already used.')
    }
    if (p.barcode !== null && takenCodes.has(p.barcode)) fail('barcode', 'That barcode is already used.')
    p.packs.forEach((k, i) => {
      if (k.barcode !== null && takenCodes.has(k.barcode)) fail(`pack${i + 1}_barcode`, 'That barcode is already used.')
    })
  }
  const good = planned.filter((p) => !failedLines.has(p.row.line))

  errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  const goodRows = good.map((p) => p.row)
  const preview: ImportPreview = {
    rowCount: good.length,
    itemCount: good.length,
    packCount: good.reduce((n, p) => n + p.packs.length, 0),
    stockCells: goodRows.reduce((n, r) => n + Object.keys(r.stock).length, 0),
    ...(await newTaxonomy(db, ctx, goodRows)),
    errors,
    alreadyImportedAt,
    existingNames: await existingItemNames(db, ctx, goodRows),
  }
  return { preview, planned: good, outletIds, fileHash }
}

// --------------------------------------------------------------------- public

/** Validate a CSV and report what an import would do. Writes nothing. Owner only. */
export async function previewImport(db: Db, ctx: TenantCtx, csvText: string): Promise<ImportPreview> {
  assertCan(ctx, 'catalog.manage')
  return (await planImport(db, ctx, csvText)).preview
}

/**
 * Re-validate and apply a CSV in one transaction. Any error refuses the whole file
 * (`invalid_input`, first error) and nothing is written.
 */
export async function applyImport(
  db: Db,
  ctx: TenantCtx,
  csvText: string,
  opts: { confirmDuplicate?: boolean } = {},
): Promise<ImportResult> {
  assertCan(ctx, 'catalog.manage')
  try {
    return await db.transaction(async (tx) => {
      // Two applies of the same file queue here, so the second sees the first's audit row.
      if (typeof csvText === 'string') {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`catalog.import:${ctx.businessId}:${fileHashOf(csvText)}`}, 0))`,
        )
      }
      const { preview, planned, outletIds, fileHash } = await planImport(tx, ctx, csvText)
      if (preview.alreadyImportedAt !== null && opts.confirmDuplicate !== true) {
        throw new DomainError(
          'conflict',
          `This file was already imported on ${importedOn.format(new Date(preview.alreadyImportedAt))}. Tick "Import again anyway" to import it again.`,
        )
      }
      if (preview.errors.length > 0) {
        const first = preview.errors[0]
        throw new DomainError(
          'invalid_input',
          first.line === null ? first.message : `Line ${first.line}: ${first.message}`,
        )
      }

      const importId = randomUUID()
      const categoryIds = new Map<string, string>()
      const brandIds = new Map<string, string>()
      const groupIds = new Map<string, string>()
      const cached = async (cache: Map<string, string>, key: string, make: () => Promise<{ id: string }>) => {
        let id = cache.get(key)
        if (id === undefined) {
          id = (await make()).id
          cache.set(key, id)
        }
        return id
      }

      for (const { row, item, barcode, packs } of planned) {
        let categoryId: string | null = null
        if (row.category !== null) {
          const topKey = row.category.toLowerCase()
          categoryId = await cached(categoryIds, topKey, () => findOrCreateCategoryTx(tx, ctx, row.category!, null, importId))
          if (row.subcategory !== null) {
            const parentId = categoryId
            categoryId = await cached(categoryIds, `${topKey}|${row.subcategory.toLowerCase()}`, () =>
              findOrCreateCategoryTx(tx, ctx, row.subcategory!, parentId, importId),
            )
          }
        }
        const brandId =
          row.brand === null
            ? null
            : await cached(brandIds, row.brand.toLowerCase(), () => findOrCreateBrandTx(tx, ctx, row.brand!, importId))
        const groupId =
          row.group === null
            ? null
            : await cached(groupIds, row.group.toLowerCase(), () => findOrCreateGroupTx(tx, ctx, row.group!, importId))

        const created = await insertItemTx(tx, ctx, { ...item, categoryId, brandId, groupId }, importId)
        if (barcode !== null) await insertBarcodeTx(tx, ctx, created.id, { barcode, packId: null }, importId)
        for (const { barcode: packBarcode, ...pack } of packs) {
          const p = await insertPackTx(tx, ctx, created.id, pack, importId)
          if (packBarcode !== null) await insertBarcodeTx(tx, ctx, created.id, { barcode: packBarcode, packId: p.id }, importId)
        }
        for (const [code, qtyMilli] of Object.entries(row.stock)) {
          // Only ids resolved from this business's active outlets are ever passed on.
          const outletId = outletIds.get(code)
          if (outletId === undefined) throw new DomainError('invalid_input', `Unknown outlet code "${code}".`)
          await applyMovement(tx, {
            businessId: ctx.businessId,
            outletId,
            itemId: created.id,
            kind: 'receive',
            qtyMilli,
            note: OPENING_STOCK_NOTE,
            actorUserId: ctx.userId,
          })
        }
      }

      const result: ImportResult = {
        itemCount: preview.itemCount,
        packCount: preview.packCount,
        stockCells: preview.stockCells,
      }
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'catalog.import',
        entityType: 'catalog_import',
        entityId: importId,
        data: { ...result, importId, fileHash },
      })
      return result
    })
  } catch (e) {
    // A concurrent change slipped past the checks and hit a unique constraint.
    if (isUniqueViolation(e)) {
      throw new DomainError('conflict', 'The catalog changed while importing. Check the file and try again.')
    }
    throw e
  }
}
