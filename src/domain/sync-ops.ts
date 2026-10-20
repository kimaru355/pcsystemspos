import { z } from 'zod'
import { ADJUST_REASONS, type AdjustReason } from './stock'

/*
 * The operations a till pushes to `/api/sync`, and the request/response shapes. Shared by the
 * till (which builds them) and the server (which parses everything it receives with these
 * schemas before touching the database).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const uuidSchema = z.string().regex(UUID_RE, 'Expected a uuid')
const int = z.number().int().refine(Number.isSafeInteger, 'Too large')
const positive = int.refine((n) => n > 0, 'Must be above 0')
const nonneg = int.refine((n) => n >= 0, 'Must be 0 or more')
const shortText = z.string().max(200)

export const MAX_OPS_PER_SYNC = 100

export const customerSchema = z.object({ name: z.string().max(100), phone: z.string().max(30) })

export const lineInputSchema = z.object({
  id: uuidSchema,
  itemId: uuidSchema,
  packId: uuidSchema.nullable(),
  qtyMilli: positive,
  unitPriceCents: nonneg,
  listPriceCents: nonneg,
  floorCents: nonneg,
  priceApproverId: uuidSchema.nullable(),
})

export const paymentInputSchema = z.object({
  id: uuidSchema,
  method: z.enum(['cash', 'mark_paid']),
  amountCents: positive,
  reason: shortText.nullable(),
  approverId: uuidSchema.nullable(),
})

export const collectionInputSchema = z.object({
  id: uuidSchema,
  lines: z.array(z.object({ lineId: uuidSchema, qtyMilli: positive })).max(200),
  creditApproverId: uuidSchema.nullable(),
})

export const saleCheckoutSchema = z.object({
  order: z.object({
    id: uuidSchema,
    number: z.string().max(20),
    seq: positive,
    customer: customerSchema.nullable(),
    lines: z.array(lineInputSchema).min(1).max(200),
  }),
  payments: z.array(paymentInputSchema).max(10),
  collection: collectionInputSchema.nullable(),
})

export const paymentAddSchema = z.object({
  orderId: uuidSchema,
  payment: paymentInputSchema,
  customer: customerSchema.nullable(),
})

export const collectionRecordSchema = z.object({
  orderId: uuidSchema,
  collection: collectionInputSchema,
  customer: customerSchema.nullable(),
})

export const stockAdjustSchema = z.object({
  movementId: uuidSchema,
  itemId: uuidSchema,
  deltaMilli: int.refine((n) => n !== 0, 'Must not be 0'),
  reason: z.enum(ADJUST_REASONS as readonly AdjustReason[] as [AdjustReason, ...AdjustReason[]]),
  note: shortText.nullable(),
})

export const receiptSendSchema = z.object({
  orderId: uuidSchema,
  /** The payment or collection the receipt is for; null = the order receipt as it stands. */
  sourceId: uuidSchema.nullable(),
  channel: z.enum(['sms', 'email']),
  to: z.string().min(1).max(200),
})

const envelope = {
  id: uuidSchema,
  actorId: uuidSchema,
  /** ISO time from the till's trusted clock. */
  occurredAt: z.iso.datetime({ offset: true }),
}

export const opSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('sale.checkout'), payload: saleCheckoutSchema }),
  z.object({ ...envelope, type: z.literal('payment.add'), payload: paymentAddSchema }),
  z.object({ ...envelope, type: z.literal('collection.record'), payload: collectionRecordSchema }),
  z.object({ ...envelope, type: z.literal('stock.adjust'), payload: stockAdjustSchema }),
  z.object({ ...envelope, type: z.literal('receipt.send'), payload: receiptSendSchema }),
])

export type Op = z.infer<typeof opSchema>
export type OpType = Op['type']
export type SaleCheckout = z.infer<typeof saleCheckoutSchema>
export type PaymentAdd = z.infer<typeof paymentAddSchema>
export type CollectionRecord = z.infer<typeof collectionRecordSchema>
export type StockAdjust = z.infer<typeof stockAdjustSchema>
export type ReceiptSend = z.infer<typeof receiptSendSchema>

export const SECTIONS = ['catalog', 'stock', 'staff', 'orders'] as const
export type Section = (typeof SECTIONS)[number]

export const syncRequestSchema = z.object({
  /** Ops are kept raw here so one malformed op is rejected on its own, not the whole batch. */
  ops: z.array(z.unknown()).max(MAX_OPS_PER_SYNC),
  hashes: z.partialRecord(z.enum(SECTIONS), z.string().max(100)),
  clock: z.object({ jumps: nonneg, lastJumpAt: z.iso.datetime({ offset: true }).nullable() }),
})

export type SyncRequest = z.infer<typeof syncRequestSchema>

export type OpResult = {
  id: string
  status: 'applied' | 'rejected'
  code?: string
  message?: string
}
