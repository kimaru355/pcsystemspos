# PC Systems POS

Multi-tenant point of sale and stock management for hardware shops. Next.js (App Router), TypeScript, Drizzle ORM and PostgreSQL.

Currency is KES, stored as integer cents. Phase 1 covers sign-in, businesses, outlets and staff.

## Prerequisites

- Node.js 24
- Docker (with Docker Compose), for the PostgreSQL databases

## Setup

1. Copy the environment file:

   ```bash
   cp .env.example .env
   ```

   If port 5432 is already in use on your machine, uncomment `DB_PORT` in `.env`, set it to a free port (for example `5434`), and use the same port in `DATABASE_URL`.

2. Start the databases (a dev database on `DB_PORT`, and a throwaway test database on port 5433):

   ```bash
   docker compose up -d
   ```

3. Install dependencies and apply the migrations to the dev database:

   ```bash
   npm install
   npm run db:migrate
   ```

4. Create a platform admin and a business with its owner:

   ```bash
   npm run platform -- create-admin --name "Your Name" --email you@example.com --password "<a strong password>"

   npm run platform -- create-business --name "Acme Hardware" --owner-name "Olivia Owner" \
     --owner-email owner@acme.example --owner-password "<temporary password>"
   ```

   Use `--owner-phone 0712345678` instead of `--owner-email` to give the owner a phone login. The owner must change the temporary password at first sign-in.

5. Start the app and open <http://localhost:3000>:

   ```bash
   npm run dev
   ```

   Platform admins sign in and land on `/platform`; business users land on `/admin`.

## Tests

```bash
npm test          # unit tests
npm run test:int  # integration tests (need the test database from docker compose)
npm run test:e2e  # Playwright end-to-end tests (start their own dev server on port 3100)
```

The integration and end-to-end suites empty the database they run against and refuse to run unless its name ends with `_test`. They use `TEST_DATABASE_URL` from `.env`.

Before opening a pull request also run `npx tsc --noEmit`, `npm run lint` and `npm run build`.
