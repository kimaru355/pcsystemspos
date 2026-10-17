import { and, asc, desc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import {
  categories,
  itemBarcodes,
  items,
  outletStock,
  outlets,
  stockMovements,
  users,
} from '@/db/schema'
import { isUuid } from '@/domain/ids'
import type { Cents, Milli } from '@/domain/money'
import {
  ADJUST_REASONS,
  availableMilli,
  countToDelta,
  isLowStock,
  isWholeUnits,
  type AdjustReason,
  type MovementKind,
} from '@/domain/stock'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'

/*
 * Stock ledger.
 *
 * `stock_movements` is append-only; `outlet_stock.on_hand_milli` is its cached sum, only ever
 * changed by `applyMovement` under a row lock.
 *
 * Lock order (keep it everywhere, to avoid deadlocks):
 *   1. the `items` row, FOR SHARE   (serialises against updateItem's FOR UPDATE unit-history check)
 *   2. the `outlet_stock` row       (insert ... on conflict do nothing, then FOR UPDATE)
 *
 * Reusable by the CSV import and Phase 4 (inside a caller-owned transaction):
 *  - lockStockTx(tx, businessId, outletId, itemId)   take both locks, return the item flags and on-hand
 *  - insertMovementTx(tx, locked, m)                 insert + cached update; the caller must hold the locks
 *  - applyMovement(tx, m)                            lockStockTx + insertMovementTx; no permission checks
 * adjust and count use lockStockTx first so their below-zero check and count delta read the
 * on-hand value that is protected by the lock, then call insertMovementTx.
 */

export type Movement = {
  id: string
  outletId: string
  itemId: string
  kind: MovementKind
  qtyMilli: Milli
  unitCostCents: Cents | null
  reason: AdjustReason | null
  note: string | null
  actorUserId: string
  actorName: string
  occurredAt: Date
  createdAt: Date
}

export type NewMovement = {
  businessId: string
  outletId: string
  itemId: string
  kind: MovementKind
  qtyMilli: Milli
  unitCostCents?: Cents | null
  reason?: AdjustReason | null
  note?: string | null
  actorUserId: string
  occurredAt?: Date
  id?: string
}

export type StockRow = {
  itemId: string
  itemName: string
  sku: string | null
  baseUnit: string
  fractional: boolean
  categoryId: string | null
  onHandMilli: Milli
  owedMilli: Milli
  availableMilli: Milli
  lowStockMilli: Milli | null
  isLow: boolean
  negative: boolean
}

const INT4_MAX = 2147483647
const NOTE_MAX = 200
const BELOW_ZERO = 'That would take stock below zero.'

// ---------------------------------------------------------------- ledger core

/** The state of an item and its outlet stock row while both are locked by this transaction. */
export type LockedStock = {
  fractional: boolean
  active: boolean
  onHandMilli: Milli
  flaggedNegativeAt: Date | null
}

/**
 * Take the two locks in the documented order and read the current state.
 * `not_found` when the item is not in the business. The outlet is not checked here.
 */
export async function lockStockTx(
  tx: Tx,
  businessId: string,
  outletId: string,
  itemId: string,
): Promise<LockedStock> {
  const [item] = await tx
    .select({ fractional: items.fractional, active: items.active })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.businessId, businessId)))
    .for('share')
  if (!item) throw new DomainError('not_found')

  await tx
    .insert(outletStock)
    .values({ outletId, itemId, businessId, onHandMilli: 0 })
    .onConflictDoNothing()
  const [row] = await tx
    .select({ onHandMilli: outletStock.onHandMilli, flaggedNegativeAt: outletStock.flaggedNegativeAt })
    .from(outletStock)
    .where(
      and(
        eq(outletStock.outletId, outletId),
        eq(outletStock.itemId, itemId),
        eq(outletStock.businessId, businessId),
      ),
    )
    .for('update')
  if (!row) throw new DomainError('not_found')
  return { ...item, ...row }
}

/** Insert the movement and update the cached on-hand. The caller must hold the `lockStockTx` locks. */
export async function insertMovementTx(
  tx: Tx,
  locked: Pick<LockedStock, 'onHandMilli' | 'flaggedNegativeAt'>,
  m: NewMovement,
): Promise<{ movementId: string; onHandMilli: Milli }> {
  const next = locked.onHandMilli + m.qtyMilli
  if (!Number.isSafeInteger(next)) throw new DomainError('invalid_input', 'That quantity is too large.')
  const [row] = await tx
    .insert(stockMovements)
    .values({
      ...(m.id ? { id: m.id } : {}),
      businessId: m.businessId,
      outletId: m.outletId,
      itemId: m.itemId,
      kind: m.kind,
      qtyMilli: m.qtyMilli,
      unitCostCents: m.unitCostCents ?? null,
      reason: m.reason ?? null,
      note: m.note ?? null,
      actorUserId: m.actorUserId,
      ...(m.occurredAt ? { occurredAt: m.occurredAt } : {}),
    })
    .returning({ id: stockMovements.id })
  await tx
    .update(outletStock)
    .set({
      onHandMilli: next,
      flaggedNegativeAt: next < 0 ? (locked.flaggedNegativeAt ?? new Date()) : null,
    })
    .where(
      and(
        eq(outletStock.outletId, m.outletId),
        eq(outletStock.itemId, m.itemId),
        eq(outletStock.businessId, m.businessId),
      ),
    )
  return { movementId: row.id, onHandMilli: next }
}

/**
 * Record a movement and move the cached on-hand by its quantity, under the locks described
 * above. No permission checks and no sign rules beyond the table's checks: callers own those.
 * Used by the CSV import and Phase 4.
 */
export async function applyMovement(
  tx: Tx,
  m: NewMovement,
): Promise<{ movementId: string; onHandMilli: Milli }> {
  const locked = await lockStockTx(tx, m.businessId, m.outletId, m.itemId)
  return insertMovementTx(tx, locked, m)
}

/** Milli owed to customers per item (collect-later). Always 0 in this phase; Phase 4 fills it in. */
export async function owedMilliFor(
  _db: Db | Tx,
  _outletId: string,
  itemIds: string[],
): Promise<Map<string, Milli>> {
  return new Map(itemIds.map((id) => [id, 0]))
}

// -------------------------------------------------------------------- helpers

type MovementRow = typeof stockMovements.$inferSelect

function toMovement(r: MovementRow, actorName: string): Movement {
  return {
    id: r.id,
    outletId: r.outletId,
    itemId: r.itemId,
    kind: r.kind,
    qtyMilli: r.qtyMilli,
    unitCostCents: r.unitCostCents,
    reason: r.reason,
    note: r.note,
    actorUserId: r.actorUserId,
    actorName,
    occurredAt: r.occurredAt,
    createdAt: r.createdAt,
  }
}

async function loadMovement(db: Db | Tx, businessId: string, id: string): Promise<Movement> {
  const [r] = await db
    .select({ m: stockMovements, actorName: users.name })
    .from(stockMovements)
    .innerJoin(users, eq(users.id, stockMovements.actorUserId))
    .where(and(eq(stockMovements.id, id), eq(stockMovements.businessId, businessId)))
  if (!r) throw new DomainError('not_found')
  return toMovement(r.m, r.actorName)
}

function parseNote(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new DomainError('invalid_input', 'The note must be text.')
  const s = v.trim()
  if (s === '') return null
  if (s.length > NOTE_MAX) {
    throw new DomainError('invalid_input', `The note must be at most ${NOTE_MAX} characters.`)
  }
  return s
}

function parseUnitCost(v: unknown): Cents | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > INT4_MAX) {
    throw new DomainError('invalid_input', 'The unit cost must be a whole number of cents, 0 or more.')
  }
  return v
}

function assertQty(v: unknown, label: string, min: 'positive' | 'nonzero' | 'zero_or_more'): asserts v is number {
  const ok =
    typeof v === 'number' &&
    Number.isSafeInteger(v) &&
    (min === 'positive' ? v > 0 : min === 'nonzero' ? v !== 0 : v >= 0)
  if (!ok) {
    const rule =
      min === 'positive' ? 'more than 0' : min === 'nonzero' ? 'not 0' : '0 or more'
    throw new DomainError('invalid_input', `${label} must be a whole number of thousandths, ${rule}.`)
  }
}

function assertWhole(fractional: boolean, qty: Milli): void {
  if (!fractional && !isWholeUnits(qty)) {
    throw new DomainError('invalid_input', 'This item is only counted in whole units.')
  }
}

/**
 * The outlet must belong to the business (`not_found`) and, unless the caller sees every
 * outlet, be one of theirs (`forbidden`). `requireActive` also refuses an inactive outlet.
 */
async function assertOutlet(
  db: Db | Tx,
  ctx: TenantCtx,
  outletId: string,
  requireActive: boolean,
): Promise<{ id: string; code: string; active: boolean }> {
  if (!isUuid(outletId)) throw new DomainError('not_found')
  const [o] = await db
    .select({ id: outlets.id, code: outlets.code, active: outlets.active })
    .from(outlets)
    .where(and(eq(outlets.id, outletId), eq(outlets.businessId, ctx.businessId)))
  if (!o) throw new DomainError('not_found')
  if (ctx.outletScope !== 'all' && !ctx.outletScope.includes(o.id)) throw new DomainError('forbidden')
  if (requireActive && !o.active) throw new DomainError('invalid_input', 'That outlet is inactive.')
  return o
}

/** Escape `%`, `_` and `\` so user text is matched literally by ILIKE. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// -------------------------------------------------------------------- queries

type StockFilter = { search?: string; categoryId?: string; lowOnly?: boolean; negativeOnly?: boolean }

async function loadStockRows(
  db: Db,
  businessId: string,
  outletId: string,
  f: StockFilter,
): Promise<StockRow[]> {
  const conditions = [eq(items.businessId, businessId), eq(items.active, true)]
  const term = f.search?.trim()
  if (term) {
    conditions.push(
      or(
        ilike(items.name, `%${escapeLike(term)}%`),
        sql`lower(${items.sku}) = lower(${term})`,
        exists(
          db
            .select({ one: sql`1` })
            .from(itemBarcodes)
            .where(
              and(
                eq(itemBarcodes.itemId, items.id),
                eq(itemBarcodes.businessId, businessId),
                eq(itemBarcodes.barcode, term),
              ),
            ),
        ),
      )!,
    )
  }
  if (f.categoryId !== undefined) {
    if (!isUuid(f.categoryId)) return []
    conditions.push(
      sql`${items.categoryId} in (
        select ${categories.id} from ${categories}
        where ${categories.businessId} = ${businessId}
          and (${categories.id} = ${f.categoryId} or ${categories.parentId} = ${f.categoryId}))`,
    )
  }

  const rows = await db
    .select({
      itemId: items.id,
      itemName: items.name,
      sku: items.sku,
      baseUnit: items.baseUnit,
      fractional: items.fractional,
      categoryId: items.categoryId,
      lowStockMilli: items.lowStockMilli,
      onHandMilli: outletStock.onHandMilli,
    })
    .from(items)
    .leftJoin(
      outletStock,
      and(
        eq(outletStock.itemId, items.id),
        eq(outletStock.outletId, outletId),
        eq(outletStock.businessId, businessId),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(items.name), asc(items.id))

  const owed = await owedMilliFor(db, outletId, rows.map((r) => r.itemId))
  const out: StockRow[] = rows.map((r) => {
    const onHand = r.onHandMilli ?? 0
    const owedMilli = owed.get(r.itemId) ?? 0
    const available = availableMilli(onHand, owedMilli)
    return {
      itemId: r.itemId,
      itemName: r.itemName,
      sku: r.sku,
      baseUnit: r.baseUnit,
      fractional: r.fractional,
      categoryId: r.categoryId,
      onHandMilli: onHand,
      owedMilli,
      availableMilli: available,
      lowStockMilli: r.lowStockMilli,
      isLow: isLowStock(available, r.lowStockMilli),
      negative: onHand < 0,
    }
  })
  return out.filter((r) => (!f.lowOnly || r.isLow) && (!f.negativeOnly || r.negative))
}

/** Active items at an outlet with on-hand, owed and available, ordered by item name. */
export async function listStock(
  db: Db,
  ctx: TenantCtx,
  outletId: string,
  f: StockFilter = {},
): Promise<StockRow[]> {
  if (!isUuid(outletId)) throw new DomainError('not_found')
  assertCan(ctx, 'stock.view')
  await assertOutlet(db, ctx, outletId, false)
  return loadStockRows(db, ctx.businessId, outletId, f)
}

export type ItemOutletStock = {
  outletId: string
  outletCode: string
  outletName: string
  onHandMilli: Milli
  owedMilli: Milli
  availableMilli: Milli
  isLow: boolean
  negative: boolean
}

/** One item's stock at each active outlet in scope (owners: all), ordered by outlet code. */
export async function itemStockByOutlet(db: Db, ctx: TenantCtx, itemId: string): Promise<ItemOutletStock[]> {
  if (!isUuid(itemId)) throw new DomainError('not_found')
  assertCan(ctx, 'stock.view')
  const [item] = await db
    .select({ lowStockMilli: items.lowStockMilli })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.businessId, ctx.businessId)))
  if (!item) throw new DomainError('not_found')
  if (ctx.outletScope !== 'all' && ctx.outletScope.length === 0) return []
  const rows = await db
    .select({
      outletId: outlets.id,
      outletCode: outlets.code,
      outletName: outlets.name,
      onHandMilli: outletStock.onHandMilli,
    })
    .from(outlets)
    .leftJoin(
      outletStock,
      and(
        eq(outletStock.outletId, outlets.id),
        eq(outletStock.itemId, itemId),
        eq(outletStock.businessId, ctx.businessId),
      ),
    )
    .where(
      and(
        eq(outlets.businessId, ctx.businessId),
        eq(outlets.active, true),
        ctx.outletScope === 'all' ? undefined : inArray(outlets.id, ctx.outletScope),
      ),
    )
    .orderBy(asc(outlets.code), asc(outlets.id))
  const owed = await Promise.all(rows.map((r) => owedMilliFor(db, r.outletId, [itemId])))
  return rows.map((r, i) => {
    const onHand = r.onHandMilli ?? 0
    const owedMilli = owed[i].get(itemId) ?? 0
    const available = availableMilli(onHand, owedMilli)
    return {
      outletId: r.outletId,
      outletCode: r.outletCode,
      outletName: r.outletName,
      onHandMilli: onHand,
      owedMilli,
      availableMilli: available,
      isLow: isLowStock(available, item.lowStockMilli),
      negative: onHand < 0,
    }
  })
}

/** Newest first. */
export async function itemHistory(
  db: Db,
  ctx: TenantCtx,
  outletId: string,
  itemId: string,
  limit = 100,
): Promise<Movement[]> {
  if (!isUuid(outletId) || !isUuid(itemId)) throw new DomainError('not_found')
  assertCan(ctx, 'stock.view')
  await assertOutlet(db, ctx, outletId, false)
  const [item] = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.businessId, ctx.businessId)))
  if (!item) throw new DomainError('not_found')
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100
  const rows = await db
    .select({ m: stockMovements, actorName: users.name })
    .from(stockMovements)
    .innerJoin(users, eq(users.id, stockMovements.actorUserId))
    .where(
      and(
        eq(stockMovements.businessId, ctx.businessId),
        eq(stockMovements.outletId, outletId),
        eq(stockMovements.itemId, itemId),
      ),
    )
    .orderBy(desc(stockMovements.occurredAt), desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(cap)
  return rows.map((r) => toMovement(r.m, r.actorName))
}

/** Low-stock item counts for the active outlets in scope; outlets with none are left out. */
export async function lowStockCounts(
  db: Db,
  ctx: TenantCtx,
): Promise<{ outletId: string; count: number }[]> {
  assertCan(ctx, 'stock.view')
  if (ctx.outletScope !== 'all' && ctx.outletScope.length === 0) return []
  const rows = await db
    .select({ id: outlets.id })
    .from(outlets)
    .where(
      and(
        eq(outlets.businessId, ctx.businessId),
        eq(outlets.active, true),
        ctx.outletScope === 'all' ? undefined : inArray(outlets.id, ctx.outletScope),
      ),
    )
    .orderBy(asc(outlets.code), asc(outlets.id))
  const out: { outletId: string; count: number }[] = []
  for (const o of rows) {
    const low = await loadStockRows(db, ctx.businessId, o.id, { lowOnly: true })
    if (low.length > 0) out.push({ outletId: o.id, count: low.length })
  }
  return out
}

// --------------------------------------------------------------------- writes

type Write = {
  outletId: string
  itemId: string
  kind: MovementKind
  reason: AdjustReason | null
  note: string | null
  unitCostCents: Cents | null
}

/**
 * Shared transaction for the three writes. `decide` gets the locked on-hand and returns the
 * movement quantity (or `null` for nothing to do), after its own checks against that value.
 */
async function writeStock(
  db: Db,
  ctx: TenantCtx,
  w: Write,
  decide: (locked: LockedStock) => Milli | null,
): Promise<Movement | null> {
  return db.transaction(async (tx) => {
    await assertOutlet(tx, ctx, w.outletId, true)
    const locked = await lockStockTx(tx, ctx.businessId, w.outletId, w.itemId)
    if (!locked.active) throw new DomainError('invalid_input', 'That item is inactive.')
    const qtyMilli = decide(locked)
    if (qtyMilli === null) return null
    const { movementId } = await insertMovementTx(tx, locked, {
      businessId: ctx.businessId,
      outletId: w.outletId,
      itemId: w.itemId,
      kind: w.kind,
      qtyMilli,
      unitCostCents: w.unitCostCents,
      reason: w.reason,
      note: w.note,
      actorUserId: ctx.userId,
    })
    if (w.kind === 'adjust') {
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'stock.adjust',
        entityType: 'stock_movement',
        entityId: movementId,
        data: { outletId: w.outletId, itemId: w.itemId, deltaMilli: qtyMilli, reason: w.reason },
      })
    }
    return loadMovement(tx, ctx.businessId, movementId)
  })
}

export async function receiveStock(
  db: Db,
  ctx: TenantCtx,
  i: { outletId: string; itemId: string; qtyMilli: Milli; unitCostCents?: Cents | null; note?: string | null },
): Promise<Movement> {
  if (!isUuid(i.outletId) || !isUuid(i.itemId)) throw new DomainError('not_found')
  assertCan(ctx, 'stock.receive')
  assertQty(i.qtyMilli, 'The quantity', 'positive')
  const unitCostCents = parseUnitCost(i.unitCostCents)
  const note = parseNote(i.note)
  const qty = i.qtyMilli
  const m = await writeStock(
    db,
    ctx,
    { outletId: i.outletId, itemId: i.itemId, kind: 'receive', reason: null, note, unitCostCents },
    (locked) => {
      assertWhole(locked.fractional, qty)
      return qty
    },
  )
  return m!
}

export async function adjustStock(
  db: Db,
  ctx: TenantCtx,
  i: { outletId: string; itemId: string; deltaMilli: Milli; reason: AdjustReason; note?: string | null },
): Promise<Movement> {
  if (!isUuid(i.outletId) || !isUuid(i.itemId)) throw new DomainError('not_found')
  assertCan(ctx, 'stock.adjust')
  assertQty(i.deltaMilli, 'The change', 'nonzero')
  if (!ADJUST_REASONS.includes(i.reason)) throw new DomainError('invalid_input', 'Choose a valid reason.')
  const note = parseNote(i.note)
  if (i.reason === 'other' && note === null) {
    throw new DomainError('invalid_input', 'Add a note when the reason is Other.')
  }
  const delta = i.deltaMilli
  const m = await writeStock(
    db,
    ctx,
    { outletId: i.outletId, itemId: i.itemId, kind: 'adjust', reason: i.reason, note, unitCostCents: null },
    (locked) => {
      assertWhole(locked.fractional, delta)
      if (locked.onHandMilli + delta < 0) throw new DomainError('invalid_input', BELOW_ZERO)
      return delta
    },
  )
  return m!
}

/** Set on-hand to a counted quantity; `null` (nothing written) when it already matches. */
export async function countStock(
  db: Db,
  ctx: TenantCtx,
  i: { outletId: string; itemId: string; countedMilli: Milli; note?: string | null },
): Promise<Movement | null> {
  if (!isUuid(i.outletId) || !isUuid(i.itemId)) throw new DomainError('not_found')
  assertCan(ctx, 'stock.adjust')
  assertQty(i.countedMilli, 'The count', 'zero_or_more')
  const note = parseNote(i.note)
  const counted = i.countedMilli
  return writeStock(
    db,
    ctx,
    {
      outletId: i.outletId,
      itemId: i.itemId,
      kind: 'adjust',
      reason: 'count_correction',
      note,
      unitCostCents: null,
    },
    (locked) => {
      assertWhole(locked.fractional, counted)
      const delta = countToDelta(locked.onHandMilli, counted)
      return delta === 0 ? null : delta
    },
  )
}
