'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import type { Role } from '@/domain/permissions'
import { DomainError } from '@/server/errors'
import {
  createStaff,
  deactivateStaff,
  reactivateStaff,
  setPin,
  updateStaff,
} from '@/server/services/staff'
import { requireTenant } from '@/server/tenant'

export interface StaffFormState {
  message: string
  ok?: boolean
}

function fail(e: unknown): StaffFormState {
  if (e instanceof DomainError) {
    if (e.code === 'forbidden') return { message: "You don't have permission to do that." }
    if (e.code === 'not_found') return { message: 'That person or outlet no longer exists.' }
    return { message: e.message }
  }
  throw e
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '')
}

function outletIds(formData: FormData): string[] {
  return formData.getAll('outletIds').map(String)
}

export async function createStaffAction(
  _prev: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const ctx = await requireTenant()
  try {
    await createStaff(db, ctx, {
      name: text(formData, 'name'),
      phone: text(formData, 'phone'),
      email: text(formData, 'email'),
      role: text(formData, 'role') as Role,
      outletIds: outletIds(formData),
      tempPassword: text(formData, 'tempPassword'),
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/admin/staff')
  return { message: 'Staff member added. They must change the temporary password at first sign-in.', ok: true }
}

export async function updateStaffAction(
  _prev: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const ctx = await requireTenant()
  try {
    await updateStaff(db, ctx, text(formData, 'membershipId'), {
      role: text(formData, 'role') as Role,
      outletIds: outletIds(formData),
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/admin/staff')
  return { message: 'Saved.', ok: true }
}

export async function setPinAction(
  _prev: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const ctx = await requireTenant()
  try {
    await setPin(db, ctx, text(formData, 'membershipId'), text(formData, 'pin'))
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/admin/staff')
  return { message: 'PIN saved.', ok: true }
}

export async function deactivateStaffAction(
  _prev: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const ctx = await requireTenant()
  try {
    await deactivateStaff(db, ctx, text(formData, 'membershipId'))
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/admin/staff')
  return { message: 'Deactivated.', ok: true }
}

export async function reactivateStaffAction(
  _prev: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const ctx = await requireTenant()
  try {
    await reactivateStaff(db, ctx, text(formData, 'membershipId'))
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/admin/staff')
  return { message: 'Reactivated.', ok: true }
}
