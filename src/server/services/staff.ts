import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import { membershipOutlets, memberships, outlets, users } from '@/db/schema'
import { isUuid } from '@/domain/ids'
import { normalizeKePhone } from '@/domain/phone'
import { can, ROLES, type Role } from '@/domain/permissions'
import { hashSecret } from '@/server/auth/secret'
import { invalidateUserSessions } from '@/server/auth/session'
import { isUniqueViolation } from '@/server/db-errors'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'

export type StaffMember = {
  membershipId: string
  userId: string
  name: string
  email: string | null
  phone: string | null
  role: Role
  outletIds: string[]
  active: boolean
  hasPin: boolean
}

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 200
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PIN_RE = /^\d{4,6}$/

function parseRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) throw new DomainError('invalid_input', 'Choose a valid role.')
  return role as Role
}

function parseName(name: string): string {
  const v = name.trim()
  if (!v) throw new DomainError('invalid_input', 'Name is required.')
  return v
}

function parseContact(i: { email?: string; phone?: string }): { email: string | null; phone: string | null } {
  const rawEmail = i.email?.trim() ?? ''
  const rawPhone = i.phone?.trim() ?? ''
  if (!rawEmail && !rawPhone) {
    throw new DomainError('invalid_input', 'Give an email or a phone number.')
  }
  let email: string | null = null
  if (rawEmail) {
    email = rawEmail.toLowerCase()
    if (!EMAIL_RE.test(email)) throw new DomainError('invalid_input', 'Enter a valid email address.')
  }
  let phone: string | null = null
  if (rawPhone) {
    phone = normalizeKePhone(rawPhone)
    if (!phone) throw new DomainError('invalid_input', 'Enter a valid Kenyan phone number.')
  }
  return { email, phone }
}

function parsePassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError('invalid_input', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new DomainError('invalid_input', 'Password is too long.')
  return password
}

/** Order-preserving de-duplication. */
function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)]
}

function requireOutletsFor(role: Role, outletIds: string[]): void {
  if (role !== 'owner' && outletIds.length === 0) {
    throw new DomainError('invalid_input', 'Choose at least one outlet.')
  }
}

/** Every id must be an active outlet of the business; anything else (incl. a foreign id) is not_found. */
async function assertActiveOutlets(tx: Tx, businessId: string, outletIds: string[]): Promise<void> {
  if (outletIds.length === 0) return
  if (!outletIds.every(isUuid)) throw new DomainError('not_found', 'Outlet not found.')
  const found = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(
      and(eq(outlets.businessId, businessId), eq(outlets.active, true), inArray(outlets.id, outletIds)),
    )
  if (found.length !== outletIds.length) throw new DomainError('not_found', 'Outlet not found.')
}

type Reader = Db | Tx

/** Loads staff of one business (optionally narrowed to some membership ids), ordered by name. */
async function loadStaff(db: Reader, businessId: string, onlyIds?: string[]): Promise<StaffMember[]> {
  if (onlyIds && onlyIds.length === 0) return []
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: memberships.role,
      active: memberships.active,
      pinHash: memberships.pinHash,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      onlyIds
        ? and(eq(memberships.businessId, businessId), inArray(memberships.id, onlyIds))
        : eq(memberships.businessId, businessId),
    )
    .orderBy(asc(users.name), asc(memberships.createdAt))
  if (rows.length === 0) return []

  // Join to outlets so a stray link can never surface another business's outlet.
  const links = await db
    .select({ membershipId: membershipOutlets.membershipId, outletId: membershipOutlets.outletId })
    .from(membershipOutlets)
    .innerJoin(outlets, eq(outlets.id, membershipOutlets.outletId))
    .where(
      and(
        eq(outlets.businessId, businessId),
        inArray(
          membershipOutlets.membershipId,
          rows.map((r) => r.membershipId),
        ),
      ),
    )
    .orderBy(asc(outlets.code))
  const byMembership = new Map<string, string[]>()
  for (const l of links) {
    byMembership.set(l.membershipId, [...(byMembership.get(l.membershipId) ?? []), l.outletId])
  }
  return rows.map(({ pinHash, ...r }) => ({
    ...r,
    outletIds: byMembership.get(r.membershipId) ?? [],
    hasPin: pinHash !== null,
  }))
}

async function loadOne(db: Reader, businessId: string, membershipId: string): Promise<StaffMember | null> {
  const [member] = await loadStaff(db, businessId, [membershipId])
  return member ?? null
}

/** Owners see everyone; managers themself plus staff sharing at least one of their outlets. */
export async function listStaff(db: Db, ctx: TenantCtx): Promise<StaffMember[]> {
  if (!can(ctx.role, 'staff.manage') && !can(ctx.role, 'staff.reset_pin')) throw new DomainError('forbidden')
  if (ctx.outletScope === 'all') return loadStaff(db, ctx.businessId)

  const visible = new Set<string>([ctx.membershipId])
  if (ctx.outletScope.length > 0) {
    const shared = await db
      .select({ membershipId: membershipOutlets.membershipId })
      .from(membershipOutlets)
      .innerJoin(memberships, eq(memberships.id, membershipOutlets.membershipId))
      .where(
        and(
          eq(memberships.businessId, ctx.businessId),
          inArray(membershipOutlets.outletId, ctx.outletScope),
        ),
      )
    for (const s of shared) visible.add(s.membershipId)
  }
  return loadStaff(db, ctx.businessId, [...visible])
}

export async function createStaff(
  db: Db,
  ctx: TenantCtx,
  i: {
    name: string
    email?: string
    phone?: string
    role: Role
    outletIds: string[]
    tempPassword: string
  },
): Promise<StaffMember> {
  assertCan(ctx, 'staff.manage')
  const name = parseName(i.name)
  const { email, phone } = parseContact(i)
  const role = parseRole(i.role)
  const outletIds = uniqueIds(i.outletIds)
  requireOutletsFor(role, outletIds)
  const passwordHash = await hashSecret(parsePassword(i.tempPassword))

  try {
    return await db.transaction(async (tx) => {
      await assertActiveOutlets(tx, ctx.businessId, outletIds)
      // Logins match email case-insensitively, so guard against differently-cased duplicates too.
      if (email) {
        const [clash] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`)
        if (clash) throw new DomainError('conflict', 'A user with that email already exists.')
      }
      const [user] = await tx
        .insert(users)
        .values({ name, email, phone, passwordHash, mustChangePassword: true })
        .returning({ id: users.id })
      const [membership] = await tx
        .insert(memberships)
        .values({ businessId: ctx.businessId, userId: user.id, role })
        .returning({ id: memberships.id })
      if (outletIds.length > 0) {
        await tx
          .insert(membershipOutlets)
          .values(
            outletIds.map((outletId) => ({
              businessId: ctx.businessId,
              membershipId: membership.id,
              outletId,
            })),
          )
      }
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'staff.create',
        entityType: 'membership',
        entityId: membership.id,
        data: { name, role, outletIds },
      })
      return (await loadOne(tx, ctx.businessId, membership.id))!
    })
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new DomainError('conflict', 'A user with that email or phone number already exists.')
    }
    throw e
  }
}

/** Locks the business's active owner rows and returns their membership ids (serialises owner changes). */
async function lockActiveOwners(tx: Tx, businessId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.businessId, businessId),
        eq(memberships.role, 'owner'),
        eq(memberships.active, true),
      ),
    )
    .for('update')
  return rows.map((r) => r.id)
}

async function getTarget(tx: Tx, businessId: string, membershipId: string) {
  if (!isUuid(membershipId)) throw new DomainError('not_found')
  const [target] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.businessId, businessId)))
  if (!target) throw new DomainError('not_found')
  return target
}

export async function updateStaff(
  db: Db,
  ctx: TenantCtx,
  membershipId: string,
  patch: Partial<{ role: Role; outletIds: string[] }>,
): Promise<StaffMember> {
  assertCan(ctx, 'staff.manage')
  const nextRole = patch.role !== undefined ? parseRole(patch.role) : undefined
  const nextOutlets = patch.outletIds !== undefined ? uniqueIds(patch.outletIds) : undefined

  return db.transaction(async (tx) => {
    const target = await getTarget(tx, ctx.businessId, membershipId)
    const before = (await loadOne(tx, ctx.businessId, membershipId))!
    const role = nextRole ?? target.role
    const outletIds = nextOutlets ?? before.outletIds
    requireOutletsFor(role, outletIds)
    if (nextOutlets) await assertActiveOutlets(tx, ctx.businessId, nextOutlets)

    if (target.role === 'owner' && role !== 'owner' && target.active) {
      const owners = await lockActiveOwners(tx, ctx.businessId)
      if (owners.length <= 1) {
        throw new DomainError('conflict', 'A business must keep at least one active owner.')
      }
    }

    if (nextRole && nextRole !== target.role) {
      await tx.update(memberships).set({ role: nextRole }).where(eq(memberships.id, target.id))
    }
    if (nextOutlets) {
      await tx.delete(membershipOutlets).where(eq(membershipOutlets.membershipId, target.id))
      if (nextOutlets.length > 0) {
        await tx.insert(membershipOutlets).values(
          nextOutlets.map((outletId) => ({
            businessId: ctx.businessId,
            membershipId: target.id,
            outletId,
          })),
        )
      }
    }
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'staff.update',
      entityType: 'membership',
      entityId: target.id,
      data: {
        before: { role: before.role, outletIds: before.outletIds },
        after: { role, outletIds },
      },
    })
    return (await loadOne(tx, ctx.businessId, target.id))!
  })
}

export async function deactivateStaff(db: Db, ctx: TenantCtx, membershipId: string): Promise<void> {
  assertCan(ctx, 'staff.manage')
  await db.transaction(async (tx) => {
    const target = await getTarget(tx, ctx.businessId, membershipId)
    if (target.id === ctx.membershipId) {
      throw new DomainError('conflict', 'You cannot deactivate yourself.')
    }
    if (target.role === 'owner' && target.active) {
      const owners = await lockActiveOwners(tx, ctx.businessId)
      if (owners.length <= 1) {
        throw new DomainError('conflict', 'A business must keep at least one active owner.')
      }
    }
    await tx.update(memberships).set({ active: false }).where(eq(memberships.id, target.id))
    await invalidateUserSessions(tx, target.userId)
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'staff.deactivate',
      entityType: 'membership',
      entityId: target.id,
    })
  })
}

export async function reactivateStaff(db: Db, ctx: TenantCtx, membershipId: string): Promise<void> {
  assertCan(ctx, 'staff.manage')
  await db.transaction(async (tx) => {
    const target = await getTarget(tx, ctx.businessId, membershipId)
    if (target.active) throw new DomainError('conflict', 'That person is already active.')
    await tx.update(memberships).set({ active: true }).where(eq(memberships.id, target.id))
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'staff.reactivate',
      entityType: 'membership',
      entityId: target.id,
    })
  })
}

/** Owners: anyone in the business. Managers: only active cashiers sharing an outlet with them. */
export async function setPin(db: Db, ctx: TenantCtx, membershipId: string, pin: string): Promise<void> {
  assertCan(ctx, 'staff.reset_pin')
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    throw new DomainError('invalid_input', 'PIN must be 4 to 6 digits.')
  }
  const pinHash = await hashSecret(pin)

  await db.transaction(async (tx) => {
    const target = await getTarget(tx, ctx.businessId, membershipId)
    if (ctx.role !== 'owner') {
      let allowed = false
      if (target.role === 'cashier' && target.active && ctx.outletScope !== 'all' && ctx.outletScope.length > 0) {
        const [shared] = await tx
          .select({ outletId: membershipOutlets.outletId })
          .from(membershipOutlets)
          .where(
            and(
              eq(membershipOutlets.membershipId, target.id),
              inArray(membershipOutlets.outletId, ctx.outletScope),
            ),
          )
          .limit(1)
        allowed = !!shared
      }
      if (!allowed) throw new DomainError('forbidden')
    }
    await tx.update(memberships).set({ pinHash }).where(eq(memberships.id, target.id))
    // Never record the PIN or its hash.
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'staff.set_pin',
      entityType: 'membership',
      entityId: target.id,
    })
  })
}
