import { expect, test, type Page } from '@playwright/test'

const OWNER_EMAIL = 'owner@smoke.test'
const OWNER_TEMP_PASSWORD = 'password123'
const OWNER_NEW_PASSWORD = 'newpass1234'
const CASHIER_PHONE = '0712345678'
const CASHIER_TEMP_PASSWORD = 'temp12345'
const CASHIER_NEW_PASSWORD = 'cashier5678'

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

test('owner sets up an outlet and a cashier, who then reaches the till', async ({ page }) => {
  // Owner: forced password change, then the admin area.
  await logIn(page, OWNER_EMAIL, OWNER_TEMP_PASSWORD)
  await changePassword(page, OWNER_TEMP_PASSWORD, OWNER_NEW_PASSWORD)
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

  // Create the outlet.
  await page.getByRole('link', { name: 'Outlets' }).click()
  await expect(page).toHaveURL(/\/admin\/outlets$/)
  await expect(page.getByRole('heading', { name: 'Outlets', level: 1 })).toBeVisible()
  const outletForm = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Create outlet' }),
  })
  await outletForm.getByLabel('Outlet name').fill('Kitale')
  await outletForm.getByLabel('Code (2 to 5 letters or digits)').fill('KTL')
  await outletForm.getByRole('button', { name: 'Create outlet' }).click()
  await expect(page.getByText('KTL', { exact: true })).toBeVisible()

  // Create the cashier at that outlet.
  await page.getByRole('link', { name: 'Staff' }).click()
  await expect(page).toHaveURL(/\/admin\/staff$/)
  await expect(page.getByRole('heading', { name: 'Add a staff member' })).toBeVisible()
  const staffForm = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Add staff member' }),
  })
  await staffForm.getByLabel('Name', { exact: true }).fill('Jane')
  await staffForm.getByLabel('Role').selectOption('cashier')
  await staffForm.getByLabel('Phone (or email)').fill(CASHIER_PHONE)
  await staffForm.getByLabel('Temporary password (min 8 characters)').fill(CASHIER_TEMP_PASSWORD)
  await staffForm.getByLabel('KTL · Kitale').check()
  await staffForm.getByRole('button', { name: 'Add staff member' }).click()
  const janeRow = page.locator('div.rounded-lg.border', { hasText: 'Jane' })
  await expect(janeRow).toContainText('+254712345678')
  await expect(janeRow).toContainText('Outlets: KTL')
  await expect(janeRow).toContainText('PIN: not set')

  // Set her till PIN.
  await janeRow.getByLabel('Set PIN (4 to 6 digits)').fill('4321')
  await janeRow.getByRole('button', { name: 'Set PIN' }).click()
  await expect(janeRow).toContainText('PIN: set')

  // Owner logs out.
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login$/)

  // Cashier: temporary password, forced change, then the till.
  await logIn(page, CASHIER_PHONE, CASHIER_TEMP_PASSWORD)
  await changePassword(page, CASHIER_TEMP_PASSWORD, CASHIER_NEW_PASSWORD)
  await expect(page).toHaveURL(/\/till$/)
  await expect(page.getByText('The till arrives in Phase 3.')).toBeVisible()
})
