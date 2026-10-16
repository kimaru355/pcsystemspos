import { hash } from '@node-rs/argon2'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { businesses, memberships, outlets, users } from '@/db/schema'
import { normalizeKePhone } from '@/domain/phone'

export const SEED_PASSWORD = 'password123'

/** Truncates every table in the public schema (not Drizzle's own migrations table). */
export async function resetDb(): Promise<void> {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  )
  if (rows.length === 0) return
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ')
  await db.execute(sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`))
}

// argon2id with the library defaults, so Task 5's verifySecret accepts it.
// Hashed once: every seeded owner shares the same password.
let passwordHash: Promise<string> | undefined

let seedCounter = 0

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface SeedBusinessOptions {
  name?: string
  outletCodes?: string[]
  /** Stored on the owner in E.164 form. Defaults to no phone. */
  ownerPhone?: string
}

export interface SeededBusiness {
  businessId: string
  outletIds: string[]
  owner: { userId: string; membershipId: string }
}

/** Owner email is `owner@<slug of name>.test`; password is `password123`. */
export async function seedBusiness(opts: SeedBusinessOptions = {}): Promise<SeededBusiness> {
  seedCounter += 1
  const name = opts.name ?? `Test Hardware ${seedCounter}`
  const codes = opts.outletCodes ?? []
  let phone: string | null = null
  if (opts.ownerPhone !== undefined) {
    phone = normalizeKePhone(opts.ownerPhone)
    if (!phone) throw new Error(`seedBusiness: invalid ownerPhone "${opts.ownerPhone}"`)
  }
  passwordHash ??= hash(SEED_PASSWORD)
  const passwordHashValue = await passwordHash

  return db.transaction(async (tx) => {
    const [business] = await tx.insert(businesses).values({ name }).returning({ id: businesses.id })
    const outletRows = codes.length
      ? await tx
          .insert(outlets)
          .values(codes.map((code) => ({ businessId: business.id, name: `Outlet ${code}`, code })))
          .returning({ id: outlets.id })
      : []
    const [user] = await tx
      .insert(users)
      .values({
        name: `${name} Owner`,
        email: `owner@${slugify(name)}.test`,
        phone,
        passwordHash: passwordHashValue,
      })
      .returning({ id: users.id })
    const [membership] = await tx
      .insert(memberships)
      .values({ businessId: business.id, userId: user.id, role: 'owner' })
      .returning({ id: memberships.id })
    return {
      businessId: business.id,
      outletIds: outletRows.map((o) => o.id),
      owner: { userId: user.id, membershipId: membership.id },
    }
  })
}
