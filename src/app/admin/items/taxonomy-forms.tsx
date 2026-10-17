'use client'

import { Button } from '@/components/ui/button'
import type { Brand, Category, ItemGroup } from '@/server/services/taxonomy'
import type { CategoryNode, ParentOption } from './category-tree'
import { CategoryOptions } from './item-forms'
import { Field, Message, useKeptForm } from '../_forms/form-kit'
import {
  createBrandAction,
  createCategoryAction,
  createGroupAction,
  updateBrandAction,
  updateCategoryAction,
  updateGroupAction,
} from './taxonomy-actions'

function ActiveBox({ checked }: { checked: boolean }) {
  return (
    <label className="flex h-9 items-center gap-2 text-sm">
      <input type="checkbox" name="active" defaultChecked={checked} />
      Active
    </label>
  )
}

function ParentOptions({ parents, exclude }: { parents: ParentOption[]; exclude?: string }) {
  return (
    <>
      <option value="">Top level</option>
      {parents
        .filter((p) => p.id !== exclude)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
    </>
  )
}

// ---------------------------------------------------------------- categories

export function CreateCategoryForm({ parents }: { parents: ParentOption[] }) {
  const f = useKeptForm(createCategoryAction)
  const { state, pending } = f
  return (
    <form key={f.nonce} action={f.action} className="flex flex-col gap-2 pt-3" noValidate>
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
        <Field id="new-cat-name" label="New category">
          {(p) => <input {...p} name="name" required maxLength={100} defaultValue={f.text('name')} />}
        </Field>
        <Field id="new-cat-parent" label="Under">
          {(p) => (
            <select {...p} name="parentId" defaultValue={f.text('parentId')}>
              <ParentOptions parents={parents} />
            </select>
          )}
        </Field>
        <Button type="submit" disabled={pending} className="sm:mb-[1.1rem]">
          {pending ? 'Adding…' : 'Add category'}
        </Button>
      </div>
      <Message state={state} />
    </form>
  )
}

export function CategoryRow({
  category,
  parents,
  hasChildren,
  depth,
}: {
  category: Category
  parents: ParentOption[]
  hasChildren: boolean
  depth: 0 | 1
}) {
  const f = useKeptForm(updateCategoryAction)
  const { state, pending } = f
  const id = `cat-${category.id}`
  return (
    <form key={f.nonce} action={f.action} className={`flex flex-col gap-1 border-b border-rule py-2 ${depth === 1 ? 'sm:pl-8' : ''}`} noValidate>
      <input type="hidden" name="id" value={category.id} />
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_14rem_auto_auto] sm:items-end">
        <Field id={`${id}-name`} label={depth === 1 ? 'Subcategory' : 'Category'}>
          {(p) => <input {...p} name="name" required maxLength={100} defaultValue={f.text('name', category.name)} />}
        </Field>
        {hasChildren ? (
          <p className="text-sm text-muted-foreground sm:pb-2">Has subcategories</p>
        ) : (
          <Field id={`${id}-parent`} label="Under">
            {(p) => (
              <select {...p} name="parentId" defaultValue={f.text('parentId', category.parentId ?? '')}>
                <ParentOptions parents={parents} exclude={category.id} />
              </select>
            )}
          </Field>
        )}
        <div className="sm:mb-[1.1rem]">
          <ActiveBox checked={f.checked('active', category.active)} />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={pending} className="sm:mb-[1.1rem]">
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <Message state={state} />
    </form>
  )
}

// -------------------------------------------------------------------- brands

export function CreateBrandForm() {
  const f = useKeptForm(createBrandAction)
  const { state, pending } = f
  return (
    <form key={f.nonce} action={f.action} className="flex flex-col gap-2 pt-3" noValidate>
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field id="new-brand-name" label="New brand">
          {(p) => <input {...p} name="name" required maxLength={100} defaultValue={f.text('name')} />}
        </Field>
        <Button type="submit" disabled={pending} className="sm:mb-[1.1rem]">
          {pending ? 'Adding…' : 'Add brand'}
        </Button>
      </div>
      <Message state={state} />
    </form>
  )
}

export function BrandRow({ brand }: { brand: Brand }) {
  const f = useKeptForm(updateBrandAction)
  const { state, pending } = f
  return (
    <form key={f.nonce} action={f.action} className="flex flex-col gap-1 border-b border-rule py-2" noValidate>
      <input type="hidden" name="id" value={brand.id} />
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <Field id={`brand-${brand.id}-name`} label="Brand">
          {(p) => <input {...p} name="name" required maxLength={100} defaultValue={f.text('name', brand.name)} />}
        </Field>
        <div className="sm:mb-[1.1rem]">
          <ActiveBox checked={f.checked('active', brand.active)} />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={pending} className="sm:mb-[1.1rem]">
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <Message state={state} />
    </form>
  )
}

// -------------------------------------------------------------------- groups

type GroupRefs = { categories: CategoryNode[]; brands: Brand[] }

function GroupFields({
  id,
  group,
  refs,
  f,
}: {
  id: string
  group?: ItemGroup
  refs: GroupRefs
  f: ReturnType<typeof useKeptForm>
}) {
  return (
    <>
      <Field id={`${id}-name`} label={group ? 'Group' : 'New group'}>
        {(p) => <input {...p} name="name" required maxLength={100} defaultValue={f.text('name', group?.name ?? '')} />}
      </Field>
      <Field id={`${id}-attrs`} label="Detail fields" hint="Comma-separated, up to 5, like size, colour.">
        {(p) => (
          <input
            {...p}
            name="attributeKeys"
            placeholder="size, colour"
            defaultValue={f.text('attributeKeys', group?.attributeKeys.join(', ') ?? '')}
          />
        )}
      </Field>
      <Field id={`${id}-category`} label="Category">
        {(p) => (
          <select {...p} name="categoryId" defaultValue={f.text('categoryId', group?.categoryId ?? '')}>
            <CategoryOptions tree={refs.categories} empty="Any category" />
          </select>
        )}
      </Field>
      <Field id={`${id}-brand`} label="Brand">
        {(p) => (
          <select {...p} name="brandId" defaultValue={f.text('brandId', group?.brandId ?? '')}>
            <option value="">Any brand</option>
            {refs.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  )
}

export function CreateGroupForm({ refs }: { refs: GroupRefs }) {
  const f = useKeptForm(createGroupAction)
  const { state, pending } = f
  return (
    <form key={f.nonce} action={f.action} className="flex flex-col gap-2 pt-3" noValidate>
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
        <GroupFields id="new-group" refs={refs} f={f} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add group'}
        </Button>
        <Message state={state} />
      </div>
    </form>
  )
}

export function GroupRow({ group, refs }: { group: ItemGroup; refs: GroupRefs }) {
  const f = useKeptForm(updateGroupAction)
  const { state, pending } = f
  return (
    <form key={f.nonce} action={f.action} className="flex flex-col gap-2 border-b border-rule py-3" noValidate>
      <input type="hidden" name="id" value={group.id} />
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
        <GroupFields id={`group-${group.id}`} group={group} refs={refs} f={f} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ActiveBox checked={f.checked('active', group.active)} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save group'}
        </Button>
        <Message state={state} />
      </div>
    </form>
  )
}
