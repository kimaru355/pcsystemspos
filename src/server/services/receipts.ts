import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import { businesses, messageOutbox, outlets, receipts } from '@/db/schema'
import { isUuid } from '@/domain/ids'
import { normalizeKePhone } from '@/domain/phone'
import { buildReceipt, receiptSms, receiptText, smsSegments, type ReceiptDoc, type ReceiptKind } from '@/domain/receipt'
import type { ReceiptSend } from '@/domain/sync-ops'
import { DomainError } from '@/server/errors'
import { envSenders, ProviderError, type Senders } from '@/server/messaging/providers'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'
import { loadOrderStates, type OpContext } from './orders'

/*
 * Receipts and the messages that carry them.
 *
 * Every payment and collection the server records issues a receipt row (the document, its VAT
 * breakdown, an empty KRA number). SMS and email go through `message_outbox`: queued by the
 * till's `receipt.send` operation or an admin resend, and delivered after the sync response and
 * by the cron job, with retries.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ATTEMPTS = 5

async function placeOf(db: Db | Tx, businessId: string, outletId: string) {
  const [r] = await db
    .select({ business: businesses.name, code: outlets.code, name: outlets.name })
    .from(outlets)
    .innerJoin(businesses, eq(businesses.id, outlets.businessId))
    .where(and(eq(outlets.id, outletId), eq(outlets.businessId, businessId)))
  return { business: r?.business ?? '', outlet: { code: r?.code ?? '', name: r?.name ?? '' } }
}

/** The receipt for an order event (by its payment/collection id), or the order receipt when null. */
export async function receiptFor(
  db: Db | Tx,
  businessId: string,
  orderId: string,
  sourceId: string | null,
): Promise<ReceiptDoc> {
  const loaded = (await loadOrderStates(db, businessId, [orderId])).get(orderId)
  if (!loaded) throw new DomainError('not_found', 'That order was not found.')
  const event = sourceId === null ? null : (loaded.state.events.find((e) => e.sourceId === sourceId) ?? null)
  if (sourceId !== null && !event) throw new DomainError('not_found', 'That payment or collection was not found.')
  return buildReceipt(loaded.state, await placeOf(db, businessId, loaded.state.outletId), event)
}

/** Store the receipts for these payments/collections (null = the order receipt of an unpaid sale). */
export async function issueReceipts(tx: Tx, businessId: string, orderId: string, sourceIds: (string | null)[]): Promise<void> {
  for (const sourceId of sourceIds) {
    const doc = await receiptFor(tx, businessId, orderId, sourceId)
    await tx
      .insert(receipts)
      .values({ businessId, orderId, kind: doc.kind, sourceId, doc, taxBreakdown: doc.taxes })
      .onConflictDoNothing()
  }
}

function addressFor(channel: 'sms' | 'email', raw: string): string {
  if (channel === 'sms') {
    const phone = normalizeKePhone(raw)
    if (!phone) throw new DomainError('invalid_input', 'Enter a Kenyan phone number for the SMS.')
    return phone
  }
  const email = raw.trim().toLowerCase()
  if (!EMAIL_RE.test(email) || email.length > 200) throw new DomainError('invalid_input', 'Enter a valid email address.')
  return email
}

async function queueReceipt(
  tx: Db | Tx,
  i: {
    businessId: string
    orderId: string
    sourceId: string | null
    channel: 'sms' | 'email'
    to: string
    requestedBy: string
    deviceId: string | null
    dedupeKey: string | null
  },
): Promise<string> {
  const to = addressFor(i.channel, i.to)
  const doc = await receiptFor(tx, i.businessId, i.orderId, i.sourceId)
  const text = receiptText(doc)
  const [row] = await tx
    .insert(messageOutbox)
    .values({
      businessId: i.businessId,
      orderId: i.orderId,
      channel: i.channel,
      to,
      subject: i.channel === 'email' ? `${doc.title} ${doc.orderNumber} · ${doc.business}` : null,
      body: i.channel === 'sms' ? receiptSms(doc) : text,
      html: i.channel === 'email' ? receiptEmailHtml(text) : null,
      requestedBy: i.requestedBy,
      deviceId: i.deviceId,
      dedupeKey: i.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: messageOutbox.id })
  return row?.id ?? ''
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** The email body: the same 48 columns as the paper receipt. */
export function receiptEmailHtml(text: string): string {
  return `<!doctype html><html><body style="margin:0;padding:16px;background:#f4f6f5"><pre style="margin:0 auto;max-width:30rem;padding:16px;background:#fff;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre></body></html>`
}

/** Till operation: queue a receipt by SMS or email (works offline; sent once synced). */
export async function applyReceiptSend(tx: Tx, c: OpContext, p: ReceiptSend): Promise<void> {
  await queueReceipt(tx, {
    businessId: c.device.businessId,
    orderId: p.orderId,
    sourceId: p.sourceId,
    channel: p.channel,
    to: p.to,
    requestedBy: c.actor.userId,
    deviceId: c.device.deviceId,
    dedupeKey: `op:${c.opId}`,
  })
}

/** Admin: send a receipt again. */
export async function resendReceipt(
  db: Db,
  ctx: TenantCtx,
  orderId: string,
  i: { sourceId: string | null; channel: 'sms' | 'email'; to: string },
): Promise<void> {
  assertCan(ctx, 'order.view')
  if (!isUuid(orderId) || (i.sourceId !== null && !isUuid(i.sourceId))) throw new DomainError('not_found')
  await db.transaction(async (tx) => {
    const loaded = (await loadOrderStates(tx, ctx.businessId, [orderId], { events: false })).get(orderId)
    if (!loaded) throw new DomainError('not_found')
    if (ctx.outletScope !== 'all' && !ctx.outletScope.includes(loaded.state.outletId)) throw new DomainError('forbidden')
    const id = await queueReceipt(tx, {
      businessId: ctx.businessId,
      orderId,
      sourceId: i.sourceId,
      channel: i.channel,
      to: i.to,
      requestedBy: ctx.userId,
      deviceId: null,
      dedupeKey: null,
    })
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'receipt.resend',
      entityType: 'order',
      entityId: orderId,
      data: { number: loaded.state.number, channel: i.channel, messageId: id },
    })
  })
}

/** Queue any message (digests). Idempotent by `dedupeKey`. */
export async function queueMessage(
  db: Db | Tx,
  m: { businessId: string | null; channel: 'sms' | 'email'; to: string; subject: string | null; body: string; html: string | null; dedupeKey: string },
): Promise<boolean> {
  const rows = await db.insert(messageOutbox).values(m).onConflictDoNothing().returning({ id: messageOutbox.id })
  return rows.length > 0
}

// ------------------------------------------------------------------- delivery

export type DeliveryResult = { sent: number; failed: number; waiting: number }

function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, 6 * 60 * 60 * 1000)
}

/**
 * Send what is due. Rows are claimed first (pushed 5 minutes into the future, skipping rows
 * another worker holds), so two workers never send the same message.
 */
export async function deliverDue(db: Db, senders: Senders = envSenders(), now = new Date(), limit = 25): Promise<DeliveryResult> {
  const claimed = await db.execute<{ id: string }>(sql`
    update ${messageOutbox} set next_attempt_at = ${new Date(now.getTime() + 5 * 60_000)}
    where id in (
      select id from ${messageOutbox}
      where status = 'queued' and next_attempt_at <= ${now}
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id`)
  const ids = claimed.rows.map((r) => r.id)
  if (ids.length === 0) return { sent: 0, failed: 0, waiting: 0 }
  const rows = await db.select().from(messageOutbox).where(inArray(messageOutbox.id, ids))
  const out = { sent: 0, failed: 0, waiting: 0 }
  for (const m of rows) {
    const sender = m.channel === 'sms' ? senders.sms : senders.email
    if (!sender) {
      await db
        .update(messageOutbox)
        .set({
          lastError: m.channel === 'sms' ? 'SMS is not set up on the server.' : 'Email is not set up on the server.',
          nextAttemptAt: new Date(now.getTime() + 15 * 60_000),
        })
        .where(eq(messageOutbox.id, m.id))
      out.waiting += 1
      continue
    }
    try {
      const r =
        m.channel === 'sms'
          ? await (sender as NonNullable<Senders['sms']>).send(m.to, m.body)
          : await (sender as NonNullable<Senders['email']>).send({ to: m.to, subject: m.subject ?? '', text: m.body, html: m.html })
      await db
        .update(messageOutbox)
        .set({
          status: 'sent',
          sentAt: now,
          attempts: m.attempts + 1,
          providerId: r.providerId,
          lastError: null,
          segments: m.channel === 'sms' ? smsSegments(m.body) : null,
        })
        .where(eq(messageOutbox.id, m.id))
      out.sent += 1
    } catch (e) {
      const attempts = m.attempts + 1
      const permanent = e instanceof ProviderError && e.permanent
      const giveUp = permanent || attempts >= MAX_ATTEMPTS
      await db
        .update(messageOutbox)
        .set({
          attempts,
          lastError: e instanceof Error ? e.message.slice(0, 300) : 'Unknown error',
          ...(giveUp ? { status: 'failed' as const } : { nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)) }),
        })
        .where(eq(messageOutbox.id, m.id))
      if (giveUp) out.failed += 1
      else out.waiting += 1
    }
  }
  return out
}

export type MessageRow = {
  id: string
  channel: 'sms' | 'email'
  to: string
  status: 'queued' | 'sent' | 'failed'
  lastError: string | null
  createdAt: Date
  sentAt: Date | null
}

/** The messages sent (or waiting) for an order, newest first. */
export async function messagesForOrder(db: Db, ctx: TenantCtx, orderId: string): Promise<MessageRow[]> {
  assertCan(ctx, 'order.view')
  if (!isUuid(orderId)) return []
  return db
    .select({
      id: messageOutbox.id,
      channel: messageOutbox.channel,
      to: messageOutbox.to,
      status: messageOutbox.status,
      lastError: messageOutbox.lastError,
      createdAt: messageOutbox.createdAt,
      sentAt: messageOutbox.sentAt,
    })
    .from(messageOutbox)
    .where(and(eq(messageOutbox.businessId, ctx.businessId), eq(messageOutbox.orderId, orderId)))
    .orderBy(sql`${messageOutbox.createdAt} desc`)
}

/** Whether the server can send SMS and email at all (credentials set). */
export function messagingConfigured(): { sms: boolean; email: boolean } {
  const s = envSenders()
  return { sms: s.sms !== null, email: s.email !== null }
}

/** SMS sent by the business since a date: messages and billed parts (for the platform's billing). */
export async function smsUsage(db: Db, ctx: TenantCtx, since: Date): Promise<{ messages: number; segments: number }> {
  assertCan(ctx, 'business.settings')
  const [r] = await db
    .select({
      messages: sql<number>`count(*)::int`,
      segments: sql<number>`coalesce(sum(${messageOutbox.segments}), 0)::int`,
    })
    .from(messageOutbox)
    .where(
      and(
        eq(messageOutbox.businessId, ctx.businessId),
        eq(messageOutbox.channel, 'sms'),
        eq(messageOutbox.status, 'sent'),
        gte(messageOutbox.sentAt, since),
      ),
    )
  return r ?? { messages: 0, segments: 0 }
}

export type { ReceiptKind }
