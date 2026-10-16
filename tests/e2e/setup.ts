import { existsSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

export const OWNER_EMAIL = 'owner@smoke.test'
export const OWNER_PASSWORD = 'password123'

/**
 * Playwright globalSetup: migrate the TEST database, empty it, and seed an outlet-less business
 * with one owner who still has to change the temporary password.
 */
export default async function globalSetup() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgres://pos:pos@localhost:5433/pos_test'
  // The db client reads DATABASE_URL when it is first imported, so point it at the test DB first
  // (never the dev DB from .env) and only then import anything that touches the client.
  process.env.DATABASE_URL = url

  const pool = new Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
  } finally {
    await pool.end()
  }

  const { db } = await import('@/db/client')
  const { resetDb } = await import('../helpers/db')
  const { createBusinessWithOwner } = await import('@/server/services/platform')

  await resetDb()
  await createBusinessWithOwner(db, {
    name: 'Smoke Hardware',
    ownerName: 'Olivia Owner',
    ownerEmail: OWNER_EMAIL,
    ownerPassword: OWNER_PASSWORD,
  })
  // The pool is released when this process exits.
}
