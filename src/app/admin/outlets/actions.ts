'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { DomainError } from '@/server/errors'
import {
  createOutlet,
  setDefaultConnectionMode,
  updateOutlet,
  type ConnectionMode,
} from '@/server/services/outlets'
import { requireTenant } from '@/server/tenant'

export interface OutletFormState {
  message: string
  ok?: boolean
}

function fail(e: unknown): OutletFormState {
  if (e instanceof DomainError) {
    if (e.code === 'forbidden') return { message: "You don't have permission to do that." }
    if (e.code === 'not_found') return { message: 'That outlet no longer exists.' }
    return { message: e.message }
  }
  throw e
}

/** '' = "Use business default" (null). */
function modeField(formData: FormData): ConnectionMode | null {
  const v = String(formData.get('connectionMode') ?? '')
  return v === '' ? null : (v as ConnectionMode)
}

export async function createOutletAction(
  _prev: OutletFormState,
  formData: FormData,
): Promise<OutletFormState> {
  const ctx = await requireTenant()
  try {
    await createOutlet(db, ctx, {
      name: String(formData.get('name') ?? ''),
      code: String(formData.get('code') ?? ''),
      connectionMode: modeField(formData),
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/admin/outlets')
  return { message: 'Outlet created.', ok: true }
}

export async function updateOutletAction(
  _prev: OutletFormState,
  formData: FormData,
): Promise<OutletFormState> {
  const ctx = await requireTenant()
  try {
    await updateOutlet(db, ctx, String(formData.get('outletId') ?? ''), {
      name: String(formData.get('name') ?? ''),
      connectionMode: modeField(formData),
      active: formData.get('active') === 'on',
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/admin/outlets')
  return { message: 'Saved.', ok: true }
}

export async function setDefaultModeAction(
  _prev: OutletFormState,
  formData: FormData,
): Promise<OutletFormState> {
  const ctx = await requireTenant()
  try {
    await setDefaultConnectionMode(db, ctx, String(formData.get('mode') ?? '') as ConnectionMode)
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/admin/outlets')
  return { message: 'Default saved.', ok: true }
}
