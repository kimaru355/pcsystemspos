import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { assertTestDatabase } from '../helpers/test-db-guard'

const OWNER_EMAIL = 'catalog@smoke.test'
const OWNER_TEMP_PASSWORD = 'password123'
const OWNER_NEW_PASSWORD = 'newpass1234'
const IMPORT_FILE = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'catalog-import.csv')

// Seeded in beforeAll into the TEST database (the same database the dev server uses).
let ktlOutletId = ''

test.beforeAll(async () => {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://pos:pos@localhost:5433/pos_test'
  assertTestDatabase(url)
  // The db client reads DATABASE_URL when it is first imported, so point it at the test DB first.
  process.env.DATABASE_URL = url

  const { db } = await import('@/db/client')
  const { outlets } = await import('@/db/schema')
  const { createBusinessWithOwner } = await import('@/server/services/platform')

  const { businessId } = await createBusinessWithOwner(db, {
    name: 'Catalog Hardware',
    ownerName: 'Cathy Owner',
    ownerEmail: OWNER_EMAIL,
    ownerPassword: OWNER_TEMP_PASSWORD,
  })
  // The outlet is inserted directly: the outlets service pulls in the tenant module, which imports
  // Next.js runtime modules that Playwright's plain Node process cannot load.
  const [outlet] = await db
    .insert(outlets)
    .values({ businessId, name: 'Kitale', code: 'KTL' })
    .returning({ id: outlets.id })
  ktlOutletId = outlet.id
})

async function logIn(page: Page, identifier: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Phone or email').fill(identifier)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
}

async function changePassword(page: Page, current: string, next: string) {
  await expect(page).toHaveURL(/\/change-password$/)
  await page.getByLabel('Current password').fill(current)
  await page.getByLabel('New password (at least 8 characters)').fill(next)
  await page.getByLabel('Confirm new password').fill(next)
  await page.getByRole('button', { name: 'Change password' }).click()
}

/** Opens a stock row panel. A click before the page has hydrated does nothing, so retry until it opens. */
async function openPanel(row: Locator, name: 'Receive' | 'Adjust') {
  const button = row.getByRole('button', { name, exact: true }).first()
  await expect(async () => {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 })
  }).toPass()
}

const formWith = (page: Page, buttonName: string) =>
  page.locator('form').filter({ has: page.getByRole('button', { name: buttonName, exact: true }) })

test('owner builds a catalog, receives and counts stock, and imports more items', async ({ page }) => {
  // Forced password change, then the admin area.
  await logIn(page, OWNER_EMAIL, OWNER_TEMP_PASSWORD)
  await changePassword(page, OWNER_TEMP_PASSWORD, OWNER_NEW_PASSWORD)
  await expect(page).toHaveURL(/\/admin$/)

  // Category.
  await page.goto('/admin/items/categories')
  await expect(page.getByRole('heading', { name: 'Categories', level: 1 })).toBeVisible()
  const categoryForm = formWith(page, 'Add category')
  await categoryForm.getByLabel('New category').fill('Roofing')
  await categoryForm.getByRole('button', { name: 'Add category' }).click()
  await expect(page.getByLabel('Category', { exact: true })).toHaveValue('Roofing')

  // Item.
  await page.goto('/admin/items/new')
  const itemForm = formWith(page, 'Create item')
  await itemForm.getByLabel('Name', { exact: true }).fill('Iron sheet 30G 3m')
  await itemForm.getByLabel('Base unit').fill('sheet')
  await itemForm.getByLabel('Price (KES)', { exact: true }).fill('950')
  await itemForm.getByLabel('Lowest price (KES)').fill('900')
  await itemForm.getByLabel('Category', { exact: true }).selectOption({ label: 'Roofing' })
  await itemForm.getByLabel('Low stock level').fill('10')
  await itemForm.getByRole('button', { name: 'Create item' }).click()
  await expect(page).toHaveURL(/\/admin\/items\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: 'Iron sheet 30G 3m', level: 1 })).toBeVisible()

  // Pack.
  const packForm = formWith(page, 'Add pack')
  await packForm.getByLabel('New pack name').fill('Bundle')
  await packForm.getByLabel('Quantity (sheet)').fill('20')
  await packForm.getByLabel('Price (KES)', { exact: true }).fill('18,000')
  await packForm.getByRole('button', { name: 'Add pack' }).click()
  await expect(page.getByLabel('Pack name', { exact: true })).toHaveValue('Bundle')

  // Barcode on the base unit.
  const barcodeForm = formWith(page, 'Add barcode')
  await barcodeForm.getByLabel('Barcode', { exact: true }).fill('6001234567890')
  await barcodeForm.getByRole('button', { name: 'Add barcode' }).click()
  await expect(page.getByText('6001234567890')).toBeVisible()
  await expect(page.locator('span', { hasText: 'Base unit (sheet)' })).toBeVisible()

  // Receive 25 at Kitale.
  await page.goto(`/admin/stock?outlet=${ktlOutletId}`)
  const ironRow = page.getByRole('listitem').filter({ hasText: 'Iron sheet 30G 3m' })
  await openPanel(ironRow, 'Receive')
  await ironRow.getByLabel('Quantity (sheet)').fill('25')
  await ironRow.getByRole('button', { name: 'Receive', exact: true }).last().click()
  await expect(ironRow).toContainText(/25\s*sheet/)
  await expect(ironRow.getByText('Low', { exact: true })).toHaveCount(0)

  // Count 8: on hand 8, and the row is marked low (10 is the low-stock level).
  await openPanel(ironRow, 'Adjust')
  await ironRow.getByLabel('Counted (sheet)').fill('8')
  await ironRow.getByRole('button', { name: 'Record count' }).click()
  await expect(ironRow).toContainText(/\b8\s*sheet/)
  await expect(ironRow.getByText('Low', { exact: true }).filter({ visible: true })).toHaveCount(1)

  // The overview shows one low item for KTL.
  await page.goto('/admin')
  const lowRegion = page.getByRole('region', { name: 'Low stock' })
  await expect(lowRegion.getByRole('link', { name: /KTL/ })).toContainText('1 low')

  // Import the fixture: two items, no errors, then confirm.
  await page.goto('/admin/items/import')
  await page.getByLabel('CSV file').setInputFiles(IMPORT_FILE)
  await page.getByRole('button', { name: 'Check file' }).click()
  await expect(page.getByRole('heading', { name: 'Ready to import' })).toBeVisible()
  await expect(page.getByText('2 items, 1 pack, 1 opening stock row.')).toBeVisible()
  await expect(page.getByText(/\d+ errors?/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Import 2 items' }).click()
  await expect(page.getByRole('status')).toContainText('Imported.')

  // Choosing another file drops the old preview, so it can't be imported by mistake.
  const washers = {
    name: 'washers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,base_unit,price\nWashers,pc,5\n'),
  }
  await page.getByLabel('CSV file').setInputFiles(washers)
  await expect(page.getByRole('heading', { name: 'Ready to import' })).toHaveCount(0)

  // A file without SKUs imports once; checking it again warns and needs "Import again anyway".
  await page.getByRole('button', { name: 'Check file' }).click()
  await expect(page.getByRole('heading', { name: 'Ready to import' })).toBeVisible()
  await page.getByRole('button', { name: 'Import 1 item' }).click()
  await expect(page.getByRole('status')).toContainText('Imported.')
  await page.getByLabel('CSV file').setInputFiles(washers)
  await page.getByRole('button', { name: 'Check file' }).click()
  await expect(page.getByText(/This file was already imported on/).first()).toBeVisible()
  await expect(page.getByText(/1 item name in this file already exists/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import 1 item' })).toBeDisabled()
  await page.getByLabel('Import again anyway').check()
  await expect(page.getByRole('button', { name: 'Import 1 item' })).toBeEnabled()

  // The overview shows the import as one line.
  await page.goto('/admin')
  await expect(page.getByText('Catalog imported.').first()).toBeVisible()

  // Both new items are listed.
  await page.goto('/admin/items')
  await expect(page.getByRole('link', { name: 'Cement 50kg' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Wire nails 4in' })).toBeVisible()

  // The stocked one shows 12 at Kitale.
  await page.goto(`/admin/stock?outlet=${ktlOutletId}`)
  const cementRow = page.getByRole('listitem').filter({ hasText: 'Cement 50kg' })
  await expect(cementRow).toContainText(/12\s*bag/)
})
