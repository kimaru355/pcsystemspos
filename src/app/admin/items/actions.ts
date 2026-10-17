'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { isTaxCategory, type TaxCategory } from '@/domain/tax'
import { DomainError } from '@/server/errors'
import {
  addBarcode,
  addPack,
  createItem,
  removeBarcode,
  updateItem,
  updatePack,
  type ItemInput,
} from '@/server/services/items'
import { requireTenant } from '@/server/tenant'
import { done, failure, type FormState } from '../_forms/form-state'
import { money, optionalId, optionalQty, qty, text } from '../_forms/parse'

const NOT_FOUND = 'That item no longer exists.'

/** `attr:<key>` fields, one per attribute key of the chosen group. */
function attributes(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of formData.entries()) {
    if (name.startsWith('attr:')) out[name.slice(5)] = String(value)
  }
  return out
}

function itemInput(formData: FormData): ItemInput {
  const taxCategory = text(formData, 'taxCategory')
  if (!isTaxCategory(taxCategory)) throw new DomainError('invalid_input', 'Choose a valid tax category.')
  const priceCents = money(formData, 'price')
  // A blank lowest price means "no discount below the price".
  const floorCents = text(formData, 'floor').trim() === '' ? priceCents : money(formData, 'floor')
  return {
    name: text(formData, 'name'),
    groupId: optionalId(formData, 'groupId'),
    categoryId: optionalId(formData, 'categoryId'),
    brandId: optionalId(formData, 'brandId'),
    attributes: attributes(formData),
    sku: text(formData, 'sku'),
    baseUnit: text(formData, 'baseUnit'),
    fractional: formData.get('fractional') === 'on',
    priceCents,
    floorCents,
    taxCategory: taxCategory as TaxCategory,
    lowStockMilli: optionalQty(formData, 'lowStock'),
  }
}

export async function createItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  let id: string
  try {
    id = (await createItem(db, ctx, itemInput(formData))).id
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
  revalidatePath('/admin/items')
  redirect(`/admin/items/${id}`)
}

export async function updateItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const id = text(formData, 'itemId')
  try {
    await updateItem(db, ctx, id, { ...itemInput(formData), active: formData.get('active') === 'on' })
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
  revalidatePath('/admin/items')
  revalidatePath(`/admin/items/${id}`)
  return done('Saved.')
}

function packFields(formData: FormData) {
  const priceCents = money(formData, 'price')
  return {
    name: text(formData, 'name'),
    baseQtyMilli: qty(formData, 'qty'),
    priceCents,
    floorCents: text(formData, 'floor').trim() === '' ? priceCents : money(formData, 'floor'),
  }
}

export async function addPackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const itemId = text(formData, 'itemId')
  try {
    await addPack(db, ctx, itemId, packFields(formData))
  } catch (e) {
    return failure(e, NOT_FOUND, formData)
  }
  revalidatePath(`/admin/items/${itemId}`)
  return done('Pack added.')
}

export async function updatePackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await updatePack(db, ctx, text(formData, 'packId'), {
      ...packFields(formData),
      active: formData.get('active') === 'on',
    })
  } catch (e) {
    return failure(e, 'That pack no longer exists.', formData)
  }
  revalidatePath(`/admin/items/${text(formData, 'itemId')}`)
  revalidatePath('/admin/items')
  return done('Saved.')
}

export async function addBarcodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  const itemId = text(formData, 'itemId')
  try {
    await addBarcode(db, ctx, itemId, {
      barcode: text(formData, 'barcode'),
      packId: optionalId(formData, 'packId'),
    })
  } catch (e) {
    return failure(e, 'That item or pack no longer exists.', formData)
  }
  revalidatePath(`/admin/items/${itemId}`)
  return done('Barcode added.')
}

export async function removeBarcodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await removeBarcode(db, ctx, text(formData, 'barcodeId'))
  } catch (e) {
    return failure(e, 'That barcode is already gone.', formData)
  }
  revalidatePath(`/admin/items/${text(formData, 'itemId')}`)
  return done('Barcode removed.')
}
