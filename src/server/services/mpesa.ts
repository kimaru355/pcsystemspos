import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import { mpesaConfigs, mpesaRequests, mpesaTransactions, orders, outlets, users } from '@/db/schema'
import { getEnv } from '@/env'
import { isUuid } from '@/domain/ids'
import type { Cents } from '@/domain/money'
import { can } from '@/domain/permissions'
import { normalizeKePhone } from '@/domain/phone'
import { DomainError } from '@/server/errors'
import {
  accountReference,
  Daraja,
  DarajaError,
  normalizeReference,
  parseC2BConfirmation,
  parseStkCallback,
  type DarajaCredentials,
  type MpesaGateway,
} from '@/server/mpesa/daraja'
import { decryptSecret, encryptSecret } from '@/server/secrets'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'
import type { DeviceAuth } from './devices'
import { recordServerPayment } from './orders'
import { membersById } from './till-auth'

/*
 * M-Pesa: settings with encrypted credentials, STK push from the till and its callback, paybill
 * and till (C2B) confirmations matched to orders by account reference, and the unmatched list.
 * Every payment goes through recordServerPayment, idempotent by the M-Pesa receipt number.
 */

export type MpesaDeps = { gateway: (c: DarajaCredentials) => MpesaGateway }
export const defaultMpesaDeps: MpesaDeps = { gateway: (c) => new Daraja(c) }

/** STK pushes with no answer after this long are shown as timed out (a late success still counts). */
export const STK_TIMEOUT_MS = 2 * 60 * 1000

type ConfigRow = typeof mpesaConfigs.$inferSelect

export type MpesaConfigView = {
  id: string
  outletId: string | null
  environment: 'sandbox' | 'production'
  shortcodeType: 'paybill' | 'till'
  shortcode: string
  partyB: string
  active: boolean
  c2bRegisteredAt: Date | null
  confirmationUrl: string | null
}

function appUrl(): string | null {
  return getEnv().APP_URL?.replace(/\/+$/, '') ?? null
}

function callbackUrls(token: string) {
  const base = appUrl()
  if (!base) return null
  return {
    stk: `${base}/api/mpesa/stk/${token}`,
    confirmation: `${base}/api/mpesa/c2b/${token}/confirmation`,
    validation: `${base}/api/mpesa/c2b/${token}/validation`,
  }
}

function view(r: ConfigRow): MpesaConfigView {
  return {
    id: r.id,
    outletId: r.outletId,
    environment: r.environment,
    shortcodeType: r.shortcodeType,
    shortcode: r.shortcode,
    partyB: r.partyB,
    active: r.active,
    c2bRegisteredAt: r.c2bRegisteredAt,
    confirmationUrl: callbackUrls(r.callbackToken)?.confirmation ?? null,
  }
}

function credentials(r: ConfigRow): DarajaCredentials {
  return {
    environment: r.environment,
    shortcodeType: r.shortcodeType,
    shortcode: r.shortcode,
    partyB: r.partyB,
    consumerKey: decryptSecret(r.consumerKeyEnc),
    consumerSecret: decryptSecret(r.consumerSecretEnc),
    passkey: decryptSecret(r.passkeyEnc),
  }
}

// ------------------------------------------------------------------ settings

export async function getMpesaSettings(
  db: Db,
  ctx: TenantCtx,
): Promise<{ configs: MpesaConfigView[]; appUrlSet: boolean; secretsKeySet: boolean }> {
  assertCan(ctx, 'business.settings')
  const rows = await db.select().from(mpesaConfigs).where(eq(mpesaConfigs.businessId, ctx.businessId))
  const env = getEnv()
  return { configs: rows.map(view), appUrlSet: !!env.APP_URL, secretsKeySet: !!env.SECRETS_KEY }
}

const CODE_RE = /^[0-9]{5,10}$/

export type MpesaConfigInput = {
  outletId: string | null
  environment: 'sandbox' | 'production'
  shortcodeType: 'paybill' | 'till'
  shortcode: string
  partyB: string
  /** Blank keeps the stored value (required when creating). */
  consumerKey: string
  consumerSecret: string
  passkey: string
  active: boolean
}

/** Create or update the business default (outletId null) or an outlet's override. */
export async function saveMpesaConfig(db: Db, ctx: TenantCtx, i: MpesaConfigInput): Promise<MpesaConfigView> {
  assertCan(ctx, 'business.settings')
  if (i.environment !== 'sandbox' && i.environment !== 'production') {
    throw new DomainError('invalid_input', 'Choose sandbox or production.')
  }
  if (i.shortcodeType !== 'paybill' && i.shortcodeType !== 'till') {
    throw new DomainError('invalid_input', 'Choose paybill or till.')
  }
  const shortcode = i.shortcode.trim()
  const partyB = (i.partyB.trim() || shortcode).trim()
  if (!CODE_RE.test(shortcode)) throw new DomainError('invalid_input', 'The shortcode is 5 to 10 digits.')
  if (!CODE_RE.test(partyB)) throw new DomainError('invalid_input', 'The paybill or till number is 5 to 10 digits.')
  const secrets = { consumerKey: i.consumerKey.trim(), consumerSecret: i.consumerSecret.trim(), passkey: i.passkey.trim() }
  return db.transaction(async (tx) => {
    if (i.outletId !== null) {
      if (!isUuid(i.outletId)) throw new DomainError('not_found')
      const [o] = await tx
        .select({ id: outlets.id })
        .from(outlets)
        .where(and(eq(outlets.id, i.outletId), eq(outlets.businessId, ctx.businessId)))
      if (!o) throw new DomainError('not_found')
    }
    const [existing] = await tx
      .select()
      .from(mpesaConfigs)
      .where(
        and(
          eq(mpesaConfigs.businessId, ctx.businessId),
          i.outletId === null ? isNull(mpesaConfigs.outletId) : eq(mpesaConfigs.outletId, i.outletId),
        ),
      )
      .for('update')
    if (!existing && (!secrets.consumerKey || !secrets.consumerSecret || !secrets.passkey)) {
      throw new DomainError('invalid_input', 'Enter the consumer key, consumer secret and passkey from the Daraja portal.')
    }
    const values = {
      environment: i.environment,
      shortcodeType: i.shortcodeType,
      shortcode,
      partyB,
      active: i.active,
      updatedAt: new Date(),
      ...(secrets.consumerKey ? { consumerKeyEnc: encryptSecret(secrets.consumerKey) } : {}),
      ...(secrets.consumerSecret ? { consumerSecretEnc: encryptSecret(secrets.consumerSecret) } : {}),
      ...(secrets.passkey ? { passkeyEnc: encryptSecret(secrets.passkey) } : {}),
    }
    let row: ConfigRow
    if (existing) {
      // A changed shortcode needs its confirmation URL registered again.
      const moved = existing.partyB !== partyB || existing.environment !== i.environment
      ;[row] = await tx
        .update(mpesaConfigs)
        .set({ ...values, ...(moved ? { c2bRegisteredAt: null } : {}) })
        .where(eq(mpesaConfigs.id, existing.id))
        .returning()
    } else {
      ;[row] = await tx
        .insert(mpesaConfigs)
        .values({
          ...values,
          businessId: ctx.businessId,
          outletId: i.outletId,
          consumerKeyEnc: encryptSecret(secrets.consumerKey),
          consumerSecretEnc: encryptSecret(secrets.consumerSecret),
          passkeyEnc: encryptSecret(secrets.passkey),
          callbackToken: randomBytes(24).toString('base64url'),
        })
        .returning()
    }
    // Never record the credentials themselves.
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'mpesa.config',
      entityType: 'mpesa_config',
      entityId: row.id,
      data: {
        outletId: row.outletId,
        environment: row.environment,
        shortcodeType: row.shortcodeType,
        shortcode: row.shortcode,
        partyB: row.partyB,
        active: row.active,
        credentialsChanged: Object.values(secrets).some(Boolean),
      },
    })
    return view(row)
  })
}

/** Register this config's confirmation and validation URLs with Safaricom (paybill/till payments). */
export async function registerC2BUrls(db: Db, ctx: TenantCtx, configId: string, deps = defaultMpesaDeps): Promise<void> {
  assertCan(ctx, 'business.settings')
  if (!isUuid(configId)) throw new DomainError('not_found')
  const [row] = await db
    .select()
    .from(mpesaConfigs)
    .where(and(eq(mpesaConfigs.id, configId), eq(mpesaConfigs.businessId, ctx.businessId)))
  if (!row) throw new DomainError('not_found')
  const urls = callbackUrls(row.callbackToken)
  if (!urls) throw new DomainError('conflict', 'The server has no APP_URL set, so Safaricom has nowhere to send payments.')
  try {
    await deps.gateway(credentials(row)).registerC2B({ confirmationUrl: urls.confirmation, validationUrl: urls.validation })
  } catch (e) {
    if (e instanceof DarajaError) throw new DomainError('conflict', e.message)
    throw e
  }
  await db.update(mpesaConfigs).set({ c2bRegisteredAt: new Date() }).where(eq(mpesaConfigs.id, row.id))
  await recordAudit(db, {
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    action: 'mpesa.register_c2b',
    entityType: 'mpesa_config',
    entityId: row.id,
    data: { partyB: row.partyB, environment: row.environment },
  })
}

/** The outlet's own active settings, else the business default's. */
async function configFor(db: Db | Tx, businessId: string, outletId: string): Promise<ConfigRow | null> {
  const rows = await db
    .select()
    .from(mpesaConfigs)
    .where(
      and(
        eq(mpesaConfigs.businessId, businessId),
        eq(mpesaConfigs.active, true),
        sql`(${mpesaConfigs.outletId} = ${outletId} or ${mpesaConfigs.outletId} is null)`,
      ),
    )
  return rows.find((r) => r.outletId === outletId) ?? rows.find((r) => r.outletId === null) ?? null
}

/** Whether a till's outlet can take M-Pesa (sent to the till in its settings). */
export async function mpesaEnabledFor(db: Db | Tx, device: DeviceAuth): Promise<boolean> {
  return (await configFor(db, device.businessId, device.outletId)) !== null
}

// ---------------------------------------------------------------------- STK

export type StkView = {
  id: string
  status: 'pending' | 'success' | 'failed' | 'timeout'
  amountCents: Cents
  phone: string
  message: string | null
  receipt: string | null
}

function stkView(r: typeof mpesaRequests.$inferSelect): StkView {
  return {
    id: r.id,
    status: r.status,
    amountCents: r.amountCents,
    phone: r.phone,
    message: r.resultDesc,
    receipt: r.receiptNumber,
  }
}

/** Send an STK push for an order of the till's outlet. The order must already be synced. */
export async function startStkPush(
  db: Db,
  device: DeviceAuth,
  i: { orderId: string; phone: string; amountCents: number; actorId: string },
  deps = defaultMpesaDeps,
): Promise<StkView> {
  if (!isUuid(i.orderId) || !isUuid(i.actorId)) throw new DomainError('not_found')
  const actor = (await membersById(db, device.businessId, [i.actorId])).get(i.actorId)
  if (!actor || !actor.active) throw new DomainError('forbidden', 'That person cannot take payments here.')
  const phone = normalizeKePhone(String(i.phone ?? ''))
  if (!phone) throw new DomainError('invalid_input', 'Enter the M-Pesa phone number, for example 0712 345 678.')
  if (!Number.isSafeInteger(i.amountCents) || i.amountCents < 100 || i.amountCents % 100 !== 0) {
    throw new DomainError('invalid_input', 'M-Pesa takes whole shillings, at least KES 1.')
  }
  const [order] = await db
    .select({ id: orders.id, number: orders.number, outletId: orders.outletId })
    .from(orders)
    .where(and(eq(orders.id, i.orderId), eq(orders.businessId, device.businessId)))
  if (!order) throw new DomainError('not_found', 'That order has not reached the server yet. Wait for the till to sync.')
  if (order.outletId !== device.outletId) throw new DomainError('conflict', 'That order belongs to another outlet.')
  const config = await configFor(db, device.businessId, device.outletId)
  if (!config) throw new DomainError('conflict', 'M-Pesa is not set up for this outlet.')
  const urls = callbackUrls(config.callbackToken)
  if (!urls) throw new DomainError('conflict', 'The server has no APP_URL set, so M-Pesa cannot answer.')
  let sent
  try {
    sent = await deps.gateway(credentials(config)).stkPush({
      phone,
      amountKes: i.amountCents / 100,
      accountReference: accountReference(order.number),
      description: 'Payment',
      callbackUrl: urls.stk,
    })
  } catch (e) {
    if (e instanceof DarajaError) throw new DomainError('conflict', e.message)
    throw e
  }
  const [row] = await db
    .insert(mpesaRequests)
    .values({
      businessId: device.businessId,
      orderId: order.id,
      configId: config.id,
      phone,
      amountCents: i.amountCents,
      merchantRequestId: sent.merchantRequestId,
      checkoutRequestId: sent.checkoutRequestId,
      requestedBy: actor.userId,
      deviceId: device.deviceId,
    })
    .returning()
  return { ...stkView(row), message: sent.customerMessage || null }
}

/** The state of a push; a pending one older than the timeout reads as timed out. */
export async function stkStatus(db: Db, device: DeviceAuth, requestId: string, now = new Date()): Promise<StkView> {
  if (!isUuid(requestId)) throw new DomainError('not_found')
  const [row] = await db
    .select()
    .from(mpesaRequests)
    .where(and(eq(mpesaRequests.id, requestId), eq(mpesaRequests.businessId, device.businessId)))
  if (!row) throw new DomainError('not_found')
  if (row.status === 'pending' && now.getTime() - row.createdAt.getTime() > STK_TIMEOUT_MS) {
    const [updated] = await db
      .update(mpesaRequests)
      .set({ status: 'timeout', resultDesc: 'No answer from the phone in time.' })
      .where(and(eq(mpesaRequests.id, row.id), eq(mpesaRequests.status, 'pending')))
      .returning()
    return stkView(updated ?? row)
  }
  return stkView(row)
}

/** Cron: mark pushes with no answer as timed out. */
export async function timeoutStalePushes(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(mpesaRequests)
    .set({ status: 'timeout', resultDesc: 'No answer from the phone in time.' })
    .where(and(eq(mpesaRequests.status, 'pending'), lt(mpesaRequests.createdAt, new Date(now.getTime() - STK_TIMEOUT_MS))))
    .returning({ id: mpesaRequests.id })
  return rows.length
}

async function configByToken(db: Db | Tx, token: string): Promise<ConfigRow | null> {
  if (!token || token.length > 100) return null
  const [row] = await db.select().from(mpesaConfigs).where(eq(mpesaConfigs.callbackToken, token))
  return row ?? null
}

/** Safaricom's STK result. Idempotent: a request already settled as a success is left alone. */
export async function handleStkCallback(db: Db, token: string, body: unknown): Promise<'ok' | 'unknown'> {
  const config = await configByToken(db, token)
  const cb = parseStkCallback(body)
  if (!config || !cb) return 'unknown'
  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(mpesaRequests)
      .where(and(eq(mpesaRequests.checkoutRequestId, cb.checkoutRequestId), eq(mpesaRequests.configId, config.id)))
      .for('update')
    if (!req) return 'unknown'
    if (req.status === 'success') return 'ok'
    const now = new Date()
    if (cb.resultCode !== 0 || !cb.receipt) {
      await tx
        .update(mpesaRequests)
        .set({ status: 'failed', resultCode: String(cb.resultCode), resultDesc: cb.resultDesc, completedAt: now })
        .where(eq(mpesaRequests.id, req.id))
      return 'ok'
    }
    const amountCents = Math.round((cb.amountKes ?? req.amountCents / 100) * 100)
    const { paymentId } = await recordServerPayment(tx, req.businessId, req.orderId, {
      amountCents,
      reference: cb.receipt,
      actorUserId: req.requestedBy,
      deviceId: req.deviceId,
      occurredAt: now,
    })
    await tx
      .update(mpesaRequests)
      .set({
        status: 'success',
        resultCode: '0',
        resultDesc: cb.resultDesc,
        receiptNumber: cb.receipt,
        paymentId,
        completedAt: now,
      })
      .where(eq(mpesaRequests.id, req.id))
    return 'ok'
  })
}

// ---------------------------------------------------------------------- C2B

/** Find an open-or-closed order of the business whose number matches what the customer typed. */
async function orderByReference(tx: Tx, businessId: string, ref: string) {
  const norm = normalizeReference(ref)
  if (norm.length < 6) return null
  const [o] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.businessId, businessId),
        sql`regexp_replace(upper(${orders.number}), '[^A-Z0-9]', '', 'g') = ${norm}`,
      ),
    )
    .limit(1)
  return o ?? null
}

/** A paybill/till payment confirmed by Safaricom: stored once, matched by account reference when possible. */
export async function handleC2BConfirmation(db: Db, token: string, body: unknown): Promise<'ok' | 'unknown'> {
  const config = await configByToken(db, token)
  const c = parseC2BConfirmation(body)
  if (!config || !c) return 'unknown'
  return db.transaction(async (tx): Promise<'ok' | 'unknown'> => {
    const [row] = await tx
      .insert(mpesaTransactions)
      .values({
        businessId: config.businessId,
        configId: config.id,
        transId: c.transId,
        transType: c.transType,
        amountCents: Math.round(c.amountKes * 100),
        msisdn: c.msisdn,
        payerName: c.payerName,
        billRef: c.billRef,
        transTime: c.transTime,
        raw: body as object,
        status: 'unmatched',
      })
      .onConflictDoNothing()
      .returning()
    if (!row) return 'ok' // Safaricom sent it again
    const order = config.shortcodeType === 'paybill' && c.billRef ? await orderByReference(tx, config.businessId, c.billRef) : null
    if (order) {
      const { paymentId } = await recordServerPayment(tx, config.businessId, order.id, {
        amountCents: row.amountCents,
        reference: row.transId,
        actorUserId: null,
        deviceId: null,
        occurredAt: c.transTime,
      })
      await tx
        .update(mpesaTransactions)
        .set({ status: 'matched', orderId: order.id, paymentId, matchedAt: new Date() })
        .where(eq(mpesaTransactions.id, row.id))
    }
    return 'ok'
  })
}

// ------------------------------------------------------------------ unmatched

export type UnmatchedPayment = {
  id: string
  transId: string
  amountCents: Cents
  payerName: string | null
  msisdn: string | null
  billRef: string | null
  transTime: Date
}

async function unmatched(db: Db, businessId: string, limit: number): Promise<UnmatchedPayment[]> {
  const rows = await db
    .select()
    .from(mpesaTransactions)
    .where(and(eq(mpesaTransactions.businessId, businessId), eq(mpesaTransactions.status, 'unmatched')))
    .orderBy(desc(mpesaTransactions.transTime))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    transId: r.transId,
    amountCents: r.amountCents,
    payerName: r.payerName,
    // Shown to staff to recognise the payer: the last digits only.
    msisdn: r.msisdn ? `…${r.msisdn.slice(-4)}` : null,
    billRef: r.billRef,
    transTime: r.transTime,
  }))
}

export async function listUnmatchedForAdmin(db: Db, ctx: TenantCtx, limit = 100) {
  assertCan(ctx, 'payment.match')
  return unmatched(db, ctx.businessId, limit)
}

export type MatchedPayment = UnmatchedPayment & { orderNumber: string; matchedByName: string | null; matchedAt: Date | null }

/** M-Pesa payments matched to orders in the last 7 days (by a person or automatically), newest first. */
export async function listRecentlyMatched(db: Db, ctx: TenantCtx, limit = 50): Promise<MatchedPayment[]> {
  assertCan(ctx, 'payment.match')
  const rows = await db
    .select({ t: mpesaTransactions, orderNumber: orders.number, matchedByName: users.name })
    .from(mpesaTransactions)
    .innerJoin(orders, eq(orders.id, mpesaTransactions.orderId))
    .leftJoin(users, eq(users.id, mpesaTransactions.matchedBy))
    .where(
      and(
        eq(mpesaTransactions.businessId, ctx.businessId),
        eq(mpesaTransactions.status, 'matched'),
        sql`${mpesaTransactions.matchedAt} > now() - interval '7 days'`,
      ),
    )
    .orderBy(desc(mpesaTransactions.matchedAt))
    .limit(limit)
  return rows.map(({ t, orderNumber, matchedByName }) => ({
    id: t.id,
    transId: t.transId,
    amountCents: t.amountCents,
    payerName: t.payerName,
    msisdn: t.msisdn ? `…${t.msisdn.slice(-4)}` : null,
    billRef: t.billRef,
    transTime: t.transTime,
    orderNumber,
    matchedByName,
    matchedAt: t.matchedAt,
  }))
}

export async function listUnmatchedForTill(db: Db, device: DeviceAuth) {
  return unmatched(db, device.businessId, 50)
}

/** Attach an unmatched payment to an order (by id or number). */
async function attach(
  db: Db,
  who: { businessId: string; userId: string; deviceId: string | null; outletScope: 'all' | string[] },
  transactionId: string,
  order: { id?: string; number?: string },
): Promise<{ orderNumber: string }> {
  if (!isUuid(transactionId)) throw new DomainError('not_found', 'That payment was not found.')
  return db.transaction(async (tx) => {
    const [t] = await tx
      .select()
      .from(mpesaTransactions)
      .where(and(eq(mpesaTransactions.id, transactionId), eq(mpesaTransactions.businessId, who.businessId)))
      .for('update')
    if (!t) throw new DomainError('not_found', 'That payment was not found.')
    if (t.status === 'matched') throw new DomainError('conflict', 'That payment is already attached to an order.')
    const [o] = order.id
      ? await tx
          .select({ id: orders.id, number: orders.number, outletId: orders.outletId })
          .from(orders)
          .where(and(eq(orders.id, isUuid(order.id) ? order.id : '00000000-0000-0000-0000-000000000000'), eq(orders.businessId, who.businessId)))
      : await tx
          .select({ id: orders.id, number: orders.number, outletId: orders.outletId })
          .from(orders)
          .where(
            and(
              eq(orders.businessId, who.businessId),
              sql`regexp_replace(upper(${orders.number}), '[^A-Z0-9]', '', 'g') = ${normalizeReference(order.number ?? '')}`,
            ),
          )
    if (!o) throw new DomainError('not_found', 'No order has that number.')
    if (who.outletScope !== 'all' && !who.outletScope.includes(o.outletId)) {
      throw new DomainError('forbidden', 'That order belongs to an outlet you cannot see.')
    }
    const { paymentId } = await recordServerPayment(tx, who.businessId, o.id, {
      amountCents: t.amountCents,
      reference: t.transId,
      actorUserId: who.userId,
      deviceId: who.deviceId,
      occurredAt: new Date(),
    })
    await tx
      .update(mpesaTransactions)
      .set({ status: 'matched', orderId: o.id, paymentId, matchedBy: who.userId, matchedAt: new Date() })
      .where(eq(mpesaTransactions.id, t.id))
    await recordAudit(tx, {
      businessId: who.businessId,
      actorUserId: who.userId,
      action: 'mpesa.attach',
      entityType: 'order',
      entityId: o.id,
      deviceId: who.deviceId,
      data: { number: o.number, transId: t.transId, amountCents: t.amountCents },
    })
    return { orderNumber: o.number }
  })
}

export async function attachForAdmin(db: Db, ctx: TenantCtx, transactionId: string, orderNumber: string) {
  assertCan(ctx, 'payment.match')
  return attach(db, { businessId: ctx.businessId, userId: ctx.userId, deviceId: null, outletScope: ctx.outletScope }, transactionId, {
    number: orderNumber,
  })
}

export async function attachForTill(db: Db, device: DeviceAuth, i: { transactionId: string; orderId: string; actorId: string }) {
  if (!isUuid(i.actorId)) throw new DomainError('not_found')
  const actor = (await membersById(db, device.businessId, [i.actorId])).get(i.actorId)
  if (!actor || !actor.active || !can(actor.role, 'payment.match')) throw new DomainError('forbidden')
  return attach(db, { businessId: device.businessId, userId: actor.userId, deviceId: device.deviceId, outletScope: [device.outletId] }, i.transactionId, {
    id: i.orderId,
  })
}
