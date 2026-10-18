# Hardware POS MVP — Roadmap

**Spec:** `docs/superpowers/specs/2026-10-17-hardware-pos-mvp-design.md`

The MVP is split into phases. Each phase ends with working, tested software
and gets its own detailed plan in `docs/superpowers/plans/`, written when the
phase starts so it can build on what the previous phase actually produced.

Ordering principle: the till must be offline-first from the moment it exists.
So the sync engine (Phase 3) comes **before** orders (Phase 4), and every till
action is built as a sync "operation" from day one, never as a direct server
call that later has to be rewritten.

| # | Phase | Delivers (testable) | Spec sections |
|---|---|---|---|
| 1 | **Foundation** | Next.js app, Postgres schema for platform → business → outlets → staff, password login and sessions, roles and permissions, owner can manage outlets and staff, pure domain module for money, tax and the collection-limit rule, audit log helper. | 5, 7 (mode field only), 12, 13 |
| 2 | **Catalog and inventory** | Items, prices and price floors, VAT per item, per-outlet stock ledger (receive, adjust), owed and available stock, low-stock list. Admin screens. | 6, 12 |
| 3 | **Till shell and sync engine** | Installable PWA (Serwist), device registration to an outlet, PIN unlock offline, IndexedDB (Dexie) local data, outbox of operations with client UUIDs, `/api/sync` push/pull with exactly-once apply, offline order numbering `OUTLET-DEVICE-SEQ`. First operation type: stock adjustment. | 5 (login/devices), 13 (sync) |
| 4 | **Orders, payments, collections** | Till order screen, cash payments, partial payments, collection screen (5/5 → 2/5), paid-before-collect rule, approver PIN for credit / mark-paid / price below floor, named-customer rule, cancel remainder + refund record, negative-stock flagging. All as sync operations. | 8 |
| 5 | **Connection modes** | Full offline / default / always online, reminders, hidden limits that block new sales, tamper-resistant clock, per-outlet mode with business default. | 7 |
| 6 | **M-Pesa** | Per-business credentials (outlet override), STK push with status, C2B confirmation, matching by account reference, unmatched payments list, "M-Pesa unavailable" offline. | 9 |
| 7 | **Receipts** | Order receipt and collection note; 80mm browser print; Web Bluetooth ESC/POS on Android; SMS (Africa's Talking) and email (VPS SMTP) with offline queueing; reprint/resend; SMS usage counter. | 10 |
| 8 | **Admin insights and go-live** | Dashboard, reports + CSV, customers and credit owed, audit log viewer, device last-sync status, daily low-stock email digest, Docker deploy on the VPS with HTTPS and backups. | 11, 13 (deploy) |

**Status (2026-10-18):** Phases 1–5 are built. Phases 3–5 were designed and built together:
`docs/superpowers/specs/2026-10-18-phase3-5-till-orders-modes-design.md` and
`docs/superpowers/plans/2026-10-18-phase3-5-till-orders-modes.md`. The till uses a hand-written,
build-versioned service worker instead of Serwist (see that spec, §2).

After Phase 8 the first hardware client can go live. Later work (not
planned yet): KRA eTIMS, platform billing, self sign-up, stock transfers,
quotations, returns, other verticals.
