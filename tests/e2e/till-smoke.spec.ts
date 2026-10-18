import { existsSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { assertTestDatabase } from '../helpers/test-db-guard'

const OWNER_EMAIL = 'till-owner@smoke.test'
const CASHIER_EMAIL = 'till-cashier@smoke.test'
const PASSWORD = 'password123'

test.beforeAll(async () => {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://pos:pos@localhost:5433/pos_test'
  assertTestDatabase(url)
  // The db client reads DATABASE_URL when it is first imported, so point it at the test DB first.
  process.env.DATABASE_URL = url

  const { hash } = await import('@node-rs/argon2')
  const { eq } = await import('drizzle-orm')
  const { db } = await import('@/db/client')
  const { items, membershipOutlets, memberships, outletStock, outlets, stockMovements, users } = await import('@/db/schema')
  const { createBusinessWithOwner } = await import('@/server/services/platform')

  const { businessId, ownerUserId } = await createBusinessWithOwner(db, {
    name: 'Till Hardware',
    ownerName: 'Tina Owner',
    ownerEmail: OWNER_EMAIL,
    ownerPassword: PASSWORD,
  })
  // Rows are inserted directly: the services pull in the tenant module, which imports Next.js
  // runtime modules that Playwright's plain Node process cannot load.
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, ownerUserId))
  const [outlet] = await db.insert(outlets).values({ businessId, name: 'Kitale', code: 'KTL' }).returning()
  const [cashier] = await db
    .insert(users)
    .values({ name: 'Carol Cashier', email: CASHIER_EMAIL, passwordHash: await hash(PASSWORD) })
    .returning()
  const [m] = await db.insert(memberships).values({ businessId, userId: cashier.id, role: 'cashier' }).returning()
  await db.insert(membershipOutlets).values({ businessId, membershipId: m.id, outletId: outlet.id })
  const [cement] = await db
    .insert(items)
    .values({ businessId, name: 'Cement 50kg', sku: 'CEM50', baseUnit: 'bag', priceCents: 78000, floorCents: 75000 })
    .returning()
  await db.insert(stockMovements).values({
    businessId,
    outletId: outlet.id,
    itemId: cement.id,
    kind: 'receive',
    qtyMilli: 40000,
    actorUserId: ownerUserId,
  })
  await db.insert(outletStock).values({ businessId, outletId: outlet.id, itemId: cement.id, onHandMilli: 40000 })
})

async function logIn(page: Page, identifier: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Phone or email').fill(identifier)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
}

test('a till is set up, sells offline, syncs, and unlocks with a PIN', async ({ page, context }) => {
  // An owner signed in on the web sets this browser up as a till.
  await logIn(page, OWNER_EMAIL, PASSWORD)
  await expect(page).toHaveURL(/\/admin$/)
  await page.goto('/till')
  await expect(page.getByRole('heading', { name: 'Set up this device as a till' })).toBeVisible()
  await page.getByLabel('Name of this till').fill('Front counter')
  await page.getByRole('button', { name: 'Set up till' }).click()

  // First sign-in of the cashier on this till: password and a new PIN.
  await expect(page.getByRole('heading', { name: 'Sign in to this till' })).toBeVisible()
  await page.getByLabel('Phone or email').fill(CASHIER_EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByLabel('PIN').fill('4821')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('tab', { name: 'Sale' })).toBeVisible()
  await expect(page.getByText('KTL-01')).toBeVisible()

  // The connection drops; the sale still goes through.
  await context.setOffline(true)
  const tile = page.getByRole('button', { name: /Cement 50kg/ }).first()
  await tile.click()
  await tile.click()
  await page.getByRole('button', { name: 'Checkout' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Checkout · KES 1,560.00')).toBeVisible()
  await dialog.getByRole('button', { name: 'Confirm sale' }).click()
  await expect(page.getByText('KTL-01-000001')).toBeVisible()
  await expect(page.getByText('1 to sync')).toBeVisible()

  // Stock on the till already reflects the bags that left.
  await page.getByRole('tab', { name: 'Stock' }).click()
  await expect(page.getByRole('row', { name: /Cement 50kg/ })).toContainText('38')

  // Back online: the outbox empties.
  await context.setOffline(false)
  await expect(page.getByText(/Synced \d\d:\d\d/)).toBeVisible({ timeout: 15_000 })

  // Lock, then unlock offline with the PIN.
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Lock the till' }).click()
  await page.getByRole('button', { name: /Carol Cashier/ }).click()
  await page.getByLabel('PIN').fill('4821')
  await page.getByLabel('PIN').press('Enter')
  await expect(page.getByRole('tab', { name: 'Orders' })).toBeVisible()
  await page.getByRole('tab', { name: 'Orders' }).click()
  await expect(page.getByText('KTL-01-000001')).toBeVisible()
  await context.setOffline(false)
})
