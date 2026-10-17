# Catalog and inventory: suggested DB models

Status: suggestion for Phase 2, not yet agreed. Changes spec §6 where noted.

Follows the existing conventions in `src/domain/money.ts` and `src/db/schema/`:
money is integer cents (KES), quantities are integer thousandths (`Milli`),
VAT rates are basis points, ids are `uuid`, and every tenant table carries
`business_id`.

## 1. What real stores showed (2026-10-17)

Raw JSON from the public WooCommerce Store API (`/wp-json/wc/store/v1/products`)
of two Kenyan hardware shops, plus product pages from a mabati seller.

| Finding | Evidence | Consequence |
|---|---|---|
| The same item is sold per piece **and** per pack | Randtech: "32gauge 2.5M iron sheet" KSh 950 and "32 Gauge 3 Meter … 20 Pcs Per Bundle" KSh 23,500; PVC ceiling "1 Bundle (10 Pieces)"; Ebuild tiles "4 Pack"; nails per kg | Pack units are needed (spec §3 deferred them). Stock in one base unit, sell in packs. |
| Size, colour and gauge are what tell items apart | Randtech puts them only in names ("Solai Super Gloss … 1 / 4 / 10 / 20 Ltrs" = 4 products). Ebuild uses parent + variations (Crown Silk Vinyl: size 1L/4L/20L × colour), each with its own SKU and price | Each sellable size/colour is its own stocked item; an optional group ties them together for the till picker. |
| Per-metre and cut-length selling | Empress Mabati: KSh 500/m, custom lengths; Ebuild geogrid "per square metre" | Already covered by decimal quantities. |
| Categories are a shallow tree | Randtech: 76 categories, 2 levels (Iron Sheet → Corrugated, Plumbing → PVC pressure pipes) | `categories.parent_id`. |
| Brand is common but optional | Ebuild stores it as an attribute (Crown Paints, Knauf); Randtech has none | Optional `brands` table. |
| SKUs are optional in practice; names repeat | Randtech: no SKUs, duplicate names. Ebuild: SKU on every product | SKU and barcode optional but unique per business when set. |
| Prices in minor units | Woo returns `"price": "930000"`, `currency_minor_unit: 2` | Matches integer cents. |
| Sale price / regular price | Both stores | Not needed: price + price floor covers counter discounts. |

## 2. Entities

```
businesses ─┬─ categories (tree)
            ├─ brands
            ├─ item_groups ──┐ (optional parent, e.g. "Crown Silk Vinyl")
            └─ items ────────┴─ item_packs (bundle = 20 pieces …)
                 │
outlets ─────────┴─ stock_movements (ledger, base units) ─→ outlet_stock (cached on-hand)
```

### categories

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| business_id | uuid fk | |
| parent_id | uuid fk → categories, null | null = top level. Keep to 2 levels in the UI. |
| name | text | |
| sort_order | integer default 0 | till tab order |
| active | boolean default true | |

Unique `(business_id, parent_id, name)`.

### brands

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| business_id | uuid fk | |
| name | text | unique per business |

### item_groups (optional)

Groups the size/colour versions of one product so the till shows one tile,
then a picker. An item without a group is shown on its own.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| business_id | uuid fk | |
| name | text | "Crown Silk Vinyl Emulsion" |
| category_id | uuid fk, null | default for its items |
| brand_id | uuid fk, null | |
| attribute_keys | text[] | picker order, e.g. `{size,colour}` |
| active | boolean | |

### items — the stocked, priced row

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| business_id | uuid fk | |
| group_id | uuid fk → item_groups, null | |
| category_id | uuid fk, null | |
| brand_id | uuid fk, null | |
| name | text | full name shown on receipts: "Crown Silk Vinyl 4L Cream" |
| attributes | jsonb default `{}` | `{"size":"4 L","colour":"Cream"}`, `{"gauge":"30","length_m":"3"}`; keys match the group's `attribute_keys` |
| sku | text, null | unique per business when set |
| barcode | text, null | unique per business when set (barcode of the base unit) |
| base_unit | text | "piece", "bag", "metre", "kg", "litre", "sheet" — the unit stock is counted in |
| fractional | boolean default false | allow 2.5 (metre, kg); false = whole units only |
| price_cents | integer | VAT-inclusive price per base unit |
| floor_cents | integer | lowest price without approver PIN; check `floor_cents <= price_cents` |
| vat_rate_bp | integer | 1600 = 16% |
| tax_category | enum | eTIMS tax type for later: `A` exempt, `B` 16%, `C` zero-rated, `D` non-VAT, `E` 8% |
| low_stock_milli | integer, null | alert when available ≤ this; null = no alert |
| active | boolean default true | |
| created_at / updated_at | timestamptz | |

Partial unique indexes: `(business_id, sku) where sku is not null`,
`(business_id, barcode) where barcode is not null`.

### item_packs — **new vs spec**

Other ways to sell the same item. Stock is never kept per pack.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| business_id | uuid fk | |
| item_id | uuid fk → items | |
| name | text | "Bundle", "Box", "Roll" |
| base_qty_milli | integer | base units per pack: 20 sheets = 20000; check > 0 |
| price_cents | integer | price of one pack (often below base price × count) |
| floor_cents | integer | |
| barcode | text, null | unique per business when set (shared with `items.barcode` namespace) |
| active | boolean | |

Unique `(item_id, name)`.

A barcode scan looks up `items.barcode`, then `item_packs.barcode`, so one
lookup tells the till both the item and the unit.

### stock_movements — the ledger (spec §6)

Append-only. All quantities in the item's **base unit**.

| column | type | notes |
|---|---|---|
| id | uuid pk | client-generated, so the till's sync push is idempotent |
| business_id | uuid fk | |
| outlet_id | uuid fk | |
| item_id | uuid fk | |
| kind | enum | `receive`, `adjust`, `collect`; later `transfer_in`, `transfer_out`, `return` |
| qty_milli | integer | signed: receive +, collect −, adjust ± |
| unit_cost_cents | integer, null | optional on receive (spec: "optional cost") |
| reason | text, null | required for `adjust` |
| order_line_id | uuid, null | set for `collect` |
| actor_user_id | uuid fk | |
| device_id | uuid, null | |
| occurred_at | timestamptz | device time (clock rules from §7 apply) |
| created_at | timestamptz | server time |

Index `(business_id, outlet_id, item_id)`.

### outlet_stock — cached on-hand

On-hand is still defined as the sum of movements; this row is just kept in
step with it so stock lists and the till pull don't have to add up the whole
ledger every time.

| column | type | notes |
|---|---|---|
| outlet_id, item_id | pk | |
| business_id | uuid fk | |
| on_hand_milli | integer | updated in the **same transaction** as each movement insert |
| flagged_negative_at | timestamptz, null | set when on-hand goes below 0 (spec §8) |

Owed and available stay computed (owed = open order lines not yet collected,
available = on-hand − owed), or are added here later if they get slow.

## 3. Effect on order lines (Phase 4)

A line keeps both what was sold and what it means for stock, plus snapshots
so later catalog edits don't change history:

| column | notes |
|---|---|
| item_id, pack_id (null = base unit) | |
| item_name, unit_label | snapshot: "Iron sheet 30G 3m", "Bundle" |
| qty_milli | in the **sold unit** (2 bundles = 2000) |
| base_qty_per_unit_milli | snapshot of `base_qty_milli` (20000), or 1000 for base unit |
| unit_price_cents, vat_rate_bp, tax_category | snapshot |
| collected_milli | in the sold unit (2/5 bundles) |

Collecting `n` sold units writes a `collect` movement of
`−n × base_qty_per_unit_milli / 1000` base units. `lineGross(qtyMilli,
unitPriceCents)` in `src/domain/money.ts` works unchanged.

## 4. Deliberately left out

- Per-outlet prices (spec: one price list per business).
- Sale/regular price and promotions.
- Many categories per item (stores do it for SEO; a POS doesn't need it).
- Suppliers, purchase orders, cost averaging (only an optional cost on receive).
- Weight/dimensions (only useful once delivery exists).
- Images (can be added as a nullable `image_url` later; cheap phones on slow data shouldn't need them).

## 5. Decisions needed

1. **Pack units in the MVP?** Recommended: yes. Iron sheets, PVC ceiling and
   tiles are routinely sold both ways. Without packs a shop must create two
   items with separate stock, and the stock is then wrong. This reverses one
   line of spec §3.
2. **Item groups in the MVP?** Recommended: yes, small cost. Without them a
   paint range is 12+ near-identical rows on a phone screen.
3. **eTIMS tax types:** confirm the A–E mapping against KRA's current list
   before seeding.
