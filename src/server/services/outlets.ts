import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import { businesses, outlets } from '@/db/schema'
import { isUniqueViolation } from '@/server/db-errors'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'

export const CONNECTION_MODES = ['full_offline', 'default', 'always_online'] as const
export type ConnectionMode = (typeof CONNECTION_MODES)[number]

export type Outlet = {
  id: string
  name: string
  code: string
  /** null = use the business default */
  connectionMode: ConnectionMode | null
  effectiveMode: ConnectionMode
  active: boolean
}

const CODE_RE = /^[A-Z0-9]{2,5}$/

function parseMode(mode: unknown): ConnectionMode {
  if (!CONNECTION_MODES.includes(mode as ConnectionMode)) {
    throw new DomainError('invalid_input', 'Choose a valid connection mode.')
  }
  return mode as ConnectionMode
}

function parseOptionalMode(mode: unknown): ConnectionMode | null {
  return mode === null ? null : parseMode(mode)
}

function parseName(name: string): string {
  const v = name.trim()
  if (!v) throw new DomainError('invalid_input', 'Outlet name is required.')
  return v
}

type OutletRow = typeof outlets.$inferSelect

function toOutlet(row: OutletRow, businessDefault: ConnectionMode): Outlet {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    connectionMode: row.connectionMode,
    effectiveMode: row.connectionMode ?? businessDefault,
    active: row.active,
  }
}

async function businessDefaultMode(db: Db | Tx, businessId: string): Promise<ConnectionMode> {
  const [b] = await db
    .select({ mode: businesses.defaultConnectionMode })
    .from(businesses)
    .where(eq(businesses.id, businessId))
  if (!b) throw new DomainError('not_found')
  return b.mode
}

/** Owners see every outlet of the business (including inactive); others only their scope. */
export async function listOutlets(db: Db, ctx: TenantCtx): Promise<Outlet[]> {
  if (ctx.outletScope !== 'all' && ctx.outletScope.length === 0) return []
  const scope =
    ctx.outletScope === 'all'
      ? eq(outlets.businessId, ctx.businessId)
      : and(eq(outlets.businessId, ctx.businessId), inArray(outlets.id, ctx.outletScope))
  const [rows, defaultMode] = await Promise.all([
    db.select().from(outlets).where(scope).orderBy(asc(outlets.code)),
    businessDefaultMode(db, ctx.businessId),
  ])
  return rows.map((r) => toOutlet(r, defaultMode))
}

export async function createOutlet(
  db: Db,
  ctx: TenantCtx,
  i: { name: string; code: string; connectionMode: ConnectionMode | null },
): Promise<Outlet> {
  assertCan(ctx, 'outlet.manage')
  const name = parseName(i.name)
  const code = i.code.trim().toUpperCase()
  if (!CODE_RE.test(code)) {
    throw new DomainError('invalid_input', 'Code must be 2 to 5 letters or digits.')
  }
  const connectionMode = parseOptionalMode(i.connectionMode)

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(outlets)
        .values({ businessId: ctx.businessId, name, code, connectionMode })
        .returning()
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'outlet.create',
        entityType: 'outlet',
        entityId: row.id,
        data: { name, code, connectionMode },
      })
      return toOutlet(row, await businessDefaultMode(tx, ctx.businessId))
    })
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new DomainError('duplicate_code', `An outlet with code ${code} already exists.`)
    }
    throw e
  }
}

/** The code is immutable: it is baked into order numbers. */
export async function updateOutlet(
  db: Db,
  ctx: TenantCtx,
  outletId: string,
  patch: Partial<{ name: string; connectionMode: ConnectionMode | null; active: boolean }>,
): Promise<Outlet> {
  assertCan(ctx, 'outlet.manage')
  const set: Partial<Pick<OutletRow, 'name' | 'connectionMode' | 'active'>> = {}
  if (patch.name !== undefined) set.name = parseName(patch.name)
  if (patch.connectionMode !== undefined) set.connectionMode = parseOptionalMode(patch.connectionMode)
  if (patch.active !== undefined) set.active = patch.active === true

  return db.transaction(async (tx) => {
    const scope = and(eq(outlets.id, outletId), eq(outlets.businessId, ctx.businessId))
    const [existing] = await tx.select().from(outlets).where(scope)
    if (!existing) throw new DomainError('not_found')
    let row = existing
    if (Object.keys(set).length > 0) {
      ;[row] = await tx.update(outlets).set(set).where(scope).returning()
    }
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'outlet.update',
      entityType: 'outlet',
      entityId: row.id,
      data: {
        before: { name: existing.name, connectionMode: existing.connectionMode, active: existing.active },
        after: { name: row.name, connectionMode: row.connectionMode, active: row.active },
      },
    })
    return toOutlet(row, await businessDefaultMode(tx, ctx.businessId))
  })
}

export async function setDefaultConnectionMode(
  db: Db,
  ctx: TenantCtx,
  mode: ConnectionMode,
): Promise<void> {
  assertCan(ctx, 'business.settings')
  const next = parseMode(mode)
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ mode: businesses.defaultConnectionMode })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
    if (!existing) throw new DomainError('not_found')
    await tx.update(businesses).set({ defaultConnectionMode: next }).where(eq(businesses.id, ctx.businessId))
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'business.default_mode',
      entityType: 'business',
      entityId: ctx.businessId,
      data: { before: existing.mode, after: next },
    })
  })
}
