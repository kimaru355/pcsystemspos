# Phases 6–8 — M-Pesa, Receipts, Insights and Go-live: Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-20-phase6-8-mpesa-receipts-golive-design.md`

Same layering as before: pure rules in `src/domain/` (receipt document and renderers), services in
`src/server/services/` (`mpesa.ts`, `receipts.ts`, `reports.ts`, `audit-log.ts`), external clients
in `src/server/mpesa/` and `src/server/messaging/` (injectable for tests), jobs in
`src/server/jobs.ts`, thin routes and pages.

## Tasks (as built)

1. **Schema** — mpesa_configs, mpesa_requests, mpesa_transactions, receipts, message_outbox,
   device_staff; payments.reference (unique M-Pesa receipt) and a nullable actor. Lazy db client;
   AES-256-GCM secrets helper.
2. **M-Pesa** — Daraja client (token, STK, C2B register, callback parsers); settings per business
   and outlet; STK push, status and callback; C2B confirmation and matching; unmatched list and
   attach (till and admin); till M-Pesa at checkout and from an order; Payments tab.
3. **Receipts** — receipt document, 48-column text, SMS text, ESC/POS bytes; receipts stored per
   payment/collection; `receipt.send` op; message outbox with claim-and-send delivery, retries,
   Africa's Talking and SMTP senders; till print (80mm page and Web Bluetooth); admin resend and
   SMS usage.
4. **Insights** — SQL reports with CSV export; customers; audit log viewer with refused till ops;
   overview figures; low-stock digest; cron endpoint; purge; PIN verifiers only for people
   enrolled on a till.
5. **Go-live** — standalone build, Dockerfile, production compose (Postgres, migrate, app, Caddy,
   cron, backups), runbook; platform CLI with stdin passwords and `--actor`.
6. **Tests** — unit (Daraja helpers and client, receipts), integration (M-Pesa, receipts and
   delivery, reports, jobs, platform audit), e2e (receipt queued offline; M-Pesa settings, a
   simulated paybill confirmation, attach; reports, customers, audit).
