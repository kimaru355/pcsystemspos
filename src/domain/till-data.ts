import type { ConnectionMode } from './connection-modes'
import type { Cents, Milli } from './money'
import type { OrderState, SellableUnit } from './order-state'
import type { Role } from './permissions'
import type { PinVerifier } from './pin'
import type { OpResult, Section } from './sync-ops'
import type { TaxCategory } from './tax'

/* What the server sends a till in a sync: the sections it pulls and their shapes. */

export type CatalogItem = {
  id: string
  name: string
  sku: string | null
  baseUnit: string
  fractional: boolean
  priceCents: Cents
  floorCents: Cents
  taxCategory: TaxCategory
  lowStockMilli: Milli | null
  categoryId: string | null
  groupId: string | null
  attributes: Record<string, string>
}

export type CatalogPack = {
  id: string
  itemId: string
  name: string
  baseQtyMilli: Milli
  priceCents: Cents
  floorCents: Cents
}

export type CatalogBarcode = { barcode: string; itemId: string; packId: string | null }
export type CatalogCategory = { id: string; parentId: string | null; name: string; sortOrder: number }
export type CatalogGroup = { id: string; name: string; attributeKeys: string[] }

export type CatalogSection = {
  items: CatalogItem[]
  packs: CatalogPack[]
  barcodes: CatalogBarcode[]
  categories: CatalogCategory[]
  groups: CatalogGroup[]
}

export type StockSection = { onHand: { itemId: string; onHandMilli: Milli }[] }

export type TillStaff = {
  membershipId: string
  userId: string
  name: string
  role: Role
  pin: PinVerifier | null
}

export type StaffSection = { staff: TillStaff[] }

export type OrdersSection = { orders: OrderState[] }

export type SectionData = {
  catalog: CatalogSection
  stock: StockSection
  staff: StaffSection
  orders: OrdersSection
}

export type TillSettings = {
  businessName: string
  outlet: { id: string; code: string; name: string; active: boolean }
  device: { id: string; code: string; name: string }
  mode: ConnectionMode
  /** Highest order sequence the server has seen from this device. */
  lastOrderSeq: number
}

export type SyncResponse = {
  results: OpResult[]
  /** ISO */
  serverTime: string
  settings: TillSettings
  sections: { [S in Section]?: { hash: string; data: SectionData[S] } }
}

/** Error body of the till API (`/api/sync`, `/api/till/*`). */
export type TillApiError = { error: string; message: string }

/** The sellable unit for an item's base unit (pack null) or one of its packs. */
export function sellableUnit(item: CatalogItem, pack: CatalogPack | null): SellableUnit {
  return {
    itemId: item.id,
    packId: pack?.id ?? null,
    name: item.name,
    unitLabel: pack ? pack.name.toLowerCase() : item.baseUnit,
    baseQtyPerUnitMilli: pack ? pack.baseQtyMilli : 1000,
    fractional: item.fractional,
    taxCategory: item.taxCategory,
  }
}
