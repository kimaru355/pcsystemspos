# Phase 1 — Follow-ups carried into later phases

Collected from the per-task reviews and the final whole-branch review of
Phase 1 (`feat/phase1-foundation`). Each item lands with the phase that first
depends on it. Read this when writing the next phase's plan.

## Open decision (needs the product owner)

- **A worker moving between businesses.** Phone and email are unique across
  the whole platform and a user belongs to one business. A cashier deactivated
  at Store A can't be added by Store B with the same phone/email. Options: a
  unique index on active memberships only, or a platform-admin "release"
  action. Decide before Phase 3.

## Before Phase 2 (catalog and inventory)

- Safe-integer guards in `parseQty`, `parseMoney`, `lineGross` (huge inputs
  silently lose precision).
- Next migration: indexes on `sessions(user_id)`, `memberships(business_id)`,
  `membership_outlets(outlet_id)`, unique `lower(users.email)`.

## Before Phase 3 (till shell and sync)

- DB `CHECK (code ~ '^[A-Z0-9]{2,5}$')` on `outlets.code` (order numbers use it).
- Composite `(business_id, outlet_id)` constraint on `membership_outlets`.
- Device credentials separate from user sessions — `changePassword` revokes
  every session, which would log out a registered till.
- `audit_log` additions for offline actions: `device_id`, `occurred_at`
  (time of the action, not of the sync), operation UUID.
- Cookie expiry is fixed at login while the DB session slides; revisit with
  device sessions.
- Validate UUIDs on all sync input (as Phase 1 services now do).

## Before Phase 4 (orders, payments, collections)

- `checkCollection`: empty request should be `invalid_request`; add an option
  to skip the stock check (server accepts negative stock on sync and flags it);
  use `Object.hasOwn`/`Map` for `onHandMilli`; add tests pinning the order of
  checks.
- Staff set their own PIN after re-entering their password (today owners set
  managers' PINs and managers set cashiers'), so approvals are truly personal.
- Decide whether approver PINs must be unique per business.

## Before Phase 8 (go-live)

- Lazy DB client so `next build` in Docker doesn't need `DATABASE_URL`.
- Platform CLI: read passwords from stdin, `--actor` for audit rows, force
  platform admins to change their initial password.
- Purge job for `login_attempts` and expired `sessions`; `audit_log` index on
  `(business_id, created_at)`.
- Tests for `requireTenant` redirects, `/logout/no-access`, admin cashier
  redirect; a concurrency test for the last-owner rule.

## Polish (any time)

- No-op patches still write audit rows (outlets and staff).
- Staff edit form drops links to inactive outlets; editing an inactive member
  is allowed at service level.
- `CreateStaffForm` clears its fields after a validation error.
- Failed logins aren't reset by a successful login.
- Shared password/email validation constants (duplicated in three services).
- Outlet name max length; phone normaliser accepts `+07…`; `parseMoney("0,500")`.
- E2E: locate rows by role/test id rather than Tailwind classes.

---

# Phase 2 — Follow-ups (from the catalog and inventory reviews)

## Before Phase 3 (till pull and sync)

- **Catalog pull cursor:** `brands` and `item_packs` have no `updated_at`,
  `item_barcodes` rows are hard-deleted with no tombstone, and `outlet_stock`
  has no version column. Decide between a change sequence/tombstones and a full
  catalog pull, then add it in a new migration (additive).
- `NewMovement` needs `deviceId`. Movement ids are already client-suppliable.
- Enforce the ledger as append-only in the DB (REVOKE UPDATE/DELETE or a
  trigger) before sync writes start.
- Composite `(id, business_id)` FKs for `outlet_stock`, `stock_movements`,
  `item_packs`, `item_barcodes` (today cross-business integrity is
  service-only).
- Indexes on `items(category_id|brand_id|group_id)`, `item_barcodes(item_id)`,
  `outlet_stock(item_id)`.
- Activity feed index is `NULLS LAST` while the query sorts `NULLS FIRST`, so
  align them. Add a partial index for the import file-hash lookup.
- **Framework:** a server-action form posted before hydration (no JS) returns a
  blank page under `cacheComponents` (affects all admin forms). Check Next
  patch releases or add a no-JS fallback.
- `serverActions.bodySizeLimit` is 3 MB app-wide, which affects pre-auth
  actions like login. Move the import upload to an authenticated route handler.

## Before Phase 4 (orders)

- Callers touching several items in one transaction must lock items in a stable
  order (sorted by id) to avoid deadlocks. Callers must validate the outlet
  before `applyMovement`.
- Pack → base-unit conversion needs a rounding rule.
- FK and partial unique index on `stock_movements.order_line_id` for collects.
- `lowStockCounts` is N+1. Push it into SQL once owed is a real query.
- `vatRateBp` has no runtime guard. Validate tax categories at every boundary.

## Polish

- Managers see no catalog or stock lines in the activity feed.
- The import silently reuses deactivated categories, brands and groups.
- An inactive top-level category with active children is still selectable.
- Some tests read `audit_log` with an unordered `limit(1)`. Order them by `seq`.
- The overview "Add items and prices" step is never marked done.
- Small accessibility items: no `aria-live` announcement after a form remounts,
  `aria-controls` pointing at closed panels, no live region while importing.

---

# Phases 3–5 — Follow-ups (till, sync, orders, connection modes)

## Resolved in Phases 3–5

- A worker moving between businesses: one active membership per person; a person with only
  inactive memberships can be added by another business (same person, new temporary password).
- Composite `(business_id, …)` foreign keys on membership_outlets, outlet_stock, stock_movements,
  item_packs, item_barcodes; the ledger is append-only in the database; the Phase 2 indexes.
- Device credentials separate from user sessions; `audit_log` has `device_id`, `occurred_at`,
  `op_id`; every sync input is parsed with zod (uuids included).
- Catalog pull: full sections with content hashes (no cursor or tombstones needed).
- `checkCollection`: empty request, optional stock check, `Map` on-hand, pinned check order.
- Staff choose their own PIN at their first till sign-in (after their password).
- Pack → base conversion is exact (packs sell in whole numbers); `owedMilliFor` is a real query.
- The overview's "Add items and prices" step is marked done.

## Before Phase 6 (M-Pesa)

- Payments table already has `method = 'mpesa'`; STK and C2B add a `mpesa_requests` table and a
  `payment.add` path the server creates itself (not a till op).
- An unmatched-payment attach is an online admin/till action, not an outbox op.

## Before Phase 8 (go-live)

- **PIN verifiers on devices.** Every till holds the PBKDF2 verifiers of the people allowed at its
  outlet (owners and managers included, for approvals). A copied device storage allows an offline
  brute force of 4–6 digit PINs. Revoke lost devices; consider per-device verifiers, or limiting
  approver verifiers to people who signed in on that till.
- `lowStockCounts` still runs one stock query per outlet.
- `salesSince` loads every order of the day into memory; push the sums into SQL with the reports.
- Rejected sync ops are stored with their payload but have no admin screen yet (only the till
  shows them). Add them to the audit log viewer.
- The till keeps the last 2 days of closed orders; receipts (Phase 7) need reprint of older ones.
- Approval PIN attempts on the till are limited in memory only (per approval dialog).

## Polish

- A till re-registered to a different outlet sends its old outlet's unsynced sales, which the
  server rejects (kept in `sync_ops`). Re-registering to the same outlet is fine.
- Order lines take name, unit and VAT from the server's catalog at sync time, while price and floor
  come from what the till showed; a pack resized between pull and sale moves the new size.
- Payments tab on the till is a placeholder until M-Pesa.
