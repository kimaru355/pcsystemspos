import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { businesses, memberships, outlets, users } from '@/db/schema'
import { normalizeKePhone } from '@/domain/phone'
import { hashSecret } from '@/server/auth/secret'
import { isUniqueViolation } from '@/server/db-errors'
import { DomainError } from '@/server/errors'

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

/** Platform admins are a flag on the user; they have no membership. */
export async function createPlatformAdmin(
  db: Db,
  i: { name: string; email: string; password: string },
): Promise<{ userId: string }> {
  const name = requireText(i.name, 'Name')
  const email = requireEmail(i.email)
  const passwordHash = await hashSecret(requirePassword(i.password))
  try {
    const [user] = await db
      .insert(users)
      .values({ name, email, passwordHash, isPlatformAdmin: true })
      .returning({ id: users.id })
    return { userId: user.id }
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

  try {
    return await db.transaction(async (tx) => {
      const [business] = await tx.insert(businesses).values({ name }).returning({ id: businesses.id })
      const [user] = await tx
        .insert(users)
        .values({ name: ownerName, email, phone, passwordHash, mustChangePassword: true })
        .returning({ id: users.id })
      await tx.insert(memberships).values({ businessId: business.id, userId: user.id, role: 'owner' })
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
