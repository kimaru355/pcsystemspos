'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import {
  createBrand,
  createCategory,
  createGroup,
  updateBrand,
  updateCategory,
  updateGroup,
} from '@/server/services/taxonomy'
import { requireTenant } from '@/server/tenant'
import { done, failure, type FormState } from '../_forms/form-state'
import { optionalId, text } from '../_forms/parse'

/** Comma-separated attribute names -> list; blanks are dropped, the service validates the rest. */
function keys(formData: FormData): string[] {
  return text(formData, 'attributeKeys')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')
}

function revalidate(path: string) {
  revalidatePath(path)
  // Item pages and the list read the same options.
  revalidatePath('/admin/items')
}

export async function createCategoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await createCategory(db, ctx, { name: text(formData, 'name'), parentId: optionalId(formData, 'parentId') })
  } catch (e) {
    return failure(e, 'That parent category no longer exists.', formData)
  }
  revalidate('/admin/items/categories')
  return done('Category added.')
}

export async function updateCategoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await updateCategory(db, ctx, text(formData, 'id'), {
      name: text(formData, 'name'),
      // A category with subcategories has no parent field (it stays top-level).
      ...(formData.has('parentId') ? { parentId: optionalId(formData, 'parentId') } : {}),
      active: formData.get('active') === 'on',
    })
  } catch (e) {
    return failure(e, 'That category no longer exists.', formData)
  }
  revalidate('/admin/items/categories')
  return done('Saved.')
}

export async function createBrandAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await createBrand(db, ctx, { name: text(formData, 'name') })
  } catch (e) {
    return failure(e, 'That brand no longer exists.', formData)
  }
  revalidate('/admin/items/brands')
  return done('Brand added.')
}

export async function updateBrandAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await updateBrand(db, ctx, text(formData, 'id'), {
      name: text(formData, 'name'),
      active: formData.get('active') === 'on',
    })
  } catch (e) {
    return failure(e, 'That brand no longer exists.', formData)
  }
  revalidate('/admin/items/brands')
  return done('Saved.')
}

export async function createGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await createGroup(db, ctx, {
      name: text(formData, 'name'),
      categoryId: optionalId(formData, 'categoryId'),
      brandId: optionalId(formData, 'brandId'),
      attributeKeys: keys(formData),
    })
  } catch (e) {
    return failure(e, 'That category or brand no longer exists.', formData)
  }
  revalidate('/admin/items/groups')
  return done('Group added.')
}

export async function updateGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant()
  try {
    await updateGroup(db, ctx, text(formData, 'id'), {
      name: text(formData, 'name'),
      categoryId: optionalId(formData, 'categoryId'),
      brandId: optionalId(formData, 'brandId'),
      attributeKeys: keys(formData),
      active: formData.get('active') === 'on',
    })
  } catch (e) {
    return failure(e, 'That group, category or brand no longer exists.', formData)
  }
  revalidate('/admin/items/groups')
  return done('Saved.')
}
