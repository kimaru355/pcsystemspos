# Phases 3–5 — Till and Sync, Orders, Connection Modes: Design

Date: 2026-10-18
Status: Approved scope (phases 3, 4 and 5 of the roadmap), built together
Parent spec: `docs/superpowers/specs/2026-10-17-hardware-pos-mvp-design.md`
(§5 login and devices, §7 connection modes, §8 orders, §13 sync)
Earlier phase: `docs/superpowers/specs/2026-10-17-phase2-catalog-design.md`

**(my call)** marks a decision made by the builder. The rest comes from the
parent spec or from the product owner.

## 1. Intent

Give the outlet an offline-first till that sells from the catalog built in
Phase 2: cash and approved payments, part payments, part collections, the
paid-before-collect rule and approvals by PIN. Every till action is an
operation in an outbox, pushed to one sync endpoint that applies it exactly
once. The admin chooses how long a till may go without syncing.

The three phases are built together because each depends on the next to be
testable end to end: the sync engine needs real operations, and orders need
the sync engine.

## 2. Decisions taken before this phase

- **A worker moving between businesses (product owner):** phone and email stay
  unique per person, but a person may have one *active* membership at a time.
  A business adding someone whose only memberships are inactive gets that
  same person (new membership, new temporary password, sessions revoked).
  Reactivating an old membership is refused while the person is active in
  another business.
- **Catalog pull (Phase 2 follow-up) (my call):** a full pull per section with
  a content hash, instead of a change sequence and tombstones. The till sends
  the hash it holds for each section (catalog, stock, staff, orders); the
  server only sends sections whose hash differs. No `updated_at` or tombstone
  columns are needed, and a deleted barcode simply disappears from the next
  catalog. A hardware store's catalog (a few thousand items) makes this cheap.
  Revisit if a business passes ~20,000 items.
- **Service worker (my call, changes the roadmap's Serwist):** a small
  hand-written service worker served by a route handler (`/sw.js`). It
  precaches the till page and every file under `/_next/static` for the
  current build, and its bytes change with the build id, so a deploy installs
  a new worker. This avoids a build plugin on a Next.js version newer than the
  plugin's tested range. It is registered only in production builds.

## 3. Devices (Phase 3)

- `devices`: `id`, `business_id`, `outlet_id`, `code` (two digits, `01`–`99`,
  unique per outlet and never reused), `name`, `token_hash` (sha256 of a
  random device token), `registered_by`, `created_at`, `revoked_at`,
  `revoked_by`, `last_sync_at`, `last_order_seq`, `clock_jumps`,
  `last_clock_jump_at`.
- **Register** (online only): an owner, or a manager for an outlet in scope
  (`device.manage`), signed in on the web, opens `/till` on the new device,
  picks the outlet and a name. The server returns the token once; the till
  keeps it in IndexedDB. Audit `device.register`.
- **Device credentials are separate from user sessions.** The till calls the
  API with `Authorization: Bearer <device token>`. Changing a password or
  signing out of the web never logs a till out.
- **Revoke** (admin, `device.manage`): the device's calls are refused from then
  on. The till keeps its unsynced data and says the device was revoked; a
  manager can register the browser again and the outbox then flushes under
  the new device. Audit `device.revoke`.

## 4. Staff on the till (Phase 3)

- **First sign-in on a device is online:** phone/email, password and PIN.
  A person without a PIN chooses one here (this closes the Phase 1 follow-up
  "staff set their own PIN after re-entering their password"). The person must
  be active, belong to the device's business and be allowed at its outlet
  (owners: every outlet). A pending password change must be done on the web
  first. Lockout uses the existing login limiter.
- **PIN verifier (my call):** argon2 is not available in the browser, so a
  second verifier is kept next to `pin_hash`: PBKDF2-SHA256, 100,000
  iterations, a random 16-byte salt per membership. It is (re)computed whenever
  the server sees the plain PIN (set by an owner/manager, set by the person,
  or verified at till sign-in). Existing PINs gain it at their next till
  sign-in.
- **Offline unlock:** the till lists the people who signed in on it; one taps
  their name and enters the PIN, checked against the verifier with WebCrypto.
  Five wrong PINs lock that person on that device for 1 minute, doubling each
  time. **Known limit:** any offline-checkable 4–6 digit PIN can be brute
  forced by someone who copies the device's storage. The device token and
  the device itself are the real protection; revoke a lost device.
- **Staff section of the pull:** every active member allowed at the outlet,
  with role and verifier. People removed or deactivated disappear from the
  device at the next sync, and changed PINs update there.
- **Approvals** (credit, mark-paid, price below the floor): an owner or a
  manager allowed at the outlet enters their PIN on the till. The operation
  carries the approver's membership id; the server checks the approver is an
  owner or manager of the business and records them.

## 5. Sync (Phase 3)

`POST /api/sync` (device token):

```
request  { ops: Op[] (≤ 100, in creation order), hashes: { catalog?, stock?, staff?, orders? },
           clock: { jumps, lastJumpAt } }
response { results: [{ id, status: 'applied' | 'rejected', code?, message? }],
           serverTime, settings: {...}, sections: { catalog?, stock?, staff?, orders? } }
```

- **Operation:** `{ id (client uuid), type, actorMembershipId, occurredAt, payload }`.
- **Exactly once:** each op is applied in its own transaction that first
  inserts its row into `sync_ops` (primary key = op id). A repeated id finds
  the row and returns the stored result without applying anything. A
  `DomainError` rolls back to a savepoint and stores the op as `rejected`
  with its code and message, so a retry gets the same answer and the payload
  is kept for the admin. Any other error fails the request and the till
  retries later.
- **The server is the source of truth for money and stock.** It accepts ops
  that are valid in themselves even if stock would go negative (the item is
  flagged, as in Phase 2).
- **Order of work on the till:** after a successful push the till drops the
  acknowledged ops and replaces the changed sections in one IndexedDB
  transaction. The local view is the server sections plus the pending ops
  replayed through the same domain functions the server uses.
- **Retry/backoff (my call):** sync every 30 s while online, immediately
  after a new op and when the browser comes online; failures back off 5 s,
  10 s, 20 s … up to 5 minutes.
- **`occurredAt`** comes from the till's trusted clock (§7). The server keeps
  it on movements, payments, collections and audit rows (`audit_log` gains
  `device_id`, `occurred_at` and `op_id`), clamped to the server time when it
  is in the future.
- **First op type:** `stock.adjust` (owner or manager unlocked on the till),
  with a client movement id. The ledger is now append-only in the database
  (a trigger refuses UPDATE and DELETE on `stock_movements`).

## 6. Orders, payments, collections (Phase 4)

### 6.1 Data

- `customers`: `id`, `business_id`, `name`, `phone` (E.164), unique
  (`business_id`, `phone`). Orders keep a snapshot of name and phone; the
  server links the customer by phone.
- `orders`: `id` (client uuid), `business_id`, `outlet_id`, `device_id`,
  `number` (unique per business), `seq`, `customer_id`, `customer_name`,
  `customer_phone`, `status` (`open` | `closed`), `credit_cents` (approved
  credit), `flagged_at` (collected beyond paid + credit, see 6.4),
  `created_by`, `occurred_at`, `created_at`, `closed_at`,
  `cancelled_at`, `cancel_reason`.
- `order_lines`: `id` (client uuid), `order_id`, `business_id`, `item_id`,
  `pack_id`, snapshots of `name`, `unit_label`, `base_qty_per_unit_milli`,
  `unit_price_cents`, `list_price_cents`, `floor_cents`, `tax_category`,
  `vat_rate_bp`; `qty_milli` and `collected_milli` and `cancelled_milli` in the
  **sold unit**; `price_approved_by`; `position`.
- `payments`: `id` (client uuid), `order_id`, `kind` (`payment` | `refund`),
  `method` (`cash` | `mark_paid`; refunds: `cash` | `mpesa` | `other`),
  `amount_cents` > 0, `reason` (mark-paid and refunds), `approved_by`,
  `actor_user_id`, `device_id`, `occurred_at`.
- `collections` and `collection_lines`: `id` (client uuid), `order_id`,
  `value_cents`, `credit_granted_cents`, `approved_by`, `actor_user_id`,
  `device_id`, `occurred_at`; lines hold `order_line_id`, `qty_milli` (sold
  unit), `base_qty_milli` and the `collect` movement id.
- `stock_movements.order_line_id` gets its foreign key and is indexed.

### 6.2 Rules (shared domain module, used by the till and the server)

- **Sold units:** a line sells the base unit or a pack. Packs are sold in
  whole numbers; the base unit in whole numbers unless the item is
  fractional. So the base quantity, `qty × base_qty_per_unit / 1000`, is
  always exact: there is no rounding rule to choose (Phase 2 follow-up).
- **Totals:** line value = `lineGross(qty − cancelled, unit price)`; VAT per
  line by `vatPortion`. Paid = payments − refunds.
- **Price floor:** a unit price below the line's floor needs an approver.
  Prices come from the catalog the till holds (snapshot on the line).
- **Paid-before-collect:** unchanged from Phase 1 (`checkCollection`), now in
  base units for stock, with these follow-ups: an empty request is
  `invalid_request`; the stock check can be skipped (the server always skips
  it); on-hand is a `Map`.
- **Credit:** collecting beyond paid + credit needs an approver; the order's
  credit grows by the shortfall. A customer's owed amount is
  `max(0, collected value − paid)` summed over their orders.
- **Named customer:** required whenever, after the operation, money or goods
  are outstanding or credit was used. Phone numbers are normalised to E.164.
- **State:** an order closes when nothing is left to collect and paid ≥ total.
  Overpayment stays on the order as the customer's balance.
- **Cancel the remainder (admin, online):** owner, or manager for the outlet
  (`order.cancel`), with a reason. Every line's uncollected quantity becomes
  cancelled. A refund (≤ paid − new total) can be recorded with it or later;
  the money itself moves outside the system. Audit `order.cancel_remainder`,
  `order.refund`.

### 6.3 Till operations

| Op | Payload | Who |
|---|---|---|
| `sale.checkout` | new order (id, number, seq, customer?, lines), payments[], collection? | anyone allowed at the outlet; approvals inside |
| `payment.add` | order id, payment (cash, or mark-paid with approver and reason), customer? | same |
| `collection.record` | order id, collection (lines, credit approver?), customer? | same |
| `stock.adjust` | movement id, item, change, reason, note | owner/manager |

A checkout is one operation so the named-customer rule is checked on the
final state of the sale.

### 6.4 Two devices offline

Both devices see the same order. If both take a collection and the server
finds the value collected now exceeds paid + credit, the collection is still
recorded (the goods have left), the order is flagged and an
`order.over_collected` audit row is written for the admin. Stock may go
negative and is flagged as in Phase 2. Order numbers never collide:
`OUTLET-DEVICE-SEQ`, with the sequence kept on the device and the last one
the server saw returned in every sync.

### 6.5 Owed stock

`owedMilliFor` now sums `(qty − cancelled − collected) × base_qty_per_unit`
over open orders' lines at the outlet. Available = on-hand − owed, as before.
Low-stock counts are computed in one query.

## 7. Connection modes (Phase 5)

| Mode | Reminders start | New sales blocked |
|---|---|---|
| Full offline | never | never |
| Default | 1 day after the last successful sync | 7 days |
| Always online | 1 hour | 1 day |

- The mode is the outlet's (or the business default) and reaches the device
  in every sync.
- **Escalation (my call):** from the reminder point a quiet line in the status
  strip ("Connect to sync"); from halfway to the block a banner; from 85% a
  banner that stays on top of the sale screen. Wording never mentions limits.
- **Blocked:** starting a new sale is refused; open orders, payments,
  collections on existing orders, stock lookup and sync still work. Nothing
  unsynced is discarded.
- **Trusted clock (my call):** at each sync the till stores the server time
  and its own clock. While running, time advances by `performance.now()`;
  the persisted high-water mark never goes backwards across reloads. When
  the wall clock and the monotonic clock disagree by more than 2 minutes, or
  the wall clock is earlier than the last persisted tick, a clock jump is
  counted and sent with the next sync. The admin's device list flags devices
  with clock jumps and devices past their reminder point.

## 8. Permissions

| Action | Owner | Manager | Cashier |
|---|---|---|---|
| `device.manage` (register, revoke; outlets in scope) | ✓ | ✓ | |
| `order.sell` (till sales, payments, collections) | ✓ | ✓ | ✓ |
| `order.approve` (credit, mark-paid, price below floor) | ✓ | ✓ | |
| `order.view` (admin order screens; outlets in scope) | ✓ | ✓ | |
| `order.cancel` (cancel remainder, refunds; outlets in scope) | ✓ | ✓ | |

## 9. Screens

- **Till** (`/till`, client-rendered, works offline): register device →
  unlock (people on this device, or sign in) → Sale (scan or tap; pick the
  base unit or a pack; edit price with floor approval; Checkout dialog with
  cash, mark-paid, collect now, customer) → Orders (open orders by number or
  phone; pay, collect) → Stock (on-hand, owed, available; adjust for
  managers). The status strip shows the outlet, the person, the outbox count
  and the connection state.
- **Admin:** Devices (`/admin/devices`: list, last sync, flags, revoke);
  Orders (`/admin/orders`: list with filters; `/admin/orders/[id]`: lines,
  payments, collections, cancel remainder, refund).

## 10. Not in these phases

M-Pesa (Phase 6), receipts and printing (Phase 7), customers screen and
reports (Phase 8), editing the lines of an existing order, returns.
