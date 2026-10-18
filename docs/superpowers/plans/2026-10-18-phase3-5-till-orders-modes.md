# Phases 3–5 — Till, Sync, Orders, Connection Modes: Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-18-phase3-5-till-orders-modes-design.md`

**Architecture:** same layering as Phases 1–2.
- Pure rules in `src/domain/` shared by the till and the server: operation
  schemas (`sync-ops.ts`), order state and its transitions (`order-state.ts`,
  extending `orders.ts`), connection policy and the trusted clock
  (`connection-modes.ts`, `trusted-clock.ts`), the PIN verifier (`pin.ts`).
- Server services in `src/server/services/` taking `(db, ctx, input)`:
  `devices.ts`, `till-auth.ts`, `sync.ts` (push + pull), `orders.ts`.
- API route handlers for the till under `src/app/api/` (device-token auth).
- The till client in `src/client/till/` (Dexie database, outbox, sync loop,
  clock) and its screens in `src/app/till/`.

## Global constraints

- Money in integer cents, quantities in integer thousandths, as before.
- Every new table has `business_id`; every query filters by it. Foreign or
  malformed ids are `not_found`.
- Client-generated uuids for orders, lines, payments, collections, movements
  and ops. The server validates every uuid in sync input.
- Lock order inside a transaction: the order row (FOR UPDATE), then items
  sorted by id (FOR SHARE), then their `outlet_stock` rows.
- Every op is applied exactly once (`sync_ops` primary key).

## Tasks

1. **Schema** — devices, sync_ops, customers, orders, order_lines, payments,
   collections, collection_lines; memberships unique on active user only;
   PIN verifier columns; audit columns; append-only ledger trigger;
   composite `(business_id, outlet_id)` FK on membership_outlets; indexes from
   the Phase 2 follow-ups. Schema tests.
2. **Domain** — permissions, PIN verifier, sync op zod schemas, order state
   (checkout, payment, collection, cancel), `checkCollection` follow-ups,
   connection policy, trusted clock. Unit tests.
3. **Staff moves** — `createStaff` reuses a person with no active membership;
   `reactivateStaff` refuses when active elsewhere; `setPin` writes the
   verifier. Integration tests.
4. **Devices and till sign-in** — register, revoke, list, authenticate token,
   till sign-in with PIN set/verify. Integration tests.
5. **Sync** — push (exactly once, rejections stored), pull sections with
   hashes, `stock.adjust` op. Integration tests incl. replay and concurrency.
6. **Orders** — `sale.checkout`, `payment.add`, `collection.record`; owed
   stock; cancel remainder and refund; admin queries. Integration tests incl.
   two devices over-collecting and negative stock.
7. **Till client** — Dexie schema, outbox, sync loop, trusted clock, unlock,
   sale/checkout, orders, stock, connection reminders and blocking; service
   worker and manifest. Unit tests with fake-indexeddb.
8. **Admin** — devices page (last sync, flags, revoke), orders list and
   detail (cancel remainder, refund), nav entries.
9. **E2E** — register a till, sign in, sell offline, come back online, see the
   order in admin.
