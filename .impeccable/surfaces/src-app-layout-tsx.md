---
version: 1
slug: "src-app-layout-tsx"
primary_target: "src/app/layout.tsx"
related_targets: ["src/app/till/page.tsx","src/app/admin/layout.tsx","src/app/platform/page.tsx"]
---

# App shell (till and admin)

Mode: Operate. Scope: the frame every phase plugs into — sign-in, till shell, admin shell, platform shell — production-ready, all states.

## Job and audience
- Cashiers at the counter (budget Android one-handed, or a shared desktop with scanner and 80mm printer) and owners/managers (admin, all outlets by default with an outlet filter; managers see only their assigned outlets). Platform admins get the same shell with their own nav.
- Failure named by the user: too slow for regulars. Every common till action is one tap or one keystroke.

## Structure
- **Till** is a locked, device-bound mode. PIN unlock screen (staff picker + keypad). Status strip on top: outlet, device code, signed-in cashier, sync state, and connection reminders that grow more insistent over time and never state limits. Work areas: Sale (coded item grid + open order), Orders (find by number or customer phone), Stock lookup, Payments to match. Phone: bottom tab bar, order as a bottom sheet with its total always visible. Desktop: two panes, scan/search field always focused, keyboard shortcuts.
- **Manager PIN → admin** from the till: time-boxed, returns to the till on inactivity; unavailable offline (admin is online-only).
- **Admin**: dark rail with sections (Overview, Orders, Customers, Items, Stock, Outlets, Staff, Devices, Payments, Reports, Audit log, Settings); unbuilt sections are shown but marked "coming". Top bar: outlet filter (All outlets default), user menu. Phone: rail collapses to top bar + menu sheet.
- **Platform**: same shell, nav = Businesses, Health, Support access log.

## States and ranges
- Online, offline (normal state, not an error), syncing, reminder levels, sales blocked, device revoked, business suspended, M-Pesa unavailable, STK pending, approver PIN prompt, empty first-run screens, negative-stock flag.
- 1–10 outlets; 50–3,000 items; 2–50 staff; 20–300 orders per outlet per day; amounts KES 50 to 2,000,000; order numbers like KTL-03-000123.

## Direction contract
THESIS: Every sale, payment and collection lands as a one-line, code-first confirmation with the new balance owed, in the transaction-SMS grammar Kenyans read daily. Refuses the KPI-cards-over-tables SaaS default.
OWN-WORLD: near-white neutral ground (not cream), ink-black text, a dark night-blue message-thread rail; state colour only for paid (green), owed (amber), credit (red); one action colour reserved for pressable things; one-device-pixel rules; at most three ink values per region; tabular figures at full contrast; codes in a narrow mono. Never Safaricom's green, logo or wording.
STORY: Staff see at a glance what was sold, paid, collected and still owed, and who approved any exception; regulars never wait on the screen.
FIRST VIEWPORT: Till desktop: coded item grid left (~60%), open order right ending in its live confirmation line and settlement bar, total and Pay at bottom right. Till phone: grid full-width, order sheet pinned at the bottom with total and Pay under the thumb. Admin: dark rail left, outlet filter top, today's confirmation thread beside money and goods owed.
FORM: Confirmation Thread, position 5 of 7 on the grounded list; seed key d2eecb89. Raises: settlement bar (labanotation), dense coded item grid (convention catalog), action-only colour (consumer app), one-pixel rules and three inks (reference edition), full-contrast tabular figures (datamatics), one region owns each screen (guide map).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Open decisions
- Exact faces and colour values are chosen at build. Light theme only (daylight counter); dark rail is the only dark region.
- Till screens beyond the shell (sale logic, payments) arrive with Phases 3–4; the shell shows them with synthetic, labelled demo data only where a placeholder is needed.
