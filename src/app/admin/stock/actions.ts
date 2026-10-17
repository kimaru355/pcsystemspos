'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { formatQty } from '@/domain/money'
import { ADJUST_REASONS, type AdjustReason } from '@/domain/stock'
import { adjustStock, countStock, receiveStock } from '@/server/services/stock'
import { requireTenant } from '@/server/tenant'
import { done, FieldError, failure, type FormState } from '../_forms/form-state'
import { optionalMoney, qty, signedQty, text } from '../_forms/parse'

const signed = (q: number) => (q > 0 ? `+${formatQty(q)}` : formatQty(q))

const NOT_FOUND = 'That item or outlet no longer exists.'

/** Refresh everything that shows these quantities: the lists, this item's pages and the overview tile. */
function refresh(itemId: string) {
  revalidatePath('/admin/stock')
  revalidatePath(`/admin/stock/${itemId}`)
  revalidatePath(`/admin/items/${itemId}`)
  revalidatePath('/admin')
}

export async function receiveStockAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const outletId = text(formData, 'outletId')
  const itemId = text(formData, 'itemId')
  try {
    const m = await receiveStock(db, ctx, {
      outletId,
      itemId,
      qtyMilli: qty(formData, 'qty'),
      unitCostCents: optionalMoney(formData, 'unitCost'),
      note: text(formData, 'note'),
    })
    refresh(itemId)
    return done(`Received ${formatQty(m.qtyMilli)}.`)
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
}

export async function countStockAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const outletId = text(formData, 'outletId')
  const itemId = text(formData, 'itemId')
  try {
    const m = await countStock(db, ctx, {
      outletId,
      itemId,
      countedMilli: qty(formData, 'counted'),
      note: text(formData, 'note'),
    })
    if (m === null) return done('Count matches what is on hand. Nothing changed.')
    refresh(itemId)
    return done(`Count recorded. Stock changed by ${signed(m.qtyMilli)}.`)
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
}

export async function adjustStockAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const outletId = text(formData, 'outletId')
  const itemId = text(formData, 'itemId')
  try {
    const reason = text(formData, 'reason')
    if (!(ADJUST_REASONS as readonly string[]).includes(reason)) {
      throw new FieldError('reason', 'Choose a reason.')
    }
    const note = text(formData, 'note')
    if (reason === 'other' && note.trim() === '') {
      throw new FieldError('note', 'Add a note when the reason is Other.')
    }
    const m = await adjustStock(db, ctx, {
      outletId,
      itemId,
      deltaMilli: signedQty(formData, 'delta'),
      reason: reason as AdjustReason,
      note,
    })
    refresh(itemId)
    return done(`Adjustment recorded. Stock changed by ${signed(m.qtyMilli)}.`)
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
}
