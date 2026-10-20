# Deploying PC Systems POS on a VPS

One Linux server (2 vCPU, 4 GB RAM is plenty for the first clients) runs everything with Docker
Compose: the app, PostgreSQL, Caddy (HTTPS with automatic certificates), a cron caller for
background jobs, and nightly database backups.

## 1. Before you start

- A server with Docker and the Compose plugin, ports 80 and 443 open.
- A domain name, e.g. `pos.example.co.ke`, with an `A` record pointing at the server. HTTPS is
  required: tills install and work offline only over HTTPS, and Safaricom only calls back to
  HTTPS URLs.
- For email receipts: the mail server on the VPS (or any SMTP account). See section 6.
- For SMS receipts: an Africa's Talking account with an approved sender ID.

## 2. First deploy

```bash
git clone <repo> pos && cd pos
cp .env.production.example .env.production
# Fill in .env.production. Generate the secrets with:
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 32   # SECRETS_KEY  (keep a copy somewhere safe: without it the stored
                          #               M-Pesa credentials cannot be read)
openssl rand -hex 32      # CRON_SECRET

docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f app caddy
```

The `migrate` service applies the database migrations and exits; the app starts after it.
Caddy gets the certificate on the first request to the domain.

Create the first platform admin and a business (passwords are read from the prompt, never from
the command line; both must be changed at first sign-in):

```bash
alias pos='docker compose -f docker-compose.prod.yml --env-file .env.production'
pos run --rm tools npm run platform -- create-admin --name "Your Name" --email you@example.co.ke
pos run --rm tools npm run platform -- create-business --name "Acme Hardware" \
  --owner-name "Olivia Owner" --owner-phone 0712345678 --actor you@example.co.ke
```

The owner then signs in at `https://<domain>`, opens outlets, adds staff and items, and sets up
each till by opening `https://<domain>/till` on it (see the README).

## 3. Updating

```bash
git pull
pos up -d --build
```

Migrations run before the new app starts. A new build changes the till's service worker, so tills
pick up the new version the next time they open (online).

## 4. Background jobs

The `cron` service calls `POST /api/internal/cron` every minute with `CRON_SECRET`. Each run:

- times out STK pushes nobody answered (a late success still records the payment);
- sends queued SMS and email (retried with backoff, given up after 5 tries);
- from 07:00 Nairobi, emails owners and managers their low stock, once a day;
- deletes login attempts older than 30 days and expired sessions.

Check it with `pos logs cron`. The output of one run: `curl -X POST -H "Authorization: Bearer
$CRON_SECRET" https://<domain>/api/internal/cron`.

## 5. Backups and restore

The `backup` service writes `pg_dump` custom-format files to `./backups` every 24 hours and keeps
14 days. **Copy them off the server** (e.g. a nightly `rclone` or `rsync` to other storage): a
backup on the same disk does not survive losing the server.

Restore into a fresh database:

```bash
pos stop app cron
pos exec -T db dropdb -U pos pos && pos exec -T db createdb -U pos pos
pos exec -T db pg_restore -U pos -d pos --no-owner < backups/pos-YYYYMMDD-HHMM.dump
pos up -d
```

Test a restore on another machine before the first client goes live.

## 6. Email deliverability (receipts and digests)

Set these DNS records for the sending domain, or receipts will land in spam:

- **SPF:** `TXT @ "v=spf1 a mx ip4:<server IP> -all"`
- **DKIM:** generate a key on the mail server (e.g. OpenDKIM or the mail stack's tool) and publish
  its `TXT <selector>._domainkey` record.
- **DMARC:** `TXT _dmarc "v=DMARC1; p=quarantine; rua=mailto:postmaster@<domain>"`
- **Reverse DNS:** ask the VPS provider to set the server IP's PTR record to the mail hostname.

Then set `SMTP_URL` and `MAIL_FROM` in `.env.production` and restart: `pos up -d app`.
The Settings page in Admin says whether SMS and email are ready.

## 7. M-Pesa go-live

Per business (or per outlet with its own till number), in Admin → Settings:

1. Start with **Sandbox** credentials from the Daraja portal and test an STK push from a till.
2. After Safaricom approves the production app, switch to **Production** and enter the production
   consumer key, secret and passkey.
3. Press **Register with Safaricom** so paybill/till payments reach the system. Re-register after
   changing the paybill or till number.

Optionally set `MPESA_CALLBACK_IPS` to Safaricom's published callback addresses so only they can
call the callback URLs (each URL also carries a random secret).

## 8. Things to watch

- `pos logs app` for errors; `M-Pesa STK callback failed` lines include the callback body so a
  payment can be recorded by hand if the database was down.
- Admin → Tills flags tills that have not synced for a while or whose clock was changed.
- Admin → Audit log → "Refused from tills" lists anything a till recorded that the server refused.
