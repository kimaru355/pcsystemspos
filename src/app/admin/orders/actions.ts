'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { formatKes } from '@/domain/money'
import { cancelRemainder, recordRefund, REFUND_METHODS, type RefundMethod } from '@/server/services/orders'
import { resendReceipt } from '@/server/services/receipts'
import { requireTenant } from '@/server/tenant'
import { done, FieldError, failure, type FormState } from '../_forms/form-state'
import { money, text } from '../_forms/parse'

const NOT_FOUND = 'That order no longer exists.'

function refresh(orderId: string) {
  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/stock')
}

export async function cancelRemainderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const orderId = text(formData, 'orderId')
  try {
    await cancelRemainder(db, ctx, orderId, { reason: text(formData, 'reason') })
    refresh(orderId)
    return done('The rest of the order is cancelled. Record a refund if money is going back.')
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
}

export async function refundAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const orderId = text(formData, 'orderId')
  try {
    const method = text(formData, 'method') as RefundMethod
    if (!REFUND_METHODS.includes(method)) throw new FieldError('method', 'Choose how the money went back.')
    const amountCents = money(formData, 'amount')
    await recordRefund(db, ctx, orderId, { amountCents, method, reason: text(formData, 'reason') })
    refresh(orderId)
    return done(`Refund of ${formatKes(amountCents)} recorded.`)
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
}

export async function resendReceiptAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const orderId = text(formData, 'orderId')
  try {
    const channel = text(formData, 'channel')
    if (channel !== 'sms' && channel !== 'email') throw new FieldError('channel', 'Choose SMS or email.')
    const sourceId = text(formData, 'sourceId')
    await resendReceipt(db, ctx, orderId, { sourceId: sourceId === '' ? null : sourceId, channel, to: text(formData, 'to') })
    refresh(orderId)
    return done(channel === 'sms' ? 'SMS queued.' : 'Email queued.')
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
}
