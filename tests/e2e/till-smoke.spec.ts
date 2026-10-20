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

  // Still offline: the receipt is ready to print, and an SMS waits in the outbox.
  await page.getByText('KTL-01-000001').click()
  await page.getByRole('button', { name: 'Print or send a receipt' }).click()
  await expect(page.getByLabel('Receipt preview')).toContainText('TOTAL')
  await page.getByLabel('Phone for SMS').fill('0712 345 678')
  await page.getByRole('button', { name: 'SMS', exact: true }).click()
  await expect(page.getByText('SMS will be sent once the till is online.')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press('Escape')
  await context.setOffline(false)
  await expect(page.getByText(/Synced \d\d:\d\d/)).toBeVisible({ timeout: 15_000 })

  // The owner (still signed in on the web) sees the till and the synced sale in admin.
  await page.goto('/admin/devices')
  await expect(page.getByText('KTL-01')).toBeVisible()
  await expect(page.getByText('Front counter')).toBeVisible()
  await page.goto('/admin/orders')
  await page.getByRole('link', { name: 'KTL-01-000001' }).click()
  await expect(page.getByRole('heading', { name: 'KTL-01-000001', level: 1 })).toBeVisible()
  await expect(page.getByText('Paid.', { exact: true })).toBeVisible()
  await expect(page.getByText('Collected.', { exact: true })).toBeVisible()
  // No SMS provider in the test environment: the receipt waits in the queue, with the reason.
  await expect(page.getByText('SMS is not set up on the server.')).toBeVisible()
})

test('the owner sets up M-Pesa, matches a paybill payment, and reads reports', async ({ page, request }) => {
  await logIn(page, OWNER_EMAIL, PASSWORD)
  await expect(page).toHaveURL(/\/admin$/)

  // M-Pesa settings: credentials are stored but never shown again.
  await page.goto('/admin/settings')
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save M-Pesa settings' }) }).first()
  await form.getByLabel('Business shortcode').fill('174379')
  await form.getByLabel('Consumer key').fill('test-key')
  await form.getByLabel('Consumer secret').fill('test-secret')
  await form.getByLabel('Passkey').fill('test-passkey')
  await form.getByRole('button', { name: 'Save M-Pesa settings' }).click()
  await expect(page.getByText('M-Pesa settings saved.')).toBeVisible()
  const confirmation = await page.getByText(/\/api\/mpesa\/c2b\/.+\/confirmation$/).first().textContent()

  // Safaricom confirms a paybill payment with an account nobody recognises.
  const res = await request.post(confirmation!.replace(/^https?:\/\/[^/]+/, ''), {
    data: {
      TransactionType: 'Pay Bill',
      TransID: 'SJK7E2E001',
      TransTime: '20261020100000',
      TransAmount: '500.00',
      BusinessShortCode: '174379',
      BillRefNumber: 'cement',
      MSISDN: '254712345678',
      FirstName: 'PETER',
    },
  })
  expect(res.ok()).toBe(true)

  // It waits on Payments until someone attaches it to the order.
  await page.goto('/admin/payments')
  await expect(page.getByText('SJK7E2E001')).toBeVisible()
  await page.getByLabel('Order number').fill('KTL-01-000001')
  await page.getByRole('button', { name: 'Attach' }).click()
  await expect(page.getByRole('region', { name: 'Matched this week' })).toContainText('Attached to KTL-01-000001 by Tina Owner')

  // Reports, customers and the audit log.
  await page.goto('/admin/reports')
  await expect(page.getByRole('heading', { name: 'Sales by day' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Cement 50kg' }).first()).toBeVisible()
  await expect(page.getByRole('cell', { name: 'M-Pesa' })).toBeVisible()
  const csv = await request.get(
    (await page.getByRole('link', { name: 'Download CSV' }).first().getAttribute('href'))!,
  )
  expect(csv.status()).toBe(403) // the API request context has no session
  await page.goto('/admin/customers')
  await expect(page.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible()
  await page.goto('/admin/audit')
  await expect(page.getByText('Till set up.', { exact: false })).toBeVisible()
  await expect(page.getByText('M-Pesa payment attached.')).toBeVisible()
  await expect(page.getByText('M-Pesa settings saved.').first()).toBeVisible()
})
