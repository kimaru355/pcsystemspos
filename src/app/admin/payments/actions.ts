'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { attachForAdmin } from '@/server/services/mpesa'
import { requireTenant } from '@/server/tenant'
import { done, failure, type FormState } from '../_forms/form-state'
import { text } from '../_forms/parse'

export async function attachPaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    const r = await attachForAdmin(db, ctx, text(formData, 'transactionId'), text(formData, 'orderNumber'))
    revalidatePath('/admin/payments')
    revalidatePath('/admin/orders')
    return done(`Attached to ${r.orderNumber}.`)
  } catch (e) {
    return failure(e, 'That payment or order was not found.', formData)
  }
}
