# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

An installable web app (PWA). Target browsers: Chrome on Android, Chrome/Edge on desktop. Safari on iPhone works except Bluetooth printing.

## Users

A business (brand) runs several outlets. Its people:

- **Cashier / agent** at the outlet counter: creates orders, takes payments, records collections, prints or sends receipts, looks up stock. Works on a budget Android phone (small screen, slow or patchy data), or on a shared desktop PC at the counter with a barcode scanner and an 80mm thermal printer.
- **Outlet manager**: receives and adjusts stock, approves credit and mark-paid by PIN on the till, views outlet reports, manages cashiers' PINs.
- **Business owner / admin**: everything in the business: outlets, staff, items, prices, stock, connection modes, approvals, reports, audit log.
- **Platform admin** (us, PC Systems): creates and suspends businesses, watches platform health. No access to a business's sales data except logged support access.

The till and the admin area are separate surfaces, each optimised for its own person. Neither outranks the other: the till is judged on speed and certainty at a busy counter; the admin area on how clearly owners and managers see money, stock and who did what.

## Product Purpose

A multi-tenant point of sale and stock platform that PC Systems sells to many businesses. The first vertical is hardware shops (iron sheets, cement, paint, pipes, containers) with several outlets. Success: a hardware business can sell, take payment and hand over goods at every outlet, with or without internet, and the owner always knows what was sold, paid, collected and still owed.

## Positioning

Built for the way Kenyan hardware shops actually trade: customers pay in parts and collect in parts, sometimes over several visits; goods never leave beyond what was paid without a named approver; M-Pesa is first-class; and the till keeps selling offline on a cheap Android phone. Generic POS products and ERP bases treat these as custom work.

## Operating Context

- Hierarchy: Platform → Business → Outlets → Devices. Staff belong to a business and are assigned to outlets. Each device is registered to one outlet.
- Staff sign in online at least once with phone/email and password, then unlock the till with a short PIN that works offline.
- Orders are paid by cash (offline), M-Pesa STK push or paybill/till detection (online only), or a manual "mark paid" with an approver and reason.
- Collections: each line defaults to the full outstanding quantity and can be reduced (e.g. 2/5 bags). Collected value may not exceed paid amount plus approved credit; more needs an approver PIN.
- Receipts: order receipt and collection note, printed on 80mm thermal (browser print on PC, Web Bluetooth ESC/POS on Android) or sent by SMS/email.
- Three connection modes per outlet (full offline, default, always online). The UI only reminds staff to connect, getting more insistent over time; it never states the hidden limits.
- Order numbers are made offline: outlet code + device code + sequence, e.g. `KTL-03-000123`.

## Capabilities and Constraints

- Stack: Next.js (App Router), TypeScript, Drizzle ORM, PostgreSQL; shadcn/Base UI components with Tailwind. Deployed with Docker on the platform owner's VPS over HTTPS.
- Currency KES, stored as integer cents; prices are VAT-inclusive. Quantities may be decimals (2.5 metres).
- Stock is a per-outlet ledger. Available = on-hand − owed (ordered, not yet collected). Low-stock alerts fire on available.
- English-only UI in the MVP.
- Must be usable one-handed on a phone and fast with keyboard and barcode scanner on PC.
- The till must open and run offline; admin screens are online-only.
- Built so far (Phase 1): sign-in, forced password change, platform admin, businesses, outlets, staff. Till is a placeholder.
- Not in the MVP: KRA eTIMS, other verticals, platform billing, self-service sign-up, stock transfers, purchase orders, quotations, returns, loyalty, native apps.
- Full spec: `docs/superpowers/specs/2026-10-17-hardware-pos-mvp-design.md`. Roadmap: `docs/superpowers/plans/2026-10-17-mvp-roadmap.md`.

## Brand Commitments

- The platform name is **PC Systems POS**; PC Systems is the platform owner, shown to every business that uses it.
- No logo or other brand assets exist yet.

## Evidence on Hand

- No customers, testimonials, logos or usage figures exist yet. The first hardware client is not named in the product; do not invent client names, numbers or claims.
- Current UI screenshots: `screenshots/` (login, platform, change password, admin overview, outlets, staff, till placeholder).

## Product Principles

1. **Money and goods are never ambiguous.** Every screen makes clear what is paid, collected and still owed, and who approved any exception.
2. **The counter never waits.** A short internet cut or a slow phone must not stall a sale; offline is a normal state, not an error.
3. **Each surface serves its own person.** The till is fast, thumb-sized and focused; the admin area is dense, scannable and auditable.
4. **Approvals are deliberate and traceable.** Credit, mark-paid and price overrides always carry a named person and a reason.
5. **One business never sees another.** Tenancy is visible in every scope and never assumed.

## Accessibility & Inclusion

- Must run well on low-end Android phones with small screens and slow data: light pages, large touch targets, one-handed reach.
- Full keyboard and barcode-scanner operation on the desktop till.
- No formal standard was set; WCAG 2.2 AA is the working default.
