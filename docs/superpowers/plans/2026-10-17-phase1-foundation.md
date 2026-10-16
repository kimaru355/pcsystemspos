# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Next.js app where a platform admin creates a business with
an owner, the owner logs in and manages outlets and staff, and a pure domain
module computes money, VAT and the paid-before-collect rule.

**Architecture:** One Next.js App Router app. Business logic lives in plain
TypeScript: pure rules in `src/domain/` (shared later with the offline till)
and database services in `src/server/services/` that take `(db, ctx, input)`
so they can be integration-tested without Next. Server actions and pages are
thin wrappers. Every business-owned table has `business_id`, and every
service scopes by `ctx.businessId`.

**Tech Stack:** Next.js 16 (App Router), TypeScript (strict), PostgreSQL 17
(Docker), Drizzle ORM 0.45 + drizzle-kit, Zod 4, `@node-rs/argon2`, Tailwind 4
+ shadcn/ui, Vitest 5, Playwright 1.64, `tsx` for scripts, npm.

**Spec:** `docs/superpowers/specs/2026-10-17-hardware-pos-mvp-design.md`
**Roadmap:** `docs/superpowers/plans/2026-10-17-mvp-roadmap.md`

## Global Constraints

- Currency KES. Money is stored and computed as **integer cents** (`Cents`). No floats for money anywhere.
- Prices are **VAT-inclusive**. VAT rates are stored as basis points (`1600` = 16%).
- Quantities allow up to 3 decimals and are stored and computed as **integer thousandths** (`Milli`; 2.5 → `2500`).
- Every business-owned table has a non-null `business_id`; every service query filters by `ctx.businessId`. A row from another business is reported as `not_found`, never `forbidden`.
- Roles: `owner`, `manager`, `cashier`. Platform admin is a flag on the user, not a role, and has no membership.
- A user belongs to at most one business in the MVP (designer's call: unique `user_id` on memberships).
- Connection modes: `full_offline`, `default`, `always_online`. Outlet value `null` means "use the business default". Business default is `default`.
- Outlet code: 2–5 uppercase letters/digits, unique per business (used in Phase 3 order numbers `OUTLET-DEVICE-SEQ`).
- Phones are stored in E.164 Kenyan form `+2547XXXXXXXX` / `+2541XXXXXXXX`.
- English-only UI. Target Chrome on Android and Chrome/Edge on desktop.
- Mark-paid, credit, price override, stock adjustment, staff changes and support access always write an audit row with a named actor (Phase 1 covers staff and outlet changes).

## Review Focus

1. **Cross-business IDs** — a user of business A submitting an outlet or staff ID from business B gets `not_found` and nothing changes. Tests in Tasks 7 and 8.
2. **Decimal quantity input** — "2.5", "0.1", "1.005" are parsed exactly (no float drift); more than 3 decimals, negatives, exponents and blanks are rejected. Test in Task 2.
3. **Malformed collection requests** — the same line twice, zero or negative quantities, or an unknown line ID are rejected as `invalid_request` before any money check. Test in Task 3.
4. **Deactivated staff** — their already-open sessions stop working immediately, not at expiry. Test in Task 8.
5. **Password guessing** — after 5 failed logins in 15 minutes for an identifier, even the correct password is refused until the window passes. Test in Task 5.

---

### Task 1: Project scaffold and tooling

**Files:**
- Create: Next.js app at repo root (via `npx create-next-app@16 . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm`)
- Create: `docker-compose.yml`, `.env.example`, `src/env.ts`, `vitest.config.ts`, `vitest.integration.config.ts`, `playwright.config.ts`, `drizzle.config.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `env: { DATABASE_URL: string; NODE_ENV: 'development'|'test'|'production' }` from `src/env.ts`; npm scripts `dev`, `build`, `test` (unit), `test:int`, `test:e2e`, `db:generate`, `db:migrate`, `platform`.

- [ ] **Step 1: Scaffold** with the command above, keep `docs/`. Add deps: `drizzle-orm pg zod @node-rs/argon2`; dev deps: `drizzle-kit @types/pg vitest @playwright/test tsx`. Run `npx shadcn@latest init` (defaults). Set `"strict": true` (already default).
- [ ] **Step 2: `docker-compose.yml`** with two `postgres:17` services: `db` on port 5432 (volume `pgdata`) and `db_test` on port 5433 (tmpfs, no volume). `.env.example`: `DATABASE_URL=postgres://pos:pos@localhost:5432/pos`, `TEST_DATABASE_URL=postgres://pos:pos@localhost:5433/pos_test`.
- [ ] **Step 3: Write failing test** `tests/unit/env.test.ts`: `parseEnv({ NODE_ENV: 'test' })` throws mentioning `DATABASE_URL`; `parseEnv({ DATABASE_URL: 'postgres://x', NODE_ENV: 'test' }).DATABASE_URL === 'postgres://x'`.
- [ ] **Step 4: Implement** `parseEnv(raw: Record<string, string|undefined>)` with Zod in `src/env.ts`, and `export const env = parseEnv(process.env)`.
- [ ] **Step 5: Vitest configs** — `vitest.config.ts` includes `tests/unit/**`; `vitest.integration.config.ts` includes `tests/integration/**`, `fileParallelism: false`, sets `DATABASE_URL` from `TEST_DATABASE_URL`, `globalSetup: tests/helpers/global-setup.ts` (created in Task 4).
- [ ] **Step 6: Verify** `npm test` → PASS; `npm run build` → succeeds; `docker compose up -d` → both DBs healthy.
- [ ] **Step 7: Commit** `chore: scaffold Next.js app, tooling and dev databases`.

---

### Task 2: Domain primitives — money, quantities, phones

**Files:**
- Create: `src/domain/money.ts`, `src/domain/phone.ts`
- Test: `tests/unit/domain/money.test.ts`, `tests/unit/domain/phone.test.ts`

**Interfaces:**
- Produces (from `src/domain/money.ts`):
  - `type Cents = number; type Milli = number;`
  - `parseQty(input: string): Milli` — throws `RangeError` on invalid
  - `formatQty(q: Milli): string` — trims trailing zeros (`2500` → `"2.5"`)
  - `parseMoney(input: string): Cents` — accepts `"1,250.50"`, max 2 decimals, non-negative; throws `RangeError`
  - `formatKes(c: Cents): string`
  - `lineGross(qtyMilli: Milli, unitPriceCents: Cents): Cents` — `Math.round(q * p / 1000)`
  - `vatPortion(grossCents: Cents, vatRateBp: number): Cents` — `Math.round(g * bp / (10000 + bp))`
- Produces (from `src/domain/phone.ts`): `normalizeKePhone(input: string): string | null`

- [ ] **Step 1: Write failing tests** in `money.test.ts`:
  - `parseQty("2.5") === 2500`, `parseQty("0.1") === 100`, `parseQty("1.005") === 1005`, `parseQty("0") === 0`, `parseQty(" 3 ") === 3000`
  - `parseQty` throws for `"1.2345"`, `"-1"`, `"1e3"`, `""`, `"abc"`, `"1.2.3"`
  - `formatQty(2500) === "2.5"`, `formatQty(5000) === "5"`
  - `parseMoney("1,250.50") === 125050`, `parseMoney("750") === 75000`; throws for `"1.234"`, `"-5"`
  - `formatKes(125000) === "KES 1,250.00"`, `formatKes(-5000) === "-KES 50.00"`
  - `lineGross(2500, 12000) === 30000`, `lineGross(5000, 75000) === 375000`
  - `vatPortion(116000, 1600) === 16000`, `vatPortion(75000, 1600) === 10345`, `vatPortion(75000, 0) === 0`
- [ ] **Step 2: Write failing tests** in `phone.test.ts`: `"0712345678"`, `"712345678"`, `"254712345678"`, `"+254 712 345 678"` → `"+254712345678"`; `"0110123456"` → `"+254110123456"`; `"0812345678"`, `"12345"`, `""` → `null`.
- [ ] **Step 3: Run** `npm test` → FAIL (modules missing).
- [ ] **Step 4: Implement** both modules. Parse quantities and money by string splitting on `.` with a regex (`/^\d+(\.\d{1,3})?$/` for qty after trimming), never via `parseFloat`.
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `feat(domain): money, quantity and phone primitives`.

---

### Task 3: Domain — order math and the paid-before-collect rule

**Files:**
- Create: `src/domain/orders.ts`
- Test: `tests/unit/domain/orders.test.ts`

**Interfaces:**
- Consumes: `Cents`, `Milli`, `lineGross`, `vatPortion` from Task 2.
- Produces (from `src/domain/orders.ts`):
  ```ts
  type OrderLine = { lineId: string; itemId: string; qtyMilli: Milli; unitPriceCents: Cents; vatRateBp: number; collectedMilli: Milli };
  type CollectionRequest = { lineId: string; qtyMilli: Milli }[];
  type CollectionCheck =
    | { ok: true; valueCents: Cents }
    | { ok: false; reason: 'invalid_request' | 'exceeds_outstanding' | 'exceeds_stock'; lineId: string }
    | { ok: false; reason: 'exceeds_paid'; shortfallCents: Cents };
  orderTotals(lines: OrderLine[]): { grossCents: Cents; vatCents: Cents }
  outstandingMilli(line: OrderLine): Milli
  collectedValueCents(lines: OrderLine[]): Cents   // Σ lineGross(collectedMilli, unitPrice)
  balanceCents(lines: OrderLine[], paidCents: Cents): Cents  // gross − paid (may be negative = overpaid)
  defaultCollectionRequest(lines: OrderLine[]): CollectionRequest  // every line with outstanding > 0, at full outstanding
  checkCollection(input: { lines: OrderLine[]; paidCents: Cents; creditCents: Cents; request: CollectionRequest; onHandMilli: Record<string, Milli> }): CollectionCheck
  requiresNamedCustomer(state: { lines: OrderLine[]; paidCents: Cents; creditCents: Cents }): boolean
  ```

- [ ] **Step 1: Write failing tests.** Fixture: `cement = { lineId: 'L1', itemId: 'cement', qtyMilli: 5000, unitPriceCents: 75000, vatRateBp: 1600, collectedMilli: 0 }`, `onHand = { cement: 10000 }`.
  - `orderTotals([cement])` → `{ grossCents: 375000, vatCents: 51724 }`
  - `defaultCollectionRequest([cement])` → `[{ lineId: 'L1', qtyMilli: 5000 }]` (the 5/5 default)
  - Fully paid (375000): collecting 5000 → `{ ok: true, valueCents: 375000 }`
  - Paid 150000: collecting 2000 → ok, `valueCents: 150000`; collecting 3000 → `{ ok: false, reason: 'exceeds_paid', shortfallCents: 75000 }`
  - Paid 150000 + credit 75000: collecting 3000 → ok
  - Second visit: `collectedMilli: 2000`, paid 375000: collecting 3000 → ok; collecting 3001 → `exceeds_outstanding`
  - Already collected 2000, paid 150000: collecting 1000 → `exceeds_paid`, shortfall 75000 (earlier collections count)
  - `onHand = { cement: 1000 }`, fully paid, collecting 2000 → `exceeds_stock`, `lineId: 'L1'`
  - Two lines with the same `itemId` (each 3000) and `onHand` 5000, collecting both in full → `exceeds_stock` (stock aggregated per item)
  - Review Focus 3: request `[{L1, 1000}, {L1, 1000}]`, `[{L1, 0}]`, `[{L1, -1000}]`, `[{X, 1000}]` → each `invalid_request`, even when paid is 0
  - `requiresNamedCustomer`: fully paid and collected → `false`; paid < gross → `true`; outstanding qty > 0 → `true`; creditCents > 0 → `true`
  - `balanceCents([cement], 400000) === -25000`
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** in `src/domain/orders.ts`. Check order in `checkCollection`: request validity → outstanding per line → stock per item (sum of requested qty for lines sharing an item ≤ `onHandMilli[itemId] ?? 0`) → value (`collectedValueCents(lines) + Σ lineGross(req) ≤ paidCents + creditCents`). No I/O, no imports outside `src/domain/`.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(domain): order totals and paid-before-collect rule`.

---

### Task 4: Database schema, migrations and test harness

**Files:**
- Create: `src/db/schema/tenancy.ts`, `src/db/schema/auth.ts`, `src/db/schema/audit.ts`, `src/db/schema/index.ts`, `src/db/client.ts`, `drizzle/` (generated migrations)
- Create: `tests/helpers/global-setup.ts`, `tests/helpers/db.ts`
- Test: `tests/integration/schema.test.ts`

**Interfaces:**
- Produces: `db` (Drizzle `NodePgDatabase<typeof schema>`) and `type Db = typeof db` from `src/db/client.ts`; `type Tx` = Drizzle transaction type.
- Tables (all ids `uuid` default `gen_random_uuid()`, all have `created_at timestamptz default now()`):
  - `businesses`: `name`, `status` enum(`active`,`suspended`) default `active`, `default_connection_mode` enum `connection_mode`(`full_offline`,`default`,`always_online`) default `default`
  - `outlets`: `business_id` fk, `name`, `code varchar(5)`, `connection_mode connection_mode null`, `active bool default true`; unique(`business_id`,`code`)
  - `users`: `name`, `email` unique null, `phone` unique null, `password_hash`, `must_change_password bool default false`, `is_platform_admin bool default false`; check (`email is not null or phone is not null`)
  - `memberships`: `business_id` fk, `user_id` fk **unique**, `role` enum(`owner`,`manager`,`cashier`), `pin_hash null`, `active bool default true`
  - `membership_outlets`: `business_id`, `membership_id` fk, `outlet_id` fk; pk(`membership_id`,`outlet_id`)
  - `sessions`: `id text pk` (sha256 hex of token), `user_id` fk cascade, `expires_at timestamptz`
  - `login_attempts`: `id`, `identifier text`, `success bool`, `attempted_at timestamptz default now()`; index(`identifier`,`attempted_at`)
  - `audit_log`: `business_id null` (null = platform event), `actor_user_id` fk, `action text`, `entity_type text`, `entity_id text`, `reason text null`, `data jsonb null`
- Test helpers: `resetDb(): Promise<void>` (TRUNCATE all tables RESTART IDENTITY CASCADE); `seedBusiness(opts?: { name?: string; outletCodes?: string[] }): Promise<{ businessId: string; outletIds: string[]; owner: { userId: string; membershipId: string } }>` — owner email `owner@<slug>.test`, password `password123`.

- [ ] **Step 1: Write schema files** per the table list. Export all tables and enums from `src/db/schema/index.ts`.
- [ ] **Step 2: Generate migration** `npm run db:generate` → one SQL file in `drizzle/`.
- [ ] **Step 3: Write `global-setup.ts`** that runs Drizzle's `migrate()` against `TEST_DATABASE_URL`.
- [ ] **Step 4: Write failing test** `schema.test.ts`: after `resetDb()`, `seedBusiness({ outletCodes: ['KTL','THK'] })` returns 2 outlet ids; inserting a second outlet with code `KTL` in the same business rejects (unique violation); the same code in another seeded business succeeds; inserting a user with neither email nor phone rejects; inserting a second membership for the same user rejects.
- [ ] **Step 5: Run** `npm run test:int` → FAIL until helpers exist; implement `tests/helpers/db.ts`; run → PASS.
- [ ] **Step 6: Run** `npm run db:migrate` against dev DB → succeeds.
- [ ] **Step 7: Commit** `feat(db): tenancy, auth and audit schema with test harness`.

---

### Task 5: Authentication — passwords, sessions, login

**Files:**
- Create: `src/server/auth/secret.ts`, `src/server/auth/session.ts`, `src/server/auth/login.ts`, `src/server/errors.ts`
- Create: `src/app/login/page.tsx`, `src/app/login/actions.ts`, `src/app/change-password/page.tsx`, `src/app/change-password/actions.ts`, `src/app/logout/actions.ts`, `src/server/auth/current-user.ts`
- Test: `tests/integration/auth.test.ts`

**Interfaces:**
- Consumes: `Db`, tables from Task 4; `normalizeKePhone` from Task 2.
- Produces:
  - `class DomainError extends Error { constructor(public code: 'forbidden'|'not_found'|'duplicate_code'|'invalid_input'|'conflict', message?: string) }` in `src/server/errors.ts`
  - `hashSecret(plain: string): Promise<string>`, `verifySecret(hash: string, plain: string): Promise<boolean>` (argon2id; used for passwords and PINs)
  - `SESSION_COOKIE = 'pos_session'`, `SESSION_DAYS = 30`
  - `createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }>` — token = 20 random bytes base32; DB stores sha256 hex
  - `validateSession(db: Db, token: string): Promise<{ userId: string; expiresAt: Date } | null>` — deletes expired; extends to 30 days when < 15 days remain
  - `invalidateSession(db: Db, token: string): Promise<void>`, `invalidateUserSessions(db: Db, userId: string): Promise<void>`
  - `login(db: Db, input: { identifier: string; password: string }): Promise<{ ok: true; token: string; expiresAt: Date; mustChangePassword: boolean } | { ok: false; reason: 'invalid' | 'locked' }>` — identifier is email (case-insensitive) or a phone in any form `normalizeKePhone` accepts
  - `changePassword(db: Db, userId: string, current: string, next: string): Promise<void>` — `next` ≥ 8 chars else `DomainError('invalid_input')`; clears `must_change_password`
  - `getCurrentUser(): Promise<{ id: string; name: string; isPlatformAdmin: boolean; mustChangePassword: boolean } | null>` (reads cookie; Next-only)
  - Lockout: 5 failed attempts for the normalized identifier within the last 15 minutes → `locked`.

- [ ] **Step 1: Write failing tests** in `auth.test.ts` (use `seedBusiness`):
  - Correct email + password → `ok: true`; `validateSession(token)` returns the owner's userId
  - Login by phone `"0712345678"` when the user's phone is `+254712345678` → ok
  - Wrong password → `{ ok: false, reason: 'invalid' }`; unknown email → `'invalid'` (same response)
  - Review Focus 5: 5 wrong passwords then the correct one → `'locked'`; after moving all attempts' `attempted_at` back 16 minutes, the correct password → ok
  - `invalidateUserSessions` → old token validates to `null`
  - Session with `expires_at` in the past → `null`; with 10 days left → `expiresAt` pushed to ~30 days
  - `changePassword` with 7-char password → throws `invalid_input`; valid → `mustChangePassword` false on next login
- [ ] **Step 2: Run** `npm run test:int` → FAIL.
- [ ] **Step 3: Implement** the server modules.
- [ ] **Step 4: Run** `npm run test:int` → PASS.
- [ ] **Step 5: Build pages.** `/login` form (identifier, password) → action sets httpOnly, `sameSite=lax`, `secure` in production cookie and redirects to `/change-password` if `mustChangePassword`, else `/`. `/change-password` form. A `logout()` server action invalidates the session, clears the cookie and redirects to `/login`; a "Log out" button appears in the admin and till layouts. Messages: invalid → "Wrong phone/email or password."; locked → "Too many attempts. Try again in 15 minutes."
- [ ] **Step 6: Commit** `feat(auth): password login, sessions and lockout`.

---

### Task 6: Tenant context and permissions

**Files:**
- Create: `src/domain/permissions.ts`, `src/server/tenant.ts`
- Create: `src/app/page.tsx` (role redirect), `src/app/till/page.tsx` (placeholder)
- Test: `tests/unit/domain/permissions.test.ts`, `tests/integration/tenant.test.ts`

**Interfaces:**
- Produces:
  - `type Role = 'owner' | 'manager' | 'cashier'`
  - `type Action = 'business.settings' | 'outlet.manage' | 'staff.manage' | 'staff.reset_pin'` (later phases extend this union)
  - `can(role: Role, action: Action): boolean` — owner: all; manager: `staff.reset_pin`; cashier: none
  - `type TenantCtx = { userId: string; businessId: string; membershipId: string; role: Role; outletScope: 'all' | string[] }` — owner → `'all'`; others → assigned outlet ids
  - `getTenantCtx(db: Db, userId: string): Promise<TenantCtx | null>` — `null` if no membership, membership inactive, or business suspended
  - `requireTenant(): Promise<TenantCtx>` — Next-only; redirects to `/login` when no user/ctx, to `/change-password` when required
  - `assertCan(ctx: TenantCtx, action: Action): void` — throws `DomainError('forbidden')`

- [ ] **Step 1: Write failing unit test** — table-driven over every role × action matching the matrix above.
- [ ] **Step 2: Write failing integration test** — owner → `outletScope: 'all'`; cashier assigned to one outlet → `[thatOutletId]`; inactive membership → `null`; suspended business → `null`; platform admin user with no membership → `null`.
- [ ] **Step 3: Run** both suites → FAIL. **Implement.** Run → PASS.
- [ ] **Step 4: Root redirect.** `/` → platform admin: `/platform` placeholder; owner/manager: `/admin`; cashier: `/till` (placeholder text "The till arrives in Phase 3.").
- [ ] **Step 5: Commit** `feat: tenant context and role permissions`.

---

### Task 7: Platform CLI and outlet management

**Files:**
- Create: `src/server/services/audit.ts`, `src/server/services/platform.ts`, `src/server/services/outlets.ts`, `scripts/platform.ts`
- Create: `src/app/admin/layout.tsx`, `src/app/admin/page.tsx`, `src/app/admin/outlets/page.tsx`, `src/app/admin/outlets/actions.ts`
- Test: `tests/integration/platform.test.ts`, `tests/integration/outlets.test.ts`

**Interfaces:**
- Consumes: `TenantCtx`, `assertCan`, `DomainError`, `hashSecret`, `normalizeKePhone`.
- Produces:
  - `recordAudit(tx: Tx | Db, e: { businessId: string | null; actorUserId: string; action: string; entityType: string; entityId: string; reason?: string; data?: unknown }): Promise<void>`
  - `createPlatformAdmin(db: Db, i: { name: string; email: string; password: string }): Promise<{ userId: string }>`
  - `createBusinessWithOwner(db: Db, i: { name: string; ownerName: string; ownerEmail?: string; ownerPhone?: string; ownerPassword: string }): Promise<{ businessId: string; ownerUserId: string }>` — owner gets `must_change_password = true`
  - `type ConnectionMode = 'full_offline' | 'default' | 'always_online'`
  - `type Outlet = { id: string; name: string; code: string; connectionMode: ConnectionMode | null; effectiveMode: ConnectionMode; active: boolean }`
  - `listOutlets(db: Db, ctx: TenantCtx): Promise<Outlet[]>` — managers/cashiers see only their scope
  - `createOutlet(db: Db, ctx: TenantCtx, i: { name: string; code: string; connectionMode: ConnectionMode | null }): Promise<Outlet>` — code uppercased, `/^[A-Z0-9]{2,5}$/` else `invalid_input`; duplicate → `duplicate_code`
  - `updateOutlet(db: Db, ctx: TenantCtx, outletId: string, patch: Partial<{ name: string; connectionMode: ConnectionMode | null; active: boolean }>): Promise<Outlet>` — code is immutable
  - `setDefaultConnectionMode(db: Db, ctx: TenantCtx, mode: ConnectionMode): Promise<void>`
  - CLI: `npm run platform -- create-admin --name .. --email .. --password ..` and `npm run platform -- create-business --name .. --owner-name .. (--owner-email ..|--owner-phone ..) --owner-password ..`

- [ ] **Step 1: Write failing tests.** `platform.test.ts`: `createBusinessWithOwner` makes an active business, an owner membership and a user with `must_change_password`; giving neither email nor phone throws `invalid_input`; an invalid phone throws `invalid_input`.
  `outlets.test.ts`:
  - owner creates `{ name: 'Kitale', code: 'ktl', connectionMode: null }` → `code: 'KTL'`, `effectiveMode: 'default'`
  - after `setDefaultConnectionMode('always_online')`, that outlet's `effectiveMode` is `always_online`; an outlet with `full_offline` keeps it
  - duplicate code → `duplicate_code`; code `'K'` or `'TOOLONG'` → `invalid_input`
  - manager or cashier `createOutlet` → `forbidden`
  - Review Focus 1: owner of business A calling `updateOutlet` with business B's outlet id → `not_found`, B's outlet unchanged
  - each create/update writes one `audit_log` row with `action` `outlet.create` / `outlet.update`
- [ ] **Step 2: Run** → FAIL. **Implement** services (wrap writes + audit in one transaction) and `scripts/platform.ts` (parse args with `node:util` `parseArgs`). Run → PASS.
- [ ] **Step 3: Build admin UI.** `/admin` layout with business name and nav (Overview, Outlets, Staff); `/admin` overview placeholder; `/admin/outlets` lists outlets with effective mode, a create form, inline edit of name/mode/active, and a business default-mode selector. Labels: "Full offline", "Default", "Always online", "Use business default". Actions call `requireTenant()` and map `DomainError` codes to form messages.
- [ ] **Step 4: Verify manually** — `npm run platform -- create-business ...`, log in, change password, create two outlets.
- [ ] **Step 5: Commit** `feat: platform CLI, audit log and outlet management`.

---

### Task 8: Staff management and PINs

**Files:**
- Create: `src/server/services/staff.ts`, `src/app/admin/staff/page.tsx`, `src/app/admin/staff/actions.ts`
- Test: `tests/integration/staff.test.ts`

**Interfaces:**
- Consumes: `TenantCtx`, `assertCan`, `recordAudit`, `hashSecret`, `invalidateUserSessions`, `normalizeKePhone`.
- Produces:
  - `type StaffMember = { membershipId: string; userId: string; name: string; email: string | null; phone: string | null; role: Role; outletIds: string[]; active: boolean; hasPin: boolean }`
  - `listStaff(db: Db, ctx: TenantCtx): Promise<StaffMember[]>` — managers see staff sharing at least one of their outlets
  - `createStaff(db: Db, ctx: TenantCtx, i: { name: string; email?: string; phone?: string; role: Role; outletIds: string[]; tempPassword: string }): Promise<StaffMember>` — owner only; `must_change_password = true`; non-owner roles need ≥ 1 outlet; email/phone already used → `conflict`
  - `updateStaff(db: Db, ctx: TenantCtx, membershipId: string, patch: Partial<{ role: Role; outletIds: string[] }>): Promise<StaffMember>`
  - `deactivateStaff(db: Db, ctx: TenantCtx, membershipId: string): Promise<void>` — sets inactive and calls `invalidateUserSessions`
  - `setPin(db: Db, ctx: TenantCtx, membershipId: string, pin: string): Promise<void>` — `/^\d{4,6}$/` else `invalid_input`; owner: anyone; manager: only cashiers sharing an outlet with them, else `forbidden`

- [ ] **Step 1: Write failing tests** in `staff.test.ts`:
  - owner creates a cashier for outlet KTL by phone `0712345678` → stored `+254712345678`, `mustChangePassword` true, `outletIds: [KTL]`
  - cashier with no outlets → `invalid_input`; outlet id from another business → `not_found`; phone already used → `conflict`
  - manager `createStaff` → `forbidden`
  - owner cannot deactivate themselves → `conflict`; demoting or deactivating the last active owner → `conflict`
  - Review Focus 4: cashier logs in (token), owner deactivates them → `validateSession(token)` is `null` and `getTenantCtx` is `null`
  - `setPin('12a4')` and `setPin('123')` → `invalid_input`; manager sets PIN of a cashier in their outlet → `hasPin` true; manager sets PIN of a cashier in another outlet → `forbidden`; manager sets PIN of the owner → `forbidden`
  - Review Focus 1: owner of A calling `updateStaff`/`deactivateStaff` with B's membership id → `not_found`
  - each change writes an audit row (`staff.create`, `staff.update`, `staff.deactivate`, `staff.set_pin`); the PIN itself is never in `data`
- [ ] **Step 2: Run** → FAIL. **Implement.** Run → PASS.
- [ ] **Step 3: Build `/admin/staff`.** List with role, outlets, PIN set yes/no, active; create form (name, phone or email, role, outlets multi-select, temporary password); edit role/outlets; "Set PIN"; "Deactivate" with a confirm step. Managers see only "Set PIN" for their cashiers.
- [ ] **Step 4: Commit** `feat: staff management and till PINs`.

---

### Task 9: End-to-end smoke test

**Files:**
- Create: `tests/e2e/admin-smoke.spec.ts`, `tests/e2e/setup.ts`

**Interfaces:**
- Consumes: `createBusinessWithOwner` (seeded via `tests/e2e/setup.ts` against the test DB), pages from Tasks 5–8.

- [ ] **Step 1: Write the test.** Seed a business with owner `owner@smoke.test` / `password123`. In the browser: log in → land on `/change-password` → set `newpass1234` → land on `/admin` → create outlet "Kitale" `KTL` → create cashier "Jane" with phone `0712345678`, outlet KTL, temp password `temp12345` → set her PIN `4321` → log out → log in as `0712345678` / `temp12345` → change password → land on `/till` and see "The till arrives in Phase 3."
- [ ] **Step 2: Run** `npm run test:e2e` → PASS (Playwright starts `next dev` against `TEST_DATABASE_URL`).
- [ ] **Step 3: Run everything** `npm test && npm run test:int && npm run test:e2e && npm run build` → all PASS.
- [ ] **Step 4: Commit** `test: end-to-end admin smoke test`.
