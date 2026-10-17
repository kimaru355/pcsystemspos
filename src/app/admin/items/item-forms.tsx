'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatAmount, formatQty } from '@/domain/money'
import { TAX_CATEGORIES, TAX_LABELS } from '@/domain/tax'
import type { Item } from '@/server/services/items'
import type { CategoryNode } from './category-tree'
import { createItemAction, updateItemAction } from './actions'
import { Field, Message, useKeptForm } from '../_forms/form-kit'

export type GroupOption = {
  id: string
  name: string
  attributeKeys: string[]
  categoryId: string | null
  brandId: string | null
}
export type BrandOption = { id: string; name: string }

export const UNIT_SUGGESTIONS = ['piece', 'sheet', 'bag', 'box', 'kg', 'metre', 'litre', 'roll', 'pair']

/** Category options for a select: top-level entries, with their subcategories grouped beneath. */
export function CategoryOptions({ tree, empty }: { tree: CategoryNode[]; empty: string }) {
  return (
    <>
      <option value="">{empty}</option>
      {tree.map((c) =>
        c.children.length === 0 ? (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ) : (
          <optgroup key={c.id} label={c.name}>
            <option value={c.id}>{c.name} (general)</option>
            {c.children.map((k) => (
              <option key={k.id} value={k.id}>
                {c.name} / {k.name}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </>
  )
}

/** Create (no `item`) or edit one item. Owners only; the page shows managers a read-only summary. */
export function ItemForm({
  item,
  groups,
  categories,
  brands,
}: {
  item?: Item
  groups: GroupOption[]
  categories: CategoryNode[]
  brands: BrandOption[]
}) {
  const f = useKeptForm(item ? updateItemAction : createItemAction)
  const { state, pending } = f
  const [groupId, setGroupId] = useState(item?.groupId ?? '')
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '')
  const [brandId, setBrandId] = useState(item?.brandId ?? '')
  const group = groups.find((g) => g.id === groupId)
  const err = state.errors ?? {}

  function pickGroup(id: string) {
    setGroupId(id)
    const g = groups.find((x) => x.id === id)
    // A group suggests a category and brand, but never overrides a choice already made.
    if (g?.categoryId && categoryId === '') setCategoryId(g.categoryId)
    if (g?.brandId && brandId === '') setBrandId(g.brandId)
  }

  return (
    <form key={f.nonce} action={f.action} className="grid gap-x-4 gap-y-3 sm:grid-cols-2" noValidate>
      {item && <input type="hidden" name="itemId" value={item.id} />}

      <Field id="item-name" label="Name" className="sm:col-span-2">
        {(p) => <input {...p} name="name" required maxLength={200} defaultValue={f.text('name', item?.name ?? '')} />}
      </Field>

      <Field id="item-group" label="Group" hint="Groups add detail fields, like size or colour.">
        {(p) => (
          <select {...p} name="groupId" value={groupId} onChange={(e) => pickGroup(e.target.value)}>
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2 sm:content-start">
        {group?.attributeKeys.map((k) => (
          <Field key={`${group.id}:${k}`} id={`item-attr-${k}`} label={k.replace(/_/g, ' ')}>
            {(p) => (
              <input {...p} name={`attr:${k}`} maxLength={50} defaultValue={f.text(`attr:${k}`, item?.attributes[k] ?? '')} />
            )}
          </Field>
        ))}
      </div>

      <Field id="item-category" label="Category">
        {(p) => (
          <select {...p} name="categoryId" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <CategoryOptions tree={categories} empty="No category" />
          </select>
        )}
      </Field>
      <Field id="item-brand" label="Brand">
        {(p) => (
          <select {...p} name="brandId" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">No brand</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field id="item-sku" label="SKU" hint="Your own code for the item. Optional.">
        {(p) => <input {...p} name="sku" maxLength={64} defaultValue={f.text('sku', item?.sku ?? '')} className={`${p.className} font-mono`} />}
      </Field>
      <Field id="item-unit" label="Base unit" hint="What one unit of stock is, like sheet, kg or metre.">
        {(p) => (
          <>
            <input {...p} name="baseUnit" required maxLength={20} list="unit-suggestions" defaultValue={f.text('baseUnit', item?.baseUnit ?? '')} />
            <datalist id="unit-suggestions">
              {UNIT_SUGGESTIONS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </>
        )}
      </Field>

      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="fractional" defaultChecked={f.checked('fractional', item?.fractional ?? false)} />
        Sold in fractions, like 2.5 metres
      </label>

      <Field id="item-price" label="Price (KES)" error={err.price} hint="Includes VAT.">
        {(p) => (
          <input
            {...p}
            name="price"
            inputMode="decimal"
            required
            placeholder="950 or 1,250.50"
            defaultValue={f.text('price', item ? formatAmount(item.priceCents) : '')}
            className={`${p.className} figures`}
          />
        )}
      </Field>
      <Field id="item-floor" label="Lowest price (KES)" error={err.floor} hint="The least a seller may charge. Blank means the price itself.">
        {(p) => (
          <input
            {...p}
            name="floor"
            inputMode="decimal"
            placeholder="Same as price"
            defaultValue={f.text('floor', item ? formatAmount(item.floorCents) : '')}
            className={`${p.className} figures`}
          />
        )}
      </Field>

      <Field id="item-tax" label="Tax category">
        {(p) => (
          <select {...p} name="taxCategory" defaultValue={f.text('taxCategory', item?.taxCategory ?? 'B')}>
            {TAX_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {TAX_LABELS[c]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="item-low" label="Low stock level" error={err.lowStock} hint="Warn when available stock is at or below this. Blank for none.">
        {(p) => (
          <input
            {...p}
            name="lowStock"
            inputMode="decimal"
            placeholder="e.g. 10"
            defaultValue={f.text('lowStock', item?.lowStockMilli != null ? formatQty(item.lowStockMilli) : '')}
            className={`${p.className} figures`}
          />
        )}
      </Field>

      {item && (
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="active" defaultChecked={f.checked('active', item.active)} />
          Active (inactive items stay in the catalog but are not sold)
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : item ? 'Save item' : 'Create item'}
        </Button>
        <Message state={state} />
      </div>
    </form>
  )
}

