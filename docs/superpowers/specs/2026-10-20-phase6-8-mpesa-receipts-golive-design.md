# Phases 6–8 — M-Pesa, Receipts, Admin Insights and Go-live: Design

Date: 2026-10-20
Status: Approved scope (phases 6, 7 and 8 of the roadmap), built together
Parent spec: `docs/superpowers/specs/2026-10-17-hardware-pos-mvp-design.md` (§9 M-Pesa, §10
receipts, §11 admin, §12 tax readiness, §13 deploy)
Earlier phases: `docs/superpowers/specs/2026-10-18-phase3-5-till-orders-modes-design.md`

**(my call)** marks a decision made by the builder.

## 1. Phase 6 — M-Pesa (Safaricom Daraja)

### 1.1 Settings and credentials

- `mpesa_configs`: one per business (outlet null = the business default) and optionally one per
  outlet that overrides it. Fields: `environment` (sandbox | production), `shortcode_type`
  (paybill | till), `shortcode` (the business/store number used for the STK password),
  `party_b` (the paybill number, or the till number for buy goods), encrypted `consumer_key`,
  `consumer_secret` and `passkey`, `callback_token` (random, part of every callback URL),
  `c2b_registered_at`, `active`.
- **Encryption (my call):** AES-256-GCM with a 32-byte key from `SECRETS_KEY`. Secrets are never
  sent back to the browser; a blank field on the settings form keeps the stored value.
- Owners manage the settings (`business.settings`) on `/admin/settings`.

### 1.2 STK push (online only)

- From an order on the till: phone (pre-filled with the customer's) and amount. Daraja takes whole
  shillings, so the amount is whole KES (pre-filled with the balance rounded up) **(my call)**.
- The order must be on the server: the till syncs first. `POST /api/till/mpesa/stk` (device token)
  sends the push with `AccountReference` = the order number without hyphens (Daraja allows 12
  characters) and a callback URL carrying the config's token. `mpesa_requests` records it.
- The till polls `GET /api/till/mpesa/stk/{id}`: pending → success | failed | timeout (no answer
  after 2 minutes). A success callback that arrives after a timeout still records the payment:
  money that arrived is never ignored.
- **Callback** (`POST /api/mpesa/stk/{token}`): idempotent by `CheckoutRequestID`. Result 0 records
  a `payments` row (`method = mpesa`, `reference` = the M-Pesa receipt number, unique per
  business) through the same order rules as the till.

### 1.3 Paybill/till payments (C2B)

- "Register confirmation URL" on the settings page calls Daraja's C2B register with
  `/api/mpesa/c2b/{token}/confirmation` and `/validation` (validation accepts everything).
- Each confirmation is stored in `mpesa_transactions` (unique by M-Pesa transaction id). For a
  paybill, the account reference is matched to an order number, ignoring case, spaces and hyphens
  (`KTL-01-000123` or `KTL01000123`). A match records the payment; anything else is **unmatched**.
- **Unmatched payments** are listed on the till's Payments tab (online) and on `/admin/payments`,
  where a cashier or manager attaches one to an order by its number. Attaching records the payment
  and the person who matched it (audit `mpesa.attach`).
- **Callback security (my call):** the unguessable token in the URL, plus an optional IP allowlist
  (`MPESA_CALLBACK_IPS`) for Safaricom's published addresses.
- Offline, the till's M-Pesa buttons say "M-Pesa unavailable"; cash and mark-paid still work.

## 2. Phase 7 — Receipts

### 2.1 Documents

- Two kinds: the **order receipt** (after a sale or a payment) and the **collection note** (after
  each collection). Both show the lines, what was paid, what was collected, and what is still
  owed (money and goods).
- One pure function builds a `ReceiptDoc` from an `OrderState` and the event it is for, so the
  till (offline) and the server produce the same receipt. Renderers: 48-column text (ESC/POS and
  email text), HTML for the 80mm browser print, a short SMS text, and ESC/POS bytes.
- **Tax readiness (§12):** every receipt carries a VAT breakdown by tax category and an empty KRA
  invoice/control number. The server stores each receipt in `receipts` (kind, order, source
  payment or collection, the document, the tax breakdown, `kra_invoice_number` null).

### 2.2 Printing

- **PC:** the browser's print dialog with an 80mm page (`@page { size: 80mm auto }`), from a
  print-only element on the till.
- **Android Chrome:** direct ESC/POS over Web Bluetooth. The till asks for a printer once per
  session (a browser rule) and writes the bytes in small chunks to the first writable
  characteristic of the common printer services.
- **iPhone:** no Bluetooth printing; SMS or email instead.

### 2.3 SMS and email

- Requested from the till as an operation, `receipt.send` (order, receipt kind, payment or
  collection id, channel, address), so it works offline and is queued until the next sync.
  The server turns it into a row in `message_outbox` and delivers it after the response.
  Admins can resend from the order page.
- **SMS:** Africa's Talking (`AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`, `AT_SANDBOX`). Each SMS
  records its segment count; the settings page shows the business's usage this month.
- **Email:** Nodemailer to the VPS SMTP server (`SMTP_URL`, `MAIL_FROM`). SPF, DKIM, DMARC and
  reverse DNS are set up on the server (see the deploy runbook).
- **Delivery (my call):** after each sync, and every minute from the cron container, queued
  messages are sent; a failure is retried up to 5 times with backoff, then marked failed.
  Without credentials configured, messages stay queued and the settings page says why.

## 3. Phase 8 — Admin insights and go-live

- **Overview:** today's sales, payments by method, money owed on open orders, credit owed by
  customers, low stock, unmatched M-Pesa payments, negative-stock flags, tills to check.
- **Reports** (`/admin/reports`): for a date range and outlet — sales by day, by outlet, by item,
  by cashier; payments by method; stock on hand. Each table downloads as CSV. Sums run in SQL.
- **Customers** (`/admin/customers`): name, phone, orders, money owed and credit owed; a customer
  page with their order history.
- **Audit log** (`/admin/audit`, owners): every audited action with filters, plus operations the
  server refused from tills (`sync_ops` rejected).
- **Daily low-stock email:** to owners (all outlets) and managers (their outlets) with an email,
  once a day at 07:00 Nairobi, deduplicated per person and day.
- **Jobs (my call):** one cron endpoint `POST /api/internal/cron` guarded by `CRON_SECRET`, called
  every minute by a small container: deliver messages, time out STK requests, send digests (once
  a day), purge old login attempts and expired sessions.
- **PIN exposure (Phase 3–5 follow-up) (my call):** a till now receives PIN verifiers only for
  people who signed in on that till (`device_staff`). Managers and owners who approve on a till
  sign in on it once.
- **Deploy:** `Dockerfile` (Next.js standalone output), `docker-compose.prod.yml` with the app,
  Postgres, Caddy (automatic HTTPS), the cron caller and a nightly `pg_dump` with 14 days kept;
  migrations run when the app container starts. Runbook in `docs/deploy.md`.
- **Phase 1 follow-ups:** the database client is created lazily (so `next build` needs no
  `DATABASE_URL`); the platform CLI reads passwords from stdin, takes `--actor` for audit rows and
  forces new platform admins to change their password.

## 4. Permissions

| Action | Owner | Manager | Cashier |
|---|---|---|---|
| `business.settings` (M-Pesa settings, register URLs) | ✓ | | |
| `payment.match` (attach unmatched M-Pesa payments) | ✓ | ✓ | ✓ |
| `report.view` (reports, customers; outlets in scope) | ✓ | ✓ | |
| `audit.view` | ✓ | | |

## 5. Not in these phases

KRA eTIMS submission, platform billing, B2C refunds through M-Pesa, printing logos.
