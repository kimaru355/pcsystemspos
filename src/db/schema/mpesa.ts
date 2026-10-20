import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  boolean,
  integer,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { devices } from './devices'
import { orders, payments } from './orders'
import { businesses, outlets } from './tenancy'

export const mpesaEnvironment = pgEnum('mpesa_environment', ['sandbox', 'production'])
export const mpesaShortcodeType = pgEnum('mpesa_shortcode_type', ['paybill', 'till'])
export const stkStatus = pgEnum('stk_status', ['pending', 'success', 'failed', 'timeout'])
export const mpesaMatch = pgEnum('mpesa_match', ['matched', 'unmatched'])

/**
 * Daraja settings: the business default (outlet null) and optional per-outlet overrides.
 * Secrets are AES-256-GCM encrypted (src/server/secrets.ts).
 */
export const mpesaConfigs = pgTable(
  'mpesa_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    outletId: uuid('outlet_id').references(() => outlets.id),
    environment: mpesaEnvironment('environment').notNull().default('sandbox'),
    shortcodeType: mpesaShortcodeType('shortcode_type').notNull(),
    /** Business/store number: the STK password's shortcode. */
    shortcode: text('shortcode').notNull(),
    /** Where the money goes: the paybill, or the till number for buy goods. */
    partyB: text('party_b').notNull(),
    consumerKeyEnc: text('consumer_key_enc').notNull(),
    consumerSecretEnc: text('consumer_secret_enc').notNull(),
    passkeyEnc: text('passkey_enc').notNull(),
    /** Random; part of every callback URL so callbacks can be told apart and trusted. */
    callbackToken: text('callback_token').notNull().unique(),
    active: boolean('active').notNull().default(true),
    c2bRegisteredAt: timestamp('c2b_registered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('mpesa_configs_business_outlet_unique').on(t.businessId, t.outletId).nullsNotDistinct(),
    check('mpesa_configs_codes', sql`${t.shortcode} ~ '^[0-9]{5,10}$' and ${t.partyB} ~ '^[0-9]{5,10}$'`),
  ],
)

/** STK pushes sent from a till. */
export const mpesaRequests = pgTable(
  'mpesa_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    configId: uuid('config_id')
      .notNull()
      .references(() => mpesaConfigs.id),
    /** E.164 */
    phone: text('phone').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    merchantRequestId: text('merchant_request_id'),
    checkoutRequestId: text('checkout_request_id').unique(),
    status: stkStatus('status').notNull().default('pending'),
    resultCode: text('result_code'),
    resultDesc: text('result_desc'),
    receiptNumber: text('receipt_number'),
    paymentId: uuid('payment_id').references(() => payments.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id').references(() => devices.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check('mpesa_requests_amount_positive', sql`${t.amountCents} > 0`),
    index('mpesa_requests_pending_idx').on(t.createdAt).where(sql`${t.status} = 'pending'`),
  ],
)

/** Paybill/till payments confirmed by Safaricom (C2B), matched to an order or waiting. */
export const mpesaTransactions = pgTable(
  'mpesa_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    configId: uuid('config_id')
      .notNull()
      .references(() => mpesaConfigs.id),
    /** The M-Pesa receipt number. */
    transId: text('trans_id').notNull(),
    transType: text('trans_type'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    msisdn: text('msisdn'),
    payerName: text('payer_name'),
    billRef: text('bill_ref'),
    transTime: timestamp('trans_time', { withTimezone: true }).notNull(),
    raw: jsonb('raw').notNull(),
    status: mpesaMatch('status').notNull(),
    orderId: uuid('order_id').references(() => orders.id),
    paymentId: uuid('payment_id').references(() => payments.id),
    matchedBy: uuid('matched_by').references(() => users.id),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('mpesa_transactions_trans_id_unique').on(t.businessId, t.transId),
    check('mpesa_transactions_amount_positive', sql`${t.amountCents} > 0`),
    index('mpesa_transactions_unmatched_idx').on(t.businessId, t.transTime).where(sql`${t.status} = 'unmatched'`),
  ],
)

export const receiptKind = pgEnum('receipt_kind', ['order', 'collection'])
export const messageChannel = pgEnum('message_channel', ['sms', 'email'])
export const messageStatus = pgEnum('message_status', ['queued', 'sent', 'failed'])

/** Every receipt the server issued, with its tax breakdown (ready for KRA eTIMS later). */
export const receipts = pgTable(
  'receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    kind: receiptKind('kind').notNull(),
    /** The payment or collection the receipt is for; null for an order receipt of an unpaid sale. */
    sourceId: uuid('source_id'),
    doc: jsonb('doc').notNull(),
    taxBreakdown: jsonb('tax_breakdown').notNull(),
    /** Empty until KRA eTIMS integration. */
    kraInvoiceNumber: text('kra_invoice_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('receipts_order_kind_source_unique').on(t.orderId, t.kind, t.sourceId).nullsNotDistinct(),
    index('receipts_business_created_idx').on(t.businessId, t.createdAt),
  ],
)

/** SMS and email waiting to go out, and what happened to them. */
export const messageOutbox = pgTable(
  'message_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').references(() => businesses.id),
    orderId: uuid('order_id').references(() => orders.id),
    channel: messageChannel('channel').notNull(),
    /** E.164 phone or email address. */
    to: text('to').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    html: text('html'),
    status: messageStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    providerId: text('provider_id'),
    /** SMS only: billed message parts. */
    segments: integer('segments'),
    /** Makes a message idempotent (a till op id, or `digest:<user>:<day>`). */
    dedupeKey: text('dedupe_key').unique(),
    requestedBy: uuid('requested_by').references(() => users.id),
    deviceId: uuid('device_id').references(() => devices.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    index('message_outbox_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'queued'`),
    index('message_outbox_business_sent_idx').on(t.businessId, t.channel, t.sentAt),
  ],
)
