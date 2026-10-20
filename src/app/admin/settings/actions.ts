'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { registerC2BUrls, saveMpesaConfig } from '@/server/services/mpesa'
import { requireTenant } from '@/server/tenant'
import { done, failure, type FormState } from '../_forms/form-state'
import { text } from '../_forms/parse'

const SECRET_FIELDS = ['consumerKey', 'consumerSecret', 'passkey'] as const

export async function saveMpesaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    const outletId = text(formData, 'outletId')
    await saveMpesaConfig(db, ctx, {
      outletId: outletId === '' ? null : outletId,
      environment: text(formData, 'environment') as 'sandbox' | 'production',
      shortcodeType: text(formData, 'shortcodeType') as 'paybill' | 'till',
      shortcode: text(formData, 'shortcode'),
      partyB: text(formData, 'partyB'),
      consumerKey: text(formData, 'consumerKey'),
      consumerSecret: text(formData, 'consumerSecret'),
      passkey: text(formData, 'passkey'),
      active: formData.get('active') === 'on',
    })
    revalidatePath('/admin/settings')
    return done('M-Pesa settings saved.')
  } catch (e) {
    // Credentials are never echoed back into the form.
    return failure(e, 'That outlet no longer exists.', formData, SECRET_FIELDS)
  }
}

export async function registerC2BAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await registerC2BUrls(db, ctx, text(formData, 'configId'))
    revalidatePath('/admin/settings')
    return done('Registered. Paybill and till payments will now reach the system.')
  } catch (e) {
    return failure(e, 'Those settings no longer exist.', formData)
  }
}
