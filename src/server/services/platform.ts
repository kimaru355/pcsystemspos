import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { businesses, memberships, outlets, users } from '@/db/schema'
import { normalizeKePhone } from '@/domain/phone'
import { hashSecret } from '@/server/auth/secret'
import { isUniqueViolation } from '@/server/db-errors'
import { DomainError } from '@/server/errors'
import { recordAudit } from './audit'

const MIN_PASSWORD_LENGTH = 8
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function requireText(value: string, label: string): string {
  const v = value.trim()
  if (!v) throw new DomainError('invalid_input', `${label} is required.`)
  return v
}

function requirePassword(value: string): string {
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError('invalid_input', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  return value
}

function requireEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!EMAIL_RE.test(email)) throw new DomainError('invalid_input', 'Enter a valid email address.')
  return email
}

/** The acting platform admin, for audit rows (`--actor` on the CLI). */
async function platformActor(db: Db, actorUserId: string | undefined): Promise<string | null> {
  if (!actorUserId) return null
  const [a] = await db.select({ id: users.id, admin: users.isPlatformAdmin }).from(users).where(eq(users.id, actorUserId))
  if (!a?.admin) throw new DomainError('forbidden', 'The acting user is not a platform admin.')
  return a.id
}

/** Look up a platform admin by email (for the CLI's `--actor`). */
export async function platformAdminByEmail(db: Db, email: string): Promise<string> {
  const [a] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`, eq(users.isPlatformAdmin, true)))
  if (!a) throw new DomainError('not_found', 'No platform admin has that email.')
  return a.id
}

/**
 * Platform admins are a flag on the user; they have no membership. The password is temporary:
 * they change it at first sign-in.
 */
export async function createPlatformAdmin(
  db: Db,
  i: { name: string; email: string; password: string; actorUserId?: string },
): Promise<{ userId: string }> {
  const name = requireText(i.name, 'Name')
  const email = requireEmail(i.email)
  const passwordHash = await hashSecret(requirePassword(i.password))
  const actor = await platformActor(db, i.actorUserId)
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ name, email, passwordHash, isPlatformAdmin: true, mustChangePassword: true })
        .returning({ id: users.id })
      await recordAudit(tx, {
        businessId: null,
        actorUserId: actor ?? user.id,
        action: 'platform.create_admin',
        entityType: 'user',
        entityId: user.id,
        data: { name, email, viaCli: true },
      })
      return { userId: user.id }
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError('conflict', 'A user with that email already exists.')
    throw e
  }
}

/** Creates the business, its owner user (must change the temporary password) and the owner membership. */
export async function createBusinessWithOwner(
  db: Db,
  i: {
    name: string
    ownerName: string
    ownerEmail?: string
    ownerPhone?: string
    ownerPassword: string
    actorUserId?: string
  },
): Promise<{ businessId: string; ownerUserId: string }> {
  const name = requireText(i.name, 'Business name')
  const ownerName = requireText(i.ownerName, 'Owner name')
  const hasEmail = !!i.ownerEmail?.trim()
  const hasPhone = !!i.ownerPhone?.trim()
  if (!hasEmail && !hasPhone) {
    throw new DomainError('invalid_input', 'Give the owner an email or a phone number.')
  }
  const email = hasEmail ? requireEmail(i.ownerEmail!) : null
  let phone: string | null = null
  if (hasPhone) {
    phone = normalizeKePhone(i.ownerPhone!)
    if (!phone) throw new DomainError('invalid_input', 'Enter a valid Kenyan phone number.')
  }
  const passwordHash = await hashSecret(requirePassword(i.ownerPassword))
  const actor = await platformActor(db, i.actorUserId)

  try {
    return await db.transaction(async (tx) => {
      const [business] = await tx.insert(businesses).values({ name }).returning({ id: businesses.id })
      const [user] = await tx
        .insert(users)
        .values({ name: ownerName, email, phone, passwordHash, mustChangePassword: true })
        .returning({ id: users.id })
      await tx.insert(memberships).values({ businessId: business.id, userId: user.id, role: 'owner' })
      if (actor) {
        await recordAudit(tx, {
          businessId: business.id,
          actorUserId: actor,
          action: 'platform.create_business',
          entityType: 'business',
          entityId: business.id,
          data: { name, ownerName, ownerEmail: email, ownerPhone: phone },
        })
      }
      return { businessId: business.id, ownerUserId: user.id }
    })
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new DomainError('conflict', 'A user with that email or phone already exists.')
    }
    throw e
  }
}

export type BusinessSummary = {
  id: string
  name: string
  status: 'active' | 'suspended'
  outlets: number
  staff: number
  createdAt: Date
}

/** Platform admins only (callers check). Counts, never a business's sales data. */
export async function listBusinesses(db: Db): Promise<BusinessSummary[]> {
  return db
    .select({
      id: businesses.id,
      name: businesses.name,
      status: businesses.status,
      createdAt: businesses.createdAt,
      outlets: sql<number>`count(distinct ${outlets.id}) filter (where ${outlets.active})::int`,
      staff: sql<number>`count(distinct ${memberships.id}) filter (where ${memberships.active})::int`,
    })
    .from(businesses)
    .leftJoin(outlets, eq(outlets.businessId, businesses.id))
    .leftJoin(memberships, eq(memberships.businessId, businesses.id))
    .groupBy(businesses.id)
    .orderBy(asc(businesses.name))
}
