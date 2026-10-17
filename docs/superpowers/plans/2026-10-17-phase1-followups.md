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
