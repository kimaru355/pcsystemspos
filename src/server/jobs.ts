import { timingSafeEqual } from 'node:crypto'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { businesses, loginAttempts, memberships, sessions, users } from '@/db/schema'
import { getEnv } from '@/env'
import { formatQty } from '@/domain/money'
import { unitLabel } from '@/domain/units'
import type { Senders } from '@/server/messaging/providers'
import { timeoutStalePushes } from '@/server/services/mpesa'
import { listOutlets } from '@/server/services/outlets'
import { deliverDue, queueMessage } from '@/server/services/receipts'
import { listStock } from '@/server/services/stock'
import { getTenantCtx } from '@/server/tenant'

/*
 * Background jobs, run every minute by the cron container through POST /api/internal/cron:
 * time out unanswered STK pushes, send queued messages, send the daily low-stock email (from
 * 07:00 Nairobi, once per person and day), and purge old login attempts and expired sessions.
 */

const DIGEST_HOUR = 7
const LOGIN_ATTEMPTS_KEEP_DAYS = 30

const nairobi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })

function nairobiParts(now: Date): { day: string; hour: number } {
  const p = Object.fromEntries(nairobi.formatToParts(now).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }
}

/** True when the request carries the cron secret (constant-time). */
export function cronAuthorized(header: string | null): boolean {
  const secret = getEnv().CRON_SECRET
  if (!secret || !header?.startsWith('Bearer ')) return false
  const a = Buffer.from(header.slice(7))
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Queue one low-stock email per owner/manager with an email, for the outlets they can see. */
export async function queueLowStockDigests(db: Db, now = new Date()): Promise<number> {
  const { day } = nairobiParts(now)
  const people = await db
    .select({ userId: users.id, name: users.name, email: users.email, businessId: memberships.businessId, business: businesses.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(businesses, eq(businesses.id, memberships.businessId))
    .where(
      and(
        eq(memberships.active, true),
        inArray(memberships.role, ['owner', 'manager']),
        eq(businesses.status, 'active'),
        sql`${users.email} is not null`,
      ),
    )
  let queued = 0
  for (const p of people) {
    const ctx = await getTenantCtx(db, p.userId)
    if (!ctx) continue
    const sections: string[] = []
    for (const o of (await listOutlets(db, ctx)).filter((x) => x.active)) {
      const low = await listStock(db, ctx, o.id, { lowOnly: true })
      if (low.length === 0) continue
      sections.push(
        [
          `${o.code} · ${o.name}`,
          ...low.map(
            (r) =>
              `  ${r.itemName}: ${formatQty(r.availableMilli)} ${unitLabel(r.availableMilli, r.baseUnit)} free` +
              (r.lowStockMilli !== null ? ` (low at ${formatQty(r.lowStockMilli)})` : '') +
              (r.owedMilli > 0 ? `, ${formatQty(r.owedMilli)} owed to customers` : ''),
          ),
        ].join('\n'),
      )
    }
    if (sections.length === 0) continue
    const body = [`Good morning ${p.name},`, '', `These items are running low at ${p.business}:`, '', ...sections, '', 'Receive stock in Admin, under Stock.'].join('\n')
    const ok = await queueMessage(db, {
      businessId: p.businessId,
      channel: 'email',
      to: p.email!,
      subject: `Low stock today · ${p.business}`,
      body,
      html: null,
      dedupeKey: `digest:${p.userId}:${day}`,
    })
    if (ok) queued += 1
  }
  return queued
}

export async function purgeAuthData(db: Db, now = new Date()): Promise<{ attempts: number; sessions: number }> {
  const a = await db
    .delete(loginAttempts)
    .where(lt(loginAttempts.attemptedAt, new Date(now.getTime() - LOGIN_ATTEMPTS_KEEP_DAYS * 24 * 60 * 60 * 1000)))
    .returning({ id: loginAttempts.id })
  const s = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id })
  return { attempts: a.length, sessions: s.length }
}

export type JobsResult = {
  stkTimedOut: number
  messages: { sent: number; failed: number; waiting: number }
  digests: number
  purged: { attempts: number; sessions: number }
}

// The day the digests last ran in this process. A restart may run them again the same day;
// the per-person dedupe key keeps that from sending anything twice.
let digestDay: string | null = null

export async function runJobs(db: Db, now = new Date(), senders?: Senders): Promise<JobsResult> {
  const stkTimedOut = await timeoutStalePushes(db, now)
  // Digests first so this minute's run also sends them.
  const { day, hour } = nairobiParts(now)
  let digests = 0
  if (hour >= DIGEST_HOUR && digestDay !== day) {
    digests = await queueLowStockDigests(db, now)
    digestDay = day
  }
  const messages = await deliverDue(db, senders, now, 100)
  const purged = await purgeAuthData(db, now)
  return { stkTimedOut, messages, digests, purged }
}
