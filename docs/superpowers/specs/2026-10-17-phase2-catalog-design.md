# Phase 2 — Catalog and Inventory: Design

Date: 2026-10-17
Status: Draft, awaiting approval
Parent spec: `docs/superpowers/specs/2026-10-17-hardware-pos-mvp-design.md` (§6 Catalog and inventory, §12 tax readiness)
Input: `catalogSuggestion.md` (research on two Kenyan hardware web stores and a mabati seller)

**(my call)** marks a decision made by the designer. Everything else was
agreed with the client: the catalog suggestion with five changes, plus CSV
import.

## 1. Intent

The hardware store's items, prices and stock have to exist before anyone can
sell. This phase gives owners and managers the admin screens to set up the
catalog, load it from a spreadsheet, receive and adjust stock per outlet, and
see what is running low. It also leaves the data shaped the way the offline
till (Phase 3) and orders (Phase 4) will need it.

Real stores showed that hardware is sold **per piece and per pack** (an iron
sheet or a bundle of 20, a tile or a box). They also showed that size, colour
and gauge are what tell items apart. Stock must stay right when the same goods
are sold both ways.

## 2. Changes to the parent spec

- **Packs are in the MVP.** Spec §3 deferred "multiple units of measure per
  item". That is reversed: each item has one base unit that stock is counted
  in, plus optional packs that are sold at their own price.
- **Item groups, categories (2 levels) and brands** are added.
- **Adjustment reasons** are a fixed list (§6.6).
- **CSV import** of the catalog and opening stock is added.

Unchanged: one price list per business, VAT-inclusive prices, price floor per
item, no suppliers or purchase orders, no images.

## 3. Goals

1. An owner can create and edit categories, brands, item groups, items, packs
   and barcodes.
2. An owner can import items, packs and opening stock per outlet from a CSV
   file. The import shows a preview with every error before anything is saved,
   and then saves all rows or none.
3. Owners and managers can receive and adjust stock for outlets in their
   scope. Every change is a stock movement that stays in history.
4. Stock lists per outlet show on-hand, available and low-stock items.
5. The data model is ready for the till's barcode scan, item picker and offline
   pull (Phase 3), and for order lines sold in packs (Phase 4).

## 4. Non-goals

Per-outlet prices; sale/regular prices and promotions; suppliers, purchase
orders and cost averaging; stock transfers between outlets (the ledger's
`kind` leaves room); images; per-outlet low-stock thresholds; updating
existing items from CSV; KRA eTIMS submission.

## 5. Anti-goals

- On-hand stock that doesn't equal the sum of the outlet's movements.
- A stock change with no named person, outlet, time and (for adjustments) reason.
- An import that half-applies.
- One business seeing or changing another's catalog or stock.
- A barcode that points to two different things in the same business.

## 6. Data model

Integer cents, integer thousandths (`Milli`), `uuid` ids and `business_id` on
every table all follow the existing conventions.

### 6.1 categories
`id`, `business_id`, `parent_id` (null = top level; the UI allows 2 levels),
`name`, `sort_order` (default 0), `active` (default true), timestamps.
Names are unique per business **and parent, including at the top level**
(`NULLS NOT DISTINCT`). A category's parent must be a top-level category in
the same business.

### 6.2 brands
`id`, `business_id`, `name` (unique per business), `active`.

### 6.3 item_groups
`id`, `business_id`, `name` (unique per business), `category_id` null,
`brand_id` null, `attribute_keys text[]` (the picker order, e.g.
`{size,colour}`), `active`. A group gathers the size/colour versions of one
product. The till shows one tile and then a picker.

### 6.4 items (the stocked, priced row)
`id`, `business_id`, `group_id` null, `category_id` null, `brand_id` null,
`name` (the full receipt name, e.g. "Crown Silk Vinyl 4L Cream"),
`attributes jsonb` default `{}` (keys come from the group's
`attribute_keys`; free-form when there is no group), `sku` null (unique per
business when set), `base_unit` (text: piece, bag, sheet, metre, kg, litre…),
`fractional` (default false), `price_cents`, `floor_cents` (check
`0 ≤ floor ≤ price`), `tax_category`, `low_stock_milli` null, `active`,
timestamps.

**Change 2: there is no `vat_rate_bp` column.** The VAT rate is derived from
`tax_category` by one pure domain function, so the two can never disagree:

| code | meaning | rate (bp) |
|---|---|---|
| A | Exempt | 0 |
| B | Standard 16% | 1600 |
| C | Zero-rated | 0 |
| D | Non-VAT | 0 |
| E | Reduced 8% | 800 |

The default is B. The A–E codes follow the suggestion. They could not be
confirmed against a KRA primary source, so they must be verified before the
eTIMS phase. They live in one enum and one function so they're cheap to
change. **(my call)**

### 6.5 item_packs
`id`, `business_id`, `item_id`, `name` ("Bundle", "Box", "Roll"),
`base_qty_milli` (base units per pack, check > 0; a bundle of 20 sheets =
20000), `price_cents`, `floor_cents` (check `0 ≤ floor ≤ price`), `active`.
Pack names are unique per item. Stock is never kept per pack.

### 6.6 item_barcodes (change 1)
`id`, `business_id`, `barcode` (text), `item_id`, `pack_id` null (null = base
unit). `(business_id, barcode)` is unique. `pack_id`, when set, must belong
to `item_id`. A scan does one lookup and gets both the item and the selling
unit. An item or pack may have several barcodes (e.g. two suppliers' labels).

### 6.7 stock_movements (the ledger)
Append-only. Quantities are in the item's **base unit**.
`id` (uuid; server-generated in this phase, client-generated by the till in
Phase 3), `business_id`, `outlet_id`, `item_id`, `kind`
(`receive` | `adjust` | `collect`; later `transfer_in`, `transfer_out`,
`return`), `qty_milli` (signed and non-zero: receive > 0, collect < 0,
adjust ±), `unit_cost_cents` null (receive only), `reason` null (adjust only:
`damaged` | `count_correction` | `lost_stolen` | `other`), `note` null
(required when the reason is `other`; optional otherwise), `order_line_id`
null (collect only, Phase 4), `actor_user_id`, `device_id` null (no foreign
key until the devices table exists in Phase 3), `occurred_at`, `created_at`.
Indexed on `(business_id, outlet_id, item_id, occurred_at)`.

### 6.8 outlet_stock (cached on-hand)
`outlet_id` + `item_id` (primary key), `business_id`, `on_hand_milli`,
`flagged_negative_at` null. It is updated **in the same transaction** as
every movement insert, by adding the movement's quantity. It is set when
on-hand drops below 0 and cleared when on-hand returns to 0 or more. A row
that doesn't exist means on-hand 0.

### 6.9 Owed and available
Owed = quantity on open order lines not yet collected, in base units. Orders
arrive in Phase 4, so in this phase owed is always 0 behind a single function
that Phase 4 will fill in. Available = on-hand − owed. Low stock means
`low_stock_milli` is set and available ≤ `low_stock_milli`.

## 7. Rules

- **Quantities:** for an item with `fractional = false`, receive and adjust
  quantities must be whole base units (multiples of 1000 milli).
- **Receive:** quantity > 0. Optional unit cost ≥ 0. Writes one `receive`
  movement.
- **Adjust:** two ways to enter it. Either a signed change ("−3, damaged"),
  or a stock count ("we counted 47") that the system turns into a
  `count_correction` movement for the difference. A count equal to on-hand
  writes nothing. An adjustment may not take on-hand below 0. Only Phase 4's
  sync-applied collections may do that.
- **Deactivating** an item, pack, group, category or brand hides it from
  pickers and the till. It never deletes it, and history stays intact.
  Nothing in the catalog is hard-deleted.
- **Changing a price** only affects future sales (Phase 4 order lines take a
  snapshot of the price).
- **Changing `base_unit` or `fractional`** is refused once an item has any
  stock movement. Otherwise existing quantities would change meaning.
  **(my call)**
- **Audit:** catalog creates and edits (with before/after values, including
  price changes) and every stock adjustment write an audit row. Receives are
  recorded by their movement row, which already names the actor.

## 8. Permissions

| Action | Owner | Manager | Cashier |
|---|---|---|---|
| `catalog.manage` (categories, brands, groups, items, packs, barcodes, import) | ✓ | | |
| `stock.receive` (outlets in scope) | ✓ | ✓ | |
| `stock.adjust` (outlets in scope) | ✓ | ✓ | |
| `stock.view` (outlets in scope) | ✓ | ✓ | ✓ |

Managers can view the catalog read-only. Cashiers see stock on the till
(Phase 3). In this phase they have no admin screens. **(my call)**

## 9. CSV import

- **Format:** UTF-8 CSV with a header row and one row per item. A downloadable
  template lists the columns:
  `name, group, category, subcategory, brand, sku, barcode, base_unit,
  fractional, price, floor, tax_category, low_stock`
  plus up to two packs per row:
  `pack1_name, pack1_qty, pack1_price, pack1_floor, pack1_barcode,
  pack2_name, …`
  plus one opening-stock column per outlet: `stock_<OUTLET CODE>`
  (e.g. `stock_KTL`).
- **Values:**
  - Money is entered as `1,250.50` (the existing `parseMoney`). Quantities
    are entered as `2.5` (`parseQty`).
  - `fractional` accepts yes/no/true/false/1/0. `tax_category` defaults to B
    and `floor` defaults to `price`.
  - Categories, subcategories, brands and groups are matched by name (case-
    insensitive) and created when missing.
  - When `group` is set, the item's attributes are left empty (they can be
    filled in on screen).
- **Create-only:** a row whose SKU or any of its barcodes already exists in the
  business, or appears twice in the file, is an error. Updating existing items
  from CSV is a non-goal. **(my call)**
- **Two steps:**
  1. Upload. The file is parsed and validated, and a preview shows the
     counts (items, packs, new categories, stock rows) and every error with
     its row number and column.
  2. Confirm. Allowed only when there are zero errors. It applies everything
     in one transaction: creates the catalog and writes a `receive`
     movement with note "Opening stock" for each non-zero `stock_` cell.
     The file is re-validated at this point.
- **Limits:** 5,000 rows and 2 MB per file. Unknown outlet codes in `stock_`
  columns are an error. Only active outlets can receive opening stock.
- **Audit:** one `catalog.import` row with the counts.

## 10. Admin screens

Following `DESIGN.md` and the existing admin shell (`src/components/shell/`):

- **Items** (`/admin/items`):
  - The item list has search (name, SKU, barcode), a category filter and an
    active/inactive filter.
  - There's a create button and a link to Import.
  - Owners edit; managers see it read-only.
- **Item page** (`/admin/items/new` and `/admin/items/[id]`):
  - Fields: name, group (with attribute fields from the group's keys),
    category, brand, SKU, base unit, fractional, price, floor, tax category
    (labels like "B — 16% VAT"), low-stock level, active.
  - Below them: a packs section (add, edit, deactivate) and a barcodes
    section (add or remove, each tied to the base unit or a pack).
  - Stock per outlet in scope, read-only, with links to receive or adjust.
- **Categories, brands, groups** (`/admin/items/categories`, `/brands`,
  `/groups`): simple lists with inline create, rename, activate and
  deactivate. Categories show as a tree with 2 levels at most.
- **Import** (`/admin/items/import`): template download, upload, preview,
  confirm.
- **Stock** (`/admin/stock`):
  - Pick an outlet (from your scope). The list shows item, on-hand,
    available and the low-stock level.
  - Filters: low only, negative only, category, search.
  - Row actions: Receive and Adjust (stock count or change).
  - **Item history** shows the movements for that outlet: when, kind,
    quantity, who, reason or note.
- **Overview:** the existing admin overview gains a low-stock count per
  outlet, linking to the filtered stock list. **(my call)**
- **Navigation:** turn on the existing Items and Stock nav entries (already in `nav-config.ts`, marked "soon").

## 11. Left to the builder

- Whether outlet_stock is updated with an upsert or a select-for-update.
- The CSV parsing library, or a small parser (it must handle quoted fields,
  commas inside quotes and CRLF line endings).
- Pagination and search implementation, and indexes beyond those named.
- Exact page composition within DESIGN.md.

## 12. Notes carried forward

- **Phase 3:** the till pull sends active items, packs, barcodes, groups and
  categories, plus `outlet_stock` for the device's outlet. Movements get
  client-generated ids and a `device_id`.
- **Phase 4:** order lines store `item_id` and `pack_id`, snapshots of the
  name, unit label, price, tax category and `base_qty_per_unit_milli`, and
  `qty_milli` and `collected_milli` in the **sold unit**. Collecting n sold
  units writes a `collect` movement of −n × base_qty_per_unit / 1000 base
  units. `checkCollection`'s stock check must convert to base units before
  comparing against on-hand. Owed (§6.9) gets filled in.
