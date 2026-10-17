import type { Cents, Milli } from '@/domain/money'
import type { OrderLine } from '@/domain/orders'

export type TillItem = {
  id: string
  /** Short code a regular types or reads off the shelf. */
  code: string
  name: string
  unit: string
  priceCents: Cents
  vatRateBp: number
  availableMilli: Milli
  lowStockMilli: Milli
}

export type TillEvent = {
  status: string
  tone: 'paid' | 'owed' | 'credit' | 'neutral'
  detail: string
  by: string
  at: string
  balance?: string
}

export type TillOrder = {
  number: string | null
  customer: { name: string; phone: string } | null
  lines: OrderLine[]
  paidCents: Cents
  events: TillEvent[]
}
