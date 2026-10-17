# Phase 2 — Catalog and Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners set up the catalog (categories, brands, item groups, items,
packs, barcodes) by hand or from a CSV file, and owners and managers receive,
adjust and watch stock per outlet through a ledger that keeps on-hand exact.

**Architecture:** Same layering as Phase 1:
- Pure rules in `src/domain/` (tax categories, stock arithmetic, CSV parsing,
  import row validation), reusable by the offline till later.
- Database services in `src/server/services/` taking `(db, ctx, input)`.
- Thin server actions and pages under `src/app/admin/`.

Every stock change goes through one helper, `applyMovement`. In a single
transaction it inserts the ledger row and updates the cached `outlet_stock`
row.

**Tech Stack:** Next.js 16.4 (App Router, `cacheComponents: true`), TypeScript
strict, PostgreSQL 17 + Drizzle 0.45 / drizzle-kit 0.31, Zod 4, Vitest 5,
Playwright 1.64, Tailwind 4 + shadcn/ui, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-17-phase2-catalog-design.md`. The
parent spec is `docs/superpowers/specs/2026-10-17-hardware-pos-mvp-design.md`.
UI follows `DESIGN.md` and the shell in `src/components/shell/`.

## Global Constraints

- Money is integer cents (KES), VAT-inclusive. Quantities are integer thousandths (`Milli`). No floats for money or quantity anywhere.
- Every new table has a non-null `business_id`, and every service query filters by `ctx.businessId`. An id from another business, or a malformed id (`isUuid` false), is `not_found`, never `forbidden`.
- An outlet in the business but outside a manager's `outletScope` is `forbidden`.
- Stock quantity columns (`qty_milli`, `on_hand_milli`, `low_stock_milli`, `base_qty_milli`) use `bigint` with `{ mode: 'number' }`. Price columns use `integer`.
- `tax_category` enum is `'A'|'B'|'C'|'D'|'E'`, default `'B'`. VAT rates are derived only by `vatRateBp()`: A 0, B 1600, C 0, D 0, E 800. Items have no `vat_rate_bp` column.
- Adjust reasons: `damaged`, `count_correction`, `lost_stolen`, `other` (`other` requires a note).
- Movement kinds: `receive` (qty > 0), `adjust` (qty ≠ 0), `collect` (qty < 0; not written in this phase).
- Items with `fractional = false` accept only whole base units (multiples of 1000 milli) for stock, low-stock level and pack sizes.
- Nothing in the catalog is hard-deleted except barcode mappings. Deactivate instead.
- Changing `base_unit` or `fractional` is refused (`conflict`) once the item has any stock movement.
- Admin adjustments may not take on-hand below 0 (`invalid_input`).
- Catalog creates and edits, barcode add/remove, every adjustment and the import write audit rows. Receives are recorded by their movement row.
- Permissions:
  - `catalog.manage`: owner.
  - `stock.receive` and `stock.adjust`: owner, plus managers for outlets in scope.
  - `stock.view`: everyone, for outlets in scope.
  - Catalog reads are open to every active member of the business.
- Server-component pages never import runtime values from a `'use client'` module. Shared constants live in `src/domain/`.
- Admin routes: `/admin/items` (+ `/new`, `/[id]`, `/categories`, `/brands`, `/groups`, `/import`) and `/admin/stock` (+ `/[itemId]`). The nav entries already exist in `src/components/shell/nav-config.ts` with `soon: true`.

## Review Focus

1. **Concurrent stock writes:** two adjustments or receives on the same outlet+item at once must leave `outlet_stock.on_hand_milli` equal to the sum of movements. Test in Task 5.
2. **Barcode collisions:** the same barcode on two items, or on an item and another item's pack, in one business is refused. The same barcode in two businesses is allowed. Test in Task 4.
3. **Hostile CSV:** quoted commas, embedded quotes, CRLF, a BOM, blank trailing lines, a duplicate SKU inside the file, unknown columns, an unknown `stock_XYZ` outlet and 5,001 rows. Each gives a precise error or parses correctly. Tests in Task 6.
4. **Fractional mismatch:** receiving 2.5 of a whole-unit item (bags), a low-stock level of 0.5 bags, or a pack of 1.5 bags is refused. 2.5 m of a fractional item is fine. Tests in Tasks 4 and 5.
5. **Manager outside scope:** a manager receiving into an outlet of their business they are not assigned to gets `forbidden`. An outlet id from another business gets `not_found`. Test in Task 5.

---

### Task 1: Domain rules — tax, stock arithmetic, permissions, safe integers

**Files:**
- Create: `src/domain/tax.ts`, `src/domain/stock.ts`
- Modify: `src/domain/permissions.ts`, `src/domain/money.ts`
- Test: `tests/unit/domain/tax.test.ts`, `tests/unit/domain/stock.test.ts`, `tests/unit/domain/permissions.test.ts`, `tests/unit/domain/money.test.ts`

**Interfaces:**
- Produces (`src/domain/tax.ts`):
  - `type TaxCategory = 'A' | 'B' | 'C' | 'D' | 'E'`
  - `TAX_CATEGORIES: readonly TaxCategory[]` (in A–E order)
  - `DEFAULT_TAX_CATEGORY: TaxCategory = 'B'`
  - `TAX_LABELS: Record<TaxCategory, string>`: `'A — Exempt'`, `'B — 16% VAT'`, `'C — Zero-rated'`, `'D — Non-VAT'`, `'E — 8% VAT'`
  - `vatRateBp(cat: TaxCategory): number`
  - `isTaxCategory(v: unknown): v is TaxCategory`
- Produces (`src/domain/stock.ts`):
  - `type MovementKind = 'receive' | 'adjust' | 'collect'`
  - `type AdjustReason = 'damaged' | 'count_correction' | 'lost_stolen' | 'other'`
  - `ADJUST_REASONS: readonly AdjustReason[]`
  - `ADJUST_REASON_LABELS: Record<AdjustReason, string>`: `'Damaged'`, `'Count correction'`, `'Lost or stolen'`, `'Other'`
  - `isWholeUnits(qtyMilli: Milli): boolean`
  - `countToDelta(onHandMilli: Milli, countedMilli: Milli): Milli` (counted − onHand)
  - `availableMilli(onHandMilli: Milli, owedMilli: Milli): Milli`
  - `isLowStock(available: Milli, lowStockMilli: Milli | null): boolean`
- Modifies (`src/domain/permissions.ts`):
  - `Action` gains `'catalog.manage' | 'stock.receive' | 'stock.adjust' | 'stock.view'`.
  - Manager: `staff.reset_pin`, `stock.receive`, `stock.adjust`, `stock.view`.
  - Cashier: `stock.view`.
  - Owner: all.
- Modifies (`src/domain/money.ts`):
  - `parseQty` and `parseMoney` throw `RangeError` when the result is not `Number.isSafeInteger`.
  - `lineGross` throws `RangeError` when `qtyMilli * unitPriceCents` is not a safe integer.

- [ ] **Step 1: Write failing tests**
  - Tax:
    - `vatRateBp('B') === 1600`, `vatRateBp('E') === 800`.
    - A, C and D each give `0`.
    - `TAX_CATEGORIES` deep-equals `['A','B','C','D','E']`.
    - `isTaxCategory('F') === false`.
    - `TAX_LABELS.B === 'B — 16% VAT'`.
  - Stock:
    - `isWholeUnits(3000) === true`, `isWholeUnits(2500) === false`, `isWholeUnits(0) === true`.
    - `countToDelta(50000, 47000) === -3000`, `countToDelta(0, 5000) === 5000`.
    - `availableMilli(10000, 4000) === 6000`.
    - `isLowStock(8000, 10000) === true`, `isLowStock(10000, 10000) === true`, `isLowStock(10001, 10000) === false`, `isLowStock(0, null) === false`.
  - Permissions: extend the existing typed matrix with the four new actions per the role rules above. The matrix type makes a missing entry a compile error.
  - Money:
    - `parseQty('9007199254740.993')` throws.
    - `parseMoney('90071992547409.93')` throws.
    - `lineGross(Number.MAX_SAFE_INTEGER, 2)` throws.
    - All existing money tests still pass.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement.** No imports outside `src/domain/`.
- [ ] **Step 4: Run** `npm test` → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(domain): tax categories, stock rules, catalog permissions`.

---

### Task 2: Schema — catalog, ledger, cached stock, Phase 1 indexes

**Files:**
- Create: `src/db/schema/catalog.ts`, `src/db/schema/stock.ts`
- Modify: `src/db/schema/index.ts`, `src/db/schema/auth.ts`, `src/db/schema/tenancy.ts`
- Create: generated migration in `drizzle/`
- Test: `tests/integration/catalog-schema.test.ts`

**Interfaces:**
- Produces (relative imports only; drizzle-kit can't resolve `@/`):
  - Enums: `taxCategory` (`'tax_category'`: A–E), `movementKind` (`'movement_kind'`: receive, adjust, collect), `adjustReason` (`'adjust_reason'`: damaged, count_correction, lost_stolen, other).
  - `categories`:
    - Columns: `id`, `business_id` fk, `parent_id` fk → categories null, `name`, `sort_order integer default 0`, `active default true`, `created_at`, `updated_at`.
    - `unique('categories_business_parent_name_unique').on(businessId, parentId, name).nullsNotDistinct()`.
  - `brands`: `id`, `business_id`, `name`, `active`, `created_at`. Unique (business_id, name).
  - `item_groups`: `id`, `business_id`, `name`, `category_id` null fk, `brand_id` null fk, `attribute_keys text[] not null default '{}'`, `active`, `created_at`, `updated_at`. Unique (business_id, name).
  - `items`:
    - Columns: `id`, `business_id`, `group_id` null fk, `category_id` null fk, `brand_id` null fk, `name`, `attributes jsonb not null default '{}'`, `sku text null`, `base_unit text`, `fractional bool default false`, `price_cents integer`, `floor_cents integer`, `tax_category default 'B'`, `low_stock_milli bigint null`, `active`, `created_at`, `updated_at`.
    - Partial unique index `items_business_sku_unique` on (business_id, sku) where sku is not null.
    - Check `items_floor_le_price` (`floor_cents >= 0 and floor_cents <= price_cents`).
  - `item_packs`:
    - Columns: `id`, `business_id`, `item_id` fk, `name`, `base_qty_milli bigint`, `price_cents integer`, `floor_cents integer`, `active`, `created_at`.
    - Unique (item_id, name) and unique (id, item_id).
    - Checks: `base_qty_milli > 0`; `0 <= floor_cents <= price_cents`.
  - `item_barcodes`:
    - Columns: `id`, `business_id`, `barcode text`, `item_id` fk, `pack_id uuid null`, `created_at`.
    - Unique (business_id, barcode).
    - Composite FK (pack_id, item_id) → item_packs(id, item_id).
  - `stock_movements`:
    - Columns: `id uuid pk default random`, `business_id`, `outlet_id` fk, `item_id` fk, `kind`, `qty_milli bigint`, `unit_cost_cents integer null`, `reason adjust_reason null`, `note text null`, `order_line_id uuid null`, `actor_user_id` fk users, `device_id uuid null`, `occurred_at timestamptz`, `created_at`.
    - Checks: `qty_milli <> 0`; `kind <> 'receive' or qty_milli > 0`; `kind <> 'collect' or qty_milli < 0`; `kind <> 'adjust' or reason is not null`; `reason <> 'other' or note is not null`.
    - Index (business_id, outlet_id, item_id, occurred_at).
  - `outlet_stock`: `outlet_id` fk, `item_id` fk, `business_id`, `on_hand_milli bigint not null default 0`, `flagged_negative_at timestamptz null`. pk (outlet_id, item_id).
- Phase 1 follow-ups in the same migration:
  - Indexes on `sessions(user_id)`, `memberships(business_id)`, `membership_outlets(outlet_id)`.
  - Unique index `users_email_lower_unique` on `lower(email)`.
  - Check `outlets_code_format` (`code ~ '^[A-Z0-9]{2,5}$'`).

- [ ] **Step 1: Write the schema files** per the list. Export all tables and enums from `src/db/schema/index.ts`.
- [ ] **Step 2: Generate the migration** with `npm run db:generate`. This should produce one new SQL file. Check that it contains `NULLS NOT DISTINCT` and the partial index `WHERE`.
- [ ] **Step 3: Write failing tests** in `catalog-schema.test.ts`, using `seedBusiness` and inserting with Drizzle:
  - two top-level categories named "Roofing" in one business → unique violation (23505); the same name under two different parents → ok;
  - two items with sku `IS-30` in one business → 23505; two items with null sku → ok; the same sku in another business → ok;
  - an item with floor > price → 23514;
  - a pack with `base_qty_milli` 0 → 23514;
  - a barcode row with a `pack_id` belonging to a different item → FK violation 23503;
  - the same barcode twice in one business → 23505; in another business → ok;
  - a `receive` movement with negative qty → 23514; an `adjust` without reason → 23514; reason `other` without note → 23514;
  - two users whose emails differ only in case → 23505;
  - an outlet with code `'k1'` → 23514.
- [ ] **Step 4: Run** `npm run test:int` → PASS (all prior tests too). Run `npm run db:migrate` on the dev DB; it should succeed.
- [ ] **Step 5: Commit** `feat(db): catalog, stock ledger and cached stock schema`.

---

### Task 3: Taxonomy services — categories, brands, item groups

**Files:**
- Create: `src/server/services/taxonomy.ts`
- Test: `tests/integration/taxonomy.test.ts`

**Interfaces:**
- Consumes: `TenantCtx`, `assertCan`, `DomainError`, `recordAudit`, `isUniqueViolation`, `isUuid`. Follow the patterns in `src/server/services/outlets.ts`: validate before the transaction, write and audit in one transaction.
- Produces:
  - `type Category = { id: string; parentId: string | null; name: string; sortOrder: number; active: boolean }`
  - `listCategories(db: Db, ctx: TenantCtx): Promise<Category[]>`: ordered by sortOrder, then name.
  - `createCategory(db, ctx, i: { name: string; parentId: string | null; sortOrder?: number }): Promise<Category>`
  - `updateCategory(db, ctx, id: string, patch: Partial<{ name: string; parentId: string | null; sortOrder: number; active: boolean }>): Promise<Category>`
  - `type Brand = { id: string; name: string; active: boolean }`
  - `listBrands(db, ctx)`, `createBrand(db, ctx, i: { name: string })`, `updateBrand(db, ctx, id, patch: Partial<{ name: string; active: boolean }>)`
  - `type ItemGroup = { id: string; name: string; categoryId: string | null; brandId: string | null; attributeKeys: string[]; active: boolean }`
  - `listGroups(db, ctx)`, `createGroup(db, ctx, i: { name: string; categoryId?: string | null; brandId?: string | null; attributeKeys: string[] })`, `updateGroup(db, ctx, id, patch: Partial<{ name; categoryId; brandId; attributeKeys; active }>)`
- Rules:
  - All writes need `catalog.manage`. Lists are open to any ctx.
  - Names are trimmed, 1–100 chars, otherwise `invalid_input`. A duplicate name in the same scope is `conflict`.
  - A category's parent must be an existing top-level category of the business. A foreign or malformed parent is `not_found`. A parent that is itself a child gives `invalid_input`.
  - A category may not be its own parent (`invalid_input`). A category that has children cannot be given a parent (`invalid_input`).
  - `attributeKeys`: each is trimmed and lower-cased and must match `/^[a-z][a-z0-9_]{0,29}$/`. At most 5 keys, no duplicates, otherwise `invalid_input`.
  - Group `categoryId` and `brandId` must belong to the business (`not_found`).
  - Audit actions: `category.create`, `category.update`, `brand.create`, `brand.update`, `group.create`, `group.update`. Updates carry before/after data.

- [ ] **Step 1: Write failing tests** covering every rule above:
  - manager → `forbidden`;
  - a cross-business parent id, brand id or category id → `not_found`;
  - `updateCategory` on another business's id → `not_found` with no change;
  - an attribute key `'Size'` is stored as `'size'`; `'1size'` → `invalid_input`; 6 keys → `invalid_input`;
  - each write leaves exactly one audit row.
- [ ] **Step 2: Run** `npm run test:int` → FAIL. **Implement.** Run → PASS.
- [ ] **Step 3: Commit** `feat(catalog): categories, brands and item groups`.

---

### Task 4: Item services — items, packs, barcodes, barcode lookup

**Files:**
- Create: `src/server/services/items.ts`
- Test: `tests/integration/items.test.ts`

**Interfaces:**
- Consumes: Task 1 (`TaxCategory`, `isTaxCategory`, `vatRateBp`, `DEFAULT_TAX_CATEGORY`, `isWholeUnits`), Task 2 tables, Task 3 types, plus the Phase 1 helpers.
- Produces:
  - `type Pack = { id: string; name: string; baseQtyMilli: Milli; priceCents: Cents; floorCents: Cents; active: boolean }`
  - `type Barcode = { id: string; barcode: string; packId: string | null }`
  - `type ItemInput = { name: string; groupId?: string | null; categoryId?: string | null; brandId?: string | null; attributes?: Record<string, string>; sku?: string | null; baseUnit: string; fractional: boolean; priceCents: Cents; floorCents: Cents; taxCategory?: TaxCategory; lowStockMilli: Milli | null }`
  - `type Item = Required<Omit<ItemInput, 'taxCategory'>> & { id: string; taxCategory: TaxCategory; vatRateBp: number; active: boolean; packs: Pack[]; barcodes: Barcode[] }`, where nullable fields stay `string | null`.
  - `type ItemListRow = Omit<Item, 'packs' | 'barcodes'> & { packCount: number; categoryName: string | null }`
  - `listItems(db: Db, ctx: TenantCtx, q?: { search?: string; categoryId?: string; active?: boolean }): Promise<ItemListRow[]>`
    - `search` matches name (ILIKE), sku or any barcode exactly.
    - A `categoryId` that is a top-level category also includes its children.
    - Ordered by name.
  - `getItem(db, ctx, id: string): Promise<Item>`
  - `createItem(db, ctx, i: ItemInput): Promise<Item>`
  - `updateItem(db, ctx, id: string, patch: Partial<ItemInput & { active: boolean }>): Promise<Item>`
  - `addPack(db, ctx, itemId: string, i: { name: string; baseQtyMilli: Milli; priceCents: Cents; floorCents: Cents }): Promise<Pack>`
  - `updatePack(db, ctx, packId: string, patch: Partial<{ name: string; baseQtyMilli: Milli; priceCents: Cents; floorCents: Cents; active: boolean }>): Promise<Pack>`
  - `addBarcode(db, ctx, itemId: string, i: { barcode: string; packId: string | null }): Promise<Barcode>`
  - `removeBarcode(db, ctx, barcodeId: string): Promise<void>`
  - `lookupBarcode(db, ctx, barcode: string): Promise<{ item: Item; pack: Pack | null } | null>`
- Rules:
  - Writes need `catalog.manage`; reads are open.
  - Text fields:
    - `name`: trimmed, 1–200 chars.
    - `baseUnit`: trimmed and lower-cased, 1–20 chars.
    - `sku`: trimmed, empty → null, max 64. A duplicate is `conflict` with the message "That SKU is already used."
  - Prices:
    - `priceCents` and `floorCents` are safe integers ≥ 0.
    - `floorCents ≤ priceCents`, otherwise `invalid_input` "The lowest price can't be above the price."
  - `lowStockMilli` is null or ≥ 0, and a whole unit when `fractional` is false.
  - References:
    - `groupId`, `categoryId` and `brandId` must belong to the business (`not_found`).
    - With a group, every attribute key must be one of the group's `attributeKeys` (`invalid_input`).
    - Attribute values are trimmed, 1–50 chars. Empty values are dropped.
  - Changing `baseUnit` or `fractional` when any `stock_movements` row exists for the item → `conflict` "This item already has stock history; its unit can't change."
  - Packs:
    - `baseQtyMilli > 0`, and whole when the item isn't fractional.
    - Name is 1–40 chars and unique per item (`conflict`).
    - Same price and floor rules as the item.
  - Barcodes:
    - Trimmed, must match `/^[0-9A-Za-z.\-]{1,64}$/`.
    - Unique per business across all items and packs (`conflict` "That barcode is already used.").
    - `packId` must be a pack of that item (`not_found`).
  - `lookupBarcode` returns `null` for unknown barcodes and for inactive items. It returns `pack: null` for base-unit barcodes.
  - Audit actions: `item.create`, `item.update` (before/after, including price changes), `pack.create`, `pack.update`, `barcode.add`, `barcode.remove`.

- [ ] **Step 1: Write failing tests**, including:
  - create an item "Iron sheet 30G 3m": unit `sheet`, price 95000, floor 90000, no tax category → `taxCategory 'B'`, `vatRateBp 1600`;
  - add pack "Bundle", 20000 milli, price 1800000 → ok;
  - Review Focus 4:
    - a pack of 1500 on a non-fractional item → `invalid_input`;
    - `lowStockMilli` 500 on a non-fractional item → `invalid_input`;
    - a fractional "Wire mesh" with pack 2500 → ok;
  - Review Focus 2:
    - barcode `6001234567890` on item A, then on item B → `conflict`;
    - the same barcode on item B's pack → `conflict`;
    - the same barcode in another business → ok;
  - `lookupBarcode` of the pack's barcode → `{ item: A, pack: Bundle }`;
  - floor > price → `invalid_input`;
  - duplicate SKU → `conflict`;
  - `updateItem` changing `baseUnit` after inserting a `receive` movement directly → `conflict`;
  - a cross-business item, pack or barcode id → `not_found`;
  - manager `createItem` → `forbidden`;
  - search by an exact barcode finds the item;
  - a top-level category filter includes items in its child category;
  - one audit row per write.
- [ ] **Step 2: Run** `npm run test:int` → FAIL. **Implement.** Run → PASS.
- [ ] **Step 3: Commit** `feat(catalog): items, packs and barcodes`.

---

### Task 5: Stock services — ledger, receive, adjust, count, lists, history

**Files:**
- Create: `src/server/services/stock.ts`
- Test: `tests/integration/stock.test.ts`

**Interfaces:**
- Consumes: Task 1 (`isWholeUnits`, `countToDelta`, `availableMilli`, `isLowStock`, `AdjustReason`, `ADJUST_REASONS`, `MovementKind`), Task 2 tables, Task 4 (`Item`), plus the Phase 1 helpers.
- Produces:
  - `type Movement = { id: string; outletId: string; itemId: string; kind: MovementKind; qtyMilli: Milli; unitCostCents: Cents | null; reason: AdjustReason | null; note: string | null; actorUserId: string; actorName: string; occurredAt: Date; createdAt: Date }`
  - `type NewMovement = { businessId: string; outletId: string; itemId: string; kind: MovementKind; qtyMilli: Milli; unitCostCents?: Cents | null; reason?: AdjustReason | null; note?: string | null; actorUserId: string; occurredAt?: Date; id?: string }`
  - `applyMovement(tx: Tx, m: NewMovement): Promise<{ movementId: string; onHandMilli: Milli }>`
    - Locks the `outlet_stock` row: insert with on-hand 0 on conflict do nothing, then `SELECT … FOR UPDATE`.
    - Inserts the movement and sets `on_hand_milli += qty`.
    - Sets `flagged_negative_at` (when null) if the result is below 0, and clears it if the result is ≥ 0.
    - No permission checks. Callers own those. Also used by the CSV import and Phase 4.
  - `type StockRow = { itemId: string; itemName: string; sku: string | null; baseUnit: string; fractional: boolean; categoryId: string | null; onHandMilli: Milli; owedMilli: Milli; availableMilli: Milli; lowStockMilli: Milli | null; isLow: boolean; negative: boolean }`
  - `owedMilliFor(db: Db | Tx, outletId: string, itemIds: string[]): Promise<Map<string, Milli>>`: every value is 0 in this phase; Phase 4 fills it in.
  - `listStock(db, ctx, outletId: string, f?: { search?: string; categoryId?: string; lowOnly?: boolean; negativeOnly?: boolean }): Promise<StockRow[]>`
    - Needs `stock.view` and the outlet in scope.
    - Returns active items only, including items with no `outlet_stock` row (on-hand 0).
    - Ordered by item name.
  - `receiveStock(db, ctx, i: { outletId: string; itemId: string; qtyMilli: Milli; unitCostCents?: Cents | null; note?: string | null }): Promise<Movement>`
  - `adjustStock(db, ctx, i: { outletId: string; itemId: string; deltaMilli: Milli; reason: AdjustReason; note?: string | null }): Promise<Movement>`
  - `countStock(db, ctx, i: { outletId: string; itemId: string; countedMilli: Milli; note?: string | null }): Promise<Movement | null>`: reason `count_correction`; `null` when the count equals on-hand.
  - `itemHistory(db, ctx, outletId: string, itemId: string, limit = 100): Promise<Movement[]>`: newest first.
  - `lowStockCounts(db, ctx): Promise<{ outletId: string; count: number }[]>`: for active outlets in scope.
- Rules:
  - Outlet checks:
    - Outlet id malformed or from another business → `not_found`.
    - Outlet in the business but outside a manager's scope → `forbidden`.
    - Inactive outlet → `invalid_input` for receive, adjust and count.
  - Item checks:
    - Item id malformed or from another business → `not_found`.
    - Inactive item → `invalid_input`.
  - Quantities:
    - Receive qty > 0.
    - Adjust delta ≠ 0.
    - Counted ≥ 0.
    - All whole when the item isn't fractional (`invalid_input`).
  - Unit cost is null or a safe integer ≥ 0.
  - Reason `other` requires a non-empty note. Notes are max 200 chars.
  - Adjust or count that would leave on-hand < 0 → `invalid_input` "That would take stock below zero." The check happens inside the locked transaction.
  - Audit: `stock.adjust` for adjust and count, with `{ outletId, itemId, deltaMilli, reason }`. Written in the same transaction as the movement.

- [ ] **Step 1: Write failing tests**, including:
  - receive 25000 to KTL → on-hand 25000, a `receive` movement, actor named;
  - count 8000 → one `count_correction` movement of −17000, on-hand 8000, one audit row;
  - count 8000 again → `null`, no movement;
  - adjust −9000 → `invalid_input`, nothing written;
  - adjust −1000 `damaged` → on-hand 7000;
  - adjust with reason `other` and no note → `invalid_input`;
  - `listStock` with a low-stock level of 10000 → `isLow true`; `lowOnly` returns just that row;
  - an item with no movements appears with on-hand 0;
  - `lowStockCounts` → `[{ outletId: KTL, count: 1 }]`;
  - `itemHistory` is newest first;
  - Review Focus 1: 10 concurrent `receiveStock` of 1000 plus 5 concurrent `adjustStock` of −1000 (Promise.all) → on-hand equals the SQL `sum(qty_milli)` for that outlet+item, which is 5000 more than before;
  - Review Focus 4: receive 2500 of a non-fractional item → `invalid_input`;
  - Review Focus 5: manager assigned to KTL receiving into ELD → `forbidden`; another business's outlet → `not_found`;
  - cashier `receiveStock` → `forbidden`;
  - `applyMovement` with a `collect` of −30000 on on-hand 8000 → on-hand −22000 with `flagged_negative_at` set; a following `receive` of 30000 → 8000 and the flag cleared.
- [ ] **Step 2: Run** `npm run test:int` → FAIL. **Implement.** Run → PASS.
- [ ] **Step 3: Commit** `feat(stock): stock ledger, receive, adjust and count`.

---

### Task 6: CSV import — parser, row validation, preview and apply

**Files:**
- Create: `src/domain/csv.ts`, `src/domain/catalog-import.ts`, `src/server/services/catalog-import.ts`
- Test: `tests/unit/domain/csv.test.ts`, `tests/unit/domain/catalog-import.test.ts`, `tests/integration/catalog-import.test.ts`

**Interfaces:**
- Produces (`src/domain/csv.ts`):
  - `parseCsv(text: string): string[][]`, RFC 4180:
    - strips a leading BOM;
    - handles quoted fields, `""` escapes, commas and newlines inside quotes, and CRLF or LF;
    - drops fully blank trailing lines;
    - throws `RangeError` on an unterminated quote.
  - `toCsv(rows: string[][]): string`: quotes fields that contain a comma, quote or newline.
- Produces (`src/domain/catalog-import.ts`):
  - `IMPORT_COLUMNS: readonly string[]`, in this order: `name, group, category, subcategory, brand, sku, barcode, base_unit, fractional, price, floor, tax_category, low_stock, pack1_name, pack1_qty, pack1_price, pack1_floor, pack1_barcode, pack2_name, pack2_qty, pack2_price, pack2_floor, pack2_barcode`
  - `MAX_IMPORT_ROWS = 5000`
  - `type ImportPack = { name: string; baseQtyMilli: Milli; priceCents: Cents; floorCents: Cents; barcode: string | null }`
  - `type ImportRow = { line: number; name: string; group: string | null; category: string | null; subcategory: string | null; brand: string | null; sku: string | null; barcode: string | null; baseUnit: string; fractional: boolean; priceCents: Cents; floorCents: Cents; taxCategory: TaxCategory; lowStockMilli: Milli | null; packs: ImportPack[]; stock: Record<string, Milli> }` (stock is keyed by outlet code)
  - `type ImportError = { line: number | null; column: string | null; message: string }`
  - `validateImport(table: string[][], outletCodes: string[]): { rows: ImportRow[]; errors: ImportError[] }`:
    - The header is required. Columns are matched case-insensitively after trimming. Allowed columns are `IMPORT_COLUMNS` plus `stock_<CODE>`.
    - An unknown column is an error with line 1. A `stock_<CODE>` for a code not in `outletCodes` is an error. Required columns are `name`, `base_unit` and `price`.
    - Line numbers are file lines (header = 1).
    - Value rules match Task 4 and the spec §9:
      - `fractional` accepts yes/no/true/false/1/0 or blank (= false).
      - `floor` blank = price. `tax_category` blank = `B`.
      - A pack needs name, qty and price when any of its fields are set.
      - `subcategory` without `category` is an error.
      - Stock cells: blank or 0 = none; otherwise parsed with `parseQty` and must be whole for non-fractional items.
    - A SKU or barcode (item or pack) repeated within the file is an error on the later line.
    - More than `MAX_IMPORT_ROWS` data rows is one error with line null.
  - `importTemplateCsv(outletCodes: string[]): string`: header row plus one example row ("Iron sheet 30G 3m", sheet, 950, with a Bundle pack of 20 at 18,000).
- Produces (`src/server/services/catalog-import.ts`):
  - `type ImportPreview = { rowCount: number; itemCount: number; packCount: number; newCategories: string[]; newBrands: string[]; newGroups: string[]; stockCells: number; errors: ImportError[] }`
  - `previewImport(db: Db, ctx: TenantCtx, csvText: string): Promise<ImportPreview>`
    - Needs `catalog.manage`. Text longer than 2,000,000 chars → `invalid_input`.
    - Runs `validateImport` against the business's active outlet codes.
    - Adds DB checks: SKUs or barcodes already in the business are errors on their line.
    - Lists categories, brands and groups that would be created, matched case-insensitively.
  - `applyImport(db: Db, ctx: TenantCtx, csvText: string): Promise<{ itemCount: number; packCount: number; stockCells: number }>`
    - Re-runs the preview. Any error → `invalid_input` with the first error's message, and nothing is written.
    - In one transaction:
      - creates the missing categories, subcategories, brands and groups;
      - creates the items, packs and barcodes;
      - for each non-zero stock cell, calls `applyMovement` with a `receive` and note `'Opening stock'`;
      - writes one `catalog.import` audit row with the counts.

- [ ] **Step 1: Write failing unit tests**
  - csv:
    - `parseCsv('a,"b,c","d ""q"""\r\n1,2,3\r\n\r\n')` → `[['a','b,c','d "q"'],['1','2','3']]`;
    - a BOM is stripped;
    - a newline inside quotes is kept;
    - an unterminated quote throws;
    - `parseCsv(toCsv(rows))` round-trips rows containing commas, quotes and newlines.
  - catalog-import (Review Focus 3):
    - a valid two-row table with a pack and `stock_KTL` → 2 rows and 0 errors, `stock.KTL` = 25000;
    - a duplicate SKU on line 3 → an error `{ line: 3, column: 'sku' }`;
    - an unknown column `colour` → a line-1 error;
    - `stock_XYZ` → an error;
    - price `abc` → `{ column: 'price' }`;
    - a non-fractional stock of `2.5` → an error;
    - 5,001 data rows → exactly one error with line null;
    - a missing `name` header → an error;
    - `fractional` of `maybe` → an error.
- [ ] **Step 2: Write failing integration tests**
  - preview of a file whose SKU already exists → an error on that line;
  - preview lists `newCategories` (case-insensitive match with an existing "Roofing" → not new);
  - apply creates the items, packs and barcodes, an on-hand of 25000 at KTL from an "Opening stock" receive, and one audit row;
  - apply with an error → `invalid_input`, and the item, movement and audit counts are unchanged;
  - manager → `forbidden`.
- [ ] **Step 3: Run** both suites → FAIL. **Implement.** Run → PASS.
- [ ] **Step 4: Commit** `feat(catalog): CSV import with preview`.

---

### Task 7: Admin UI — Items, item page, categories, brands, groups

**Files:**
- Create: `src/app/admin/items/page.tsx`, `src/app/admin/items/new/page.tsx`, `src/app/admin/items/[id]/page.tsx`, `src/app/admin/items/actions.ts`, `src/app/admin/items/item-forms.tsx`, `src/app/admin/items/categories/page.tsx`, `src/app/admin/items/brands/page.tsx`, `src/app/admin/items/groups/page.tsx`, `src/app/admin/items/taxonomy-actions.ts`, `src/app/admin/items/taxonomy-forms.tsx`
- Modify: `src/components/shell/nav-config.ts` (remove `soon` from Items)

**Interfaces:**
- Consumes: Tasks 3 and 4 services, `TAX_CATEGORIES` and `TAX_LABELS`, `parseMoney`, `parseQty`, `formatKes`, `formatQty`, `requireTenant`, and the shell components. Follow the existing patterns in `src/app/admin/outlets/` and `src/app/admin/staff/` (server page plus client forms, `useActionState`, DomainError → message, unexpected errors rethrown).

- [ ] **Step 1: Items list** (`/admin/items`)
  - Search box (name, SKU, barcode), category filter, active filter via search params.
  - Rows show name, category, unit, price (`formatKes`), pack count and active.
  - Owners get "New item", "Import" and links to Categories, Brands and Groups. Managers see it read-only.
- [ ] **Step 2: Item form** (`/new` and `/[id]`)
  - Fields: name, group (choosing one shows a text field per attribute key), category (2-level select), brand, SKU, base unit, fractional, price and lowest price (typed as KES like `950` or `1,250.50`), tax category (select with `TAX_LABELS`), low-stock level, active.
  - Below the form:
    - Packs section: list, add, edit and deactivate.
    - Barcodes section: list, add with a unit select ("Base unit" or a pack), remove with a confirm step.
    - Stock-per-outlet summary: read-only on-hand for outlets in scope, linking to `/admin/stock?outlet=…`.
  - Field errors show the service messages.
- [ ] **Step 3: Categories, brands, groups**
  - Lists with inline create, rename and activate/deactivate.
  - Categories show as a 2-level tree with a parent select limited to top-level categories.
  - Groups edit the name, category, brand and attribute keys (comma-separated input).
- [ ] **Step 4: Nav.** Remove `soon` from the Items entry.
- [ ] **Step 5: Verify**
  - `npx tsc --noEmit`, `npm run lint` and `npm run build` are clean.
  - Render check: as the owner and as a manager, against `next start` on the dev DB with a session cookie, `/admin/items`, `/admin/items/new`, an item page and `/admin/items/categories` each return 200 with the expected content.
  - Managers see no edit forms.
- [ ] **Step 6: Commit** `feat(admin): items, packs, barcodes and taxonomy screens`.

---

### Task 8: Admin UI — Stock, item history, import, overview low-stock

**Files:**
- Create: `src/app/admin/stock/page.tsx`, `src/app/admin/stock/[itemId]/page.tsx`, `src/app/admin/stock/actions.ts`, `src/app/admin/stock/stock-forms.tsx`, `src/app/admin/items/import/page.tsx`, `src/app/admin/items/import/actions.ts`, `src/app/admin/items/import/import-form.tsx`, `src/app/admin/items/import/template/route.ts`
- Modify: `src/app/admin/page.tsx` (low-stock tile), `src/components/shell/nav-config.ts` (remove `soon` from Stock)

**Interfaces:**
- Consumes: Task 5 services, Task 6 (`previewImport`, `applyImport`, `importTemplateCsv`), `listOutlets`, `ADJUST_REASONS` and `ADJUST_REASON_LABELS`, the formatters and parsers.

- [ ] **Step 1: Stock page** (`/admin/stock?outlet=<id>`)
  - Outlet picker over outlets in scope, defaulting to the first.
  - Filters: search, category, low only, negative only.
  - Rows show item, on-hand, available and low-stock level (all `formatQty` plus unit). Low and negative rows are marked as DESIGN.md describes.
  - Row actions open inline forms:
    - Receive: quantity, optional unit cost in KES, optional note.
    - Adjust, with two modes:
      - "Count": counted quantity plus optional note.
      - "Change": signed quantity plus reason plus note, where the note is required for Other.
  - Item name links to the history page.
- [ ] **Step 2: History** (`/admin/stock/[itemId]?outlet=<id>`)
  - Movements newest first: when, kind, signed quantity, who, reason or note, and unit cost for receives.
- [ ] **Step 3: Import** (`/admin/items/import`)
  - Template download: a GET route returning `importTemplateCsv` for the business's active outlet codes, with `Content-Disposition: attachment; filename="items-template.csv"`. Owner only; others get 403.
  - File upload: max 2 MB, read as text in the server action.
  - Preview: counts, new categories, brands and groups, and an error table with line, column and message.
  - "Import" button: enabled only with zero errors. It re-posts the same file content (kept in a hidden field or re-uploaded; builder's choice) and calls `applyImport`, then shows the result with a link to Items.
- [ ] **Step 4: Overview**
  - The admin overview shows low-stock counts per outlet in scope, each linking to `/admin/stock?outlet=…&low=1`.
  - Remove `soon` from Stock in the nav.
- [ ] **Step 5: Verify**
  - `tsc`, lint and build are clean.
  - Render-check `/admin/stock`, a history page and `/admin/items/import` as the owner and as a manager. The manager sees only their outlets and has no Import link; the template route returns 403 for them.
- [ ] **Step 6: Commit** `feat(admin): stock screens, item history, CSV import and low-stock overview`.

---

### Task 9: End-to-end catalog and stock smoke test

**Files:**
- Create: `tests/e2e/catalog-smoke.spec.ts`, `tests/e2e/fixtures/catalog-import.csv`

**Interfaces:**
- Consumes: all pages above; `createBusinessWithOwner` and `createOutlet` (called directly from the spec's `beforeAll` against the test DB, the same way `tests/e2e/setup.ts` connects).

- [ ] **Step 1: Write the test.** It is independent of `admin-smoke.spec.ts`: seed its own business with owner `catalog@smoke.test` / `password123` and outlet `KTL` "Kitale".
  1. Log in and change the password to `newpass1234`.
  2. Create category "Roofing".
  3. Create item "Iron sheet 30G 3m": unit `sheet`, price `950`, lowest `900`, category Roofing, low-stock `10`.
  4. Add pack "Bundle", 20, at `18,000`.
  5. Add barcode `6001234567890` (base unit).
  6. Go to Stock for KTL and receive `25`.
  7. Count `8`. The row shows on-hand 8 and is marked low.
  8. The overview shows 1 low item for KTL.
  9. Import `catalog-import.csv`: 2 items, one with a Box pack and `stock_KTL` 12. The preview shows 0 errors; confirm.
  10. Items lists both new items, and Stock for KTL shows 12 for the stocked one.
- [ ] **Step 2: Run everything:** `npm test && npm run test:int && npm run test:e2e && npm run build` → all PASS. If a dev server already holds the project (Next allows one `next dev` per directory), stop only a server you started yourself. Otherwise report the e2e run as blocked.
- [ ] **Step 3: Commit** `test(e2e): catalog and stock smoke test`.
