# Multi-Store POS Platform — MVP Design (Hardware Stores)

Date: 2026-10-17
Status: Draft, awaiting approval

Throughout this document, **(my call)** marks a decision made by the designer
rather than the client. Everything else was stated by the client.

## 1. Intent

We are building a point-of-sale **platform** that we will sell to many
businesses (inspired by Reatech360 for the POS/inventory side and WHMCS for the
"platform that bills its customers" side). The first customer is a **hardware
store** selling iron sheets, cement, paint, containers, pipes and similar
building materials, from several outlets.

We are building from scratch (no ERPNext/Odoo base) and will improve over time.
The reason: the parts that matter most to this client — offline selling,
M-Pesa, the paid-before-collect rule, and phone-friendly screens — would be
custom work on any existing base, and the open-source options either lack
reliable offline POS or bring licensing/trademark and hosting weight.

The MVP must be excellent for hardware stores. Other verticals (supermarket,
hotel, hospital, e-shop API) come later; the core should not make them hard to
add, but no work goes into them now.

## 2. Goals

1. Sell from a phone (Android) or a PC, through an installable web app (PWA).
2. Keep selling without internet, and sync automatically when back online,
   under three connection modes chosen by the admin (section 7).
3. Multi-store: a business (brand) has several outlets sharing one database;
   each outlet has its own stock.
4. Orders that are paid in parts and collected in parts, with the rule that a
   customer cannot take goods they have not paid for unless an admin approves
   credit.
5. M-Pesa: send STK push and detect paybill/till payments when online; show
   "M-Pesa unavailable" when offline.
6. Receipts: printed on an 80mm thermal printer, and/or sent by SMS and email.
7. Inventory tracking per outlet with low-stock alerts.
8. Admin fail-safes: mark an invoice paid without a detected payment (with a
   reason and audit trail).
9. Admin manages employees/agents, outlets, items and devices.
10. Multi-tenant from day one: no business can ever see another's data.

## 3. Non-goals for the MVP (planned later)

- KRA ETR / eTIMS integration (the data model must be ready for it — section 12).
- Other verticals (supermarket, hotel, hospital, e-shop API).
- Platform billing of businesses (WHMCS-style subscriptions). Billing is done
  by hand for now. **(my call)**
- Self-service business sign-up; the platform admin creates businesses.
  **(my call)**
- Stock transfers between outlets, supplier purchase orders, quotations,
  returns of goods already collected, multiple units of measure per item,
  loyalty, promotions. **(my call)** The stock ledger (section 6) is designed
  so transfers and returns can be added later.
- Native mobile apps. iPhones are supported in the browser but cannot print to
  Bluetooth printers; they use SMS/email receipts. **(my call)**

## 4. Anti-goals (would be a failure even if it "works")

- A sale, payment or collection made offline is ever lost or counted twice.
- Goods leave the store beyond what was paid without a recorded approval.
- A "mark paid" or credit approval happens without a named person and reason
  in the audit log.
- One business can see or affect another business's data.
- The till blocks a cashier in the middle of a busy period because of a short
  internet cut (in default or always-online mode within their limits).

## 5. Structure, users and roles

**Hierarchy:** Platform → Business (brand) → Outlets → Devices. Staff belong to
a business and are assigned to one or more outlets.

Roles **(my call on the exact set)**:

| Role | Can do |
|---|---|
| Platform admin (us) | Create/suspend businesses, see platform health. No access to a business's sales data except for support, and that access is logged. |
| Business owner / admin | Everything within the business: outlets, staff, items, prices, stock, connection modes, mark-paid, credit approval, reports, audit log. |
| Outlet manager | Within assigned outlets: receive/adjust stock, approve credit and mark-paid, view outlet reports, manage cashiers' PINs. |
| Cashier / agent | Create orders, take payments, record collections, send/print receipts, look up stock. |

Approvals (credit, mark-paid, price below the floor) are done by an owner or
manager entering their **PIN on the till**, so they work offline. **(my call)**

**Login:** a staff member signs in with phone/email and password on a device
while online at least once. After that they unlock the till with a short PIN,
which works offline. Each device is registered to one outlet; the admin can
revoke a device. **(my call)**

## 6. Catalog and inventory

- **Items** are defined per business: name, SKU/barcode (optional), unit label
  (e.g. bag, piece, sheet, litre, metre), selling price, VAT rate and tax
  category, low-stock threshold, active flag. One unit per item in the MVP;
  quantities may be decimals (e.g. 2.5 metres). **(my call)**
- **One price list per business** in the MVP. A cashier can lower a line price
  only down to a floor set per item; lower than that needs an approver PIN.
  **(my call)**
- **Stock is per outlet** and is a ledger of movements: received, adjusted
  (with reason), collected (goods leaving on an order). On-hand = sum of
  movements. Every movement records who, when, which device, and why.
- **Receiving stock:** a simple "receive" form (item, quantity, optional cost).
  No suppliers or purchase orders in the MVP. **(my call)**
- **Owed stock** = quantity ordered but not yet collected on open orders at that
  outlet. **Available** = on-hand − owed.
- **Low-stock alerts** fire when *available* falls to or below the threshold.
  Shown on the admin dashboard and the till's stock view, plus a daily email
  digest to owners/managers. **(my call on the delivery channels)**

## 7. Connection modes

Set per outlet by the admin, with a business-wide default **(my call: per
outlet)**. A device picks up a mode change at its next sync.

| Mode | Reminders start | Hidden limit before new sales are blocked |
|---|---|---|
| Full offline | Never | None |
| Default | After 1 day without a successful sync | 7 days |
| Always online | After 1 hour offline | 1 day |

- The UI never mentions the limits; it only reminds staff to connect, getting
  more insistent the longer it goes. **(my call on escalation style)**
- Every device must have been online at least once (first sign-in and initial
  download).
- Every mode syncs automatically whenever a connection is available, including
  full offline, so the owner still gets the data.
- When a limit is reached, **new sales are blocked**; looking up stock and
  orders, reprinting receipts, and syncing still work. Unsynced data on the
  device is never discarded. **(my call)**
- Limits are measured from the **last successful sync**. To resist clock
  tampering, the device uses the server time from the last sync plus elapsed
  running time, and flags large clock jumps to the admin. **(my call)**
- The admin dashboard shows each device's last sync time and flags devices that
  are past their reminder point.

## 8. Orders, payments and collections

This is the heart of the hardware workflow.

**Orders**
- An order belongs to one outlet and has lines (item, quantity, unit price, VAT).
- Quantities may exceed the outlet's current stock (the customer can pay now
  and collect later when stock arrives).
- A customer is optional for an order that is fully paid and fully collected on
  the spot (walk-in). A **named customer (name + phone)** is required whenever
  something is left outstanding: unpaid balance, uncollected goods, or credit.
  **(my call)**
- Order numbers must be unique without the server: outlet code + device code +
  sequence, e.g. `KTL-03-000123`. **(my call)**

**Payments**
- An order can be paid in several parts, by any mix of methods:
  - Cash (works offline).
  - M-Pesa STK push to the customer's phone (online only).
  - M-Pesa paybill/till payment detected from Safaricom's confirmation (online
    only) — see section 9.
  - **Manual "mark paid"** by an approver with a required reason — the fail-safe
    when a real payment was not detected. Recorded with approver, reason, time,
    device.
- Overpayment is held as customer credit balance on the order (or refunded
  manually); no change-giving logic beyond showing change due for cash.
  **(my call)**

**Collections**
- Completing an order opens a collection screen. Each line defaults to the full
  outstanding quantity (e.g. 5/5 bags); the cashier can reduce it (2/5). The
  order stays open with the remainder owed.
- A customer may collect over several visits, at the **same outlet** where the
  order was placed. **(my call)**
- **Rule:** the value of everything collected so far may not exceed the amount
  paid plus any approved credit. Value = quantity × the line's unit price
  including VAT. **(my call that the limit is by value, not per item)**
- Collecting more than that requires an approver PIN to grant credit; the
  credit amount is recorded against the named customer as money owed.
  There is no per-customer credit limit in the MVP; each grant is approved
  individually. **(my call)**
- Credit is repaid by taking further payments on the same order, by any
  method; the customer's owed balance falls accordingly.
- The till does not let a collection exceed the outlet's on-hand stock as the
  device knows it. If two offline devices in the same outlet together collect
  more than exists, the server accepts both on sync, stock goes negative, and
  the item is flagged for the admin to resolve. **(my call)**
- Each collection produces its own collection note (receipt) showing what was
  taken now and what is still owed.

**Order states:** open → fully paid and/or fully collected → closed. An admin can
cancel the uncollected remainder of an order and record a refund (the actual
cash/M-Pesa refund is done outside the system). **(my call)**

## 9. M-Pesa (Safaricom Daraja)

- Each business enters its own M-Pesa details (shortcode, type paybill/till,
  passkey, consumer key/secret). Money goes straight to the business.
  Credentials are stored encrypted. An outlet may override the business's
  details with its own paybill/till, since branches often have separate till
  numbers. **(my call)**
- **STK push:** cashier enters/confirms the customer phone and amount; the
  server sends the request; the till shows pending → success/failed/timeout
  from Safaricom's callback.
- **Paybill/till detection (C2B):** the server registers confirmation URLs for
  each shortcode. Incoming payments are matched to an order by the account
  reference (= order number) for paybill. Payments that cannot be matched
  (till/buy-goods, wrong reference) land in an **unmatched payments** list where
  a cashier or manager attaches them to an order. **(my call)**
- Offline: M-Pesa buttons show "M-Pesa unavailable"; cash still works; a
  manager can later mark paid if needed.
- Sandbox and production credentials are both supported per business.

## 10. Receipts

- Document types: order receipt (on payment), collection note (on each
  collection). Both show paid, collected and outstanding amounts.
- **Print:** 80mm thermal.
  - PC: the browser print dialog with an 80mm layout (works with any installed
    USB/network printer).
  - Android Chrome: direct ESC/POS printing over Web Bluetooth.
  - iPhone: no direct printing; use SMS/email.
- **SMS:** via Africa's Talking, from the platform's sender ID. SMS usage is
  counted per business for later billing. **(my call)**
- **Email:** sent from the platform owner's VPS mail server (SMTP). SPF, DKIM,
  DMARC and reverse DNS must be set up for deliverability.
- SMS/email requested while offline are queued and sent after the next sync.
- Reprint and resend are available from the order screen.

## 11. Admin area

Online-only screens (no offline requirement) **(my call)**:

- Dashboard: today's sales per outlet, payments by method, outstanding
  balances, credit owed by customers, low-stock list, unmatched M-Pesa
  payments, device last-sync status, negative-stock flags.
- Outlets: create/edit, connection mode, M-Pesa settings (business default,
  optional per-outlet override).
- Staff: invite, assign role and outlets, reset PIN, deactivate.
- Devices: list, outlet assignment, revoke.
- Items and prices; stock receive/adjust; stock levels per outlet.
- Customers: list, balances, credit owed, order history.
- Audit log: mark-paid, credit approvals, price overrides, stock adjustments,
  cancellations, device revocations, support access.
- Basic reports: sales by day/outlet/item/cashier, payments by method, stock on
  hand. CSV export. **(my call)**

## 12. Tax readiness (for ETR / eTIMS later)

From day one: each item stores a VAT rate and tax category; each order line
stores its tax amount; each receipt stores a tax breakdown and has an empty
field for a KRA invoice/control number. No KRA integration in the MVP.
Currency is KES; prices are VAT-inclusive. **(my call: VAT-inclusive)**

## 13. How it gets made

Decided by the client:
- **Next.js** (the client's primary stack) and **PostgreSQL**.
- **Email from the platform owner's VPS.**
- Build from scratch.

Designer's calls:
- TypeScript throughout; one Next.js app (App Router) serving the admin area,
  the till, and the API.
- The till is a client-rendered section of the app, cached by a service worker
  (Serwist) so it opens and runs offline. Admin pages may be server-rendered and
  online-only.
- Local data on the device in IndexedDB (via Dexie): the outlet's items,
  prices, stock, open orders, customers, plus an outbox of actions not yet
  synced.
- **Sync:** every offline action (create order, add payment, record collection,
  approval, stock adjustment) is stored as an operation with a client-generated
  UUID and pushed to one sync endpoint; the server applies each exactly once
  (idempotent by UUID) and returns changes since the device's last cursor. The
  server is the source of truth for money and stock.
- Business rules (collection limit, totals, tax) live in a shared TypeScript
  module used by both the till and the server, so offline and online agree.
- Drizzle ORM for PostgreSQL. Every business-owned table carries `business_id`;
  all queries are scoped by it.
- Daraja for M-Pesa, Africa's Talking for SMS, Nodemailer to the VPS SMTP for
  email.
- Deployed on the platform owner's VPS with Docker (app + Postgres), HTTPS required
  (needed for service workers and M-Pesa callbacks).
- English-only UI in the MVP. **(my call)**
- Target browsers: Chrome on Android, Chrome/Edge on desktop. Safari on iPhone
  works except Bluetooth printing.

## 14. Left to the builder

- Auth library choice (must support online password login plus offline PIN
  unlock on a registered device).
- UI component library and visual design (must be usable one-handed on a phone
  and fast with a keyboard/barcode scanner on PC).
- Exact sync protocol shape, batching, retry/backoff.
- Database schema details, indexes, migrations.
- Test strategy (the sync and the collection-limit rule deserve the heaviest
  testing).
- Folder structure and tooling.

## 15. Open items

- No go-live date has been given yet.
