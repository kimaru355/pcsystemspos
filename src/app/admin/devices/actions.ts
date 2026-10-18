'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { revokeDevice } from '@/server/services/devices'
import { requireTenant } from '@/server/tenant'
import { done, failure, type FormState } from '../_forms/form-state'
import { text } from '../_forms/parse'

export async function revokeDeviceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await revokeDevice(db, ctx, text(formData, 'deviceId'))
    revalidatePath('/admin/devices')
    return done('Till revoked. It can no longer sync; its unsynced sales stay on the device.')
  } catch (e) {
    return failure(e, 'That till no longer exists.', formData)
  }
}
