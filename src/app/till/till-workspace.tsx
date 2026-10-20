'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Tabs } from '@base-ui/react/tabs'
import {
  AlertTriangle,
  Banknote,
  Boxes,
  ClipboardList,
  CloudOff,
  KeyRound,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  ScanBarcode,
  ShoppingCart,
  Trash2,
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { ConnectionStatus } from '@/components/shell/connection-status'
import { ConfirmationLine } from '@/components/shell/confirmation-line'
import { SettlementBar } from '@/components/shell/settlement-bar'
import type { ConnectionLevel } from '@/domain/connection-modes'
import { formatAmount, formatKes, formatQty, lineGross, type Milli } from '@/domain/money'
import { orderFigures, type OrderState } from '@/domain/order-state'
import { orderTotals, outstandingMilli, type OrderLine } from '@/domain/orders'
import { ADJUST_REASONS, ADJUST_REASON_LABELS, isLowStock, type AdjustReason } from '@/domain/stock'
import { vatRateBp } from '@/domain/tax'
import type { CatalogItem, CatalogPack, TillStaff } from '@/domain/till-data'
import {
  adjustStock,
  approvers,
  checkout,
  listPrice,
  previewCheckout,
  previewCollection,
  recordCollection,
  takePayment,
  type Actor,
  type CartLine,
} from '@/client/till/actions'
import type { RejectedRecord, SyncStatus } from '@/client/till/db'
import type { TillEngine } from '@/client/till/engine'
import type { TillView } from '@/client/till/view'
import { ApproverDialog } from './till-access'
import { MpesaPayForm, PaymentsPanel } from './till-mpesa'
import { ReceiptPanel } from './till-receipt'
import {
  AmountField,
  ErrorText,
  fieldClass,
  labelClass,
  Modal,
  ONE,
  PanelEmpty,
  parseMoneyOrNull,
  parseQtyOrNull,
  qtyText,
  units,
} from './till-ui'

type Tab = 'sale' | 'orders' | 'stock' | 'payments'

const TABS: { value: Tab; label: string; icon: typeof ShoppingCart }[] = [
  { value: 'sale', label: 'Sale', icon: ShoppingCart },
  { value: 'orders', label: 'Orders', icon: ClipboardList },
  { value: 'stock', label: 'Stock', icon: Boxes },
  { value: 'payments', label: 'Payments', icon: Banknote },
]

type Tile = {
  item: CatalogItem
  packs: CatalogPack[]
  availableMilli: Milli
  onHandMilli: Milli
  owedMilli: Milli
}

const timeFmt = new Intl.DateTimeFormat('en-KE', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Nairobi',
})

function clock(iso: string): string {
  return timeFmt.format(new Date(iso))
}

export function TillWorkspace({
  engine,
  view,
  person,
  level,
  sync,
  rejected,
  onLock,
}: {
  engine: TillEngine
  view: TillView
  person: TillStaff
  level: ConnectionLevel
  sync: SyncStatus | null
  rejected: RejectedRecord[]
  onLock: () => void
}) {
  const [tab, setTab] = useState<Tab>('sale')
  const [cart, setCart] = useState<CartLine[]>([])
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [done, setDone] = useState<Done | null>(null)
  const [openOrder, setOpenOrder] = useState<{ id: string; mode: OrderMode } | null>(null)
  const scanRef = useRef<HTMLInputElement>(null)
  const actor: Actor = { membershipId: person.membershipId, name: person.name, role: person.role }
  const blocked = level === 'blocked' || view.settings?.outlet.active === false

  const tiles = useMemo<Tile[]>(() => {
    const packsByItem = new Map<string, CatalogPack[]>()
    for (const p of view.catalog.packs) packsByItem.set(p.itemId, [...(packsByItem.get(p.itemId) ?? []), p])
    return view.catalog.items
      .map((item) => {
        const onHand = view.onHand.get(item.id) ?? 0
        const owed = view.owed.get(item.id) ?? 0
        return { item, packs: packsByItem.get(item.id) ?? [], onHandMilli: onHand, owedMilli: owed, availableMilli: onHand - owed }
      })
      .sort((a, b) => a.item.name.localeCompare(b.item.name))
  }, [view])
  const tileById = useMemo(() => new Map(tiles.map((t) => [t.item.id, t])), [tiles])

  function refocusScan() {
    if (window.matchMedia('(pointer: fine)').matches) scanRef.current?.focus()
  }
  useEffect(refocusScan, [])

  function add(itemId: string, packId: string | null) {
    refocusScan()
    setDone(null)
    const price = listPrice(view, itemId, packId)
    if (!price) return
    setCart((prev) => {
      const existing = prev.find((l) => l.itemId === itemId && l.packId === packId)
      if (existing) return prev.map((l) => (l === existing ? { ...l, qtyMilli: l.qtyMilli + ONE } : l))
      return [
        ...prev,
        { id: crypto.randomUUID(), itemId, packId, qtyMilli: ONE, unitPriceCents: price.priceCents, priceApproverId: null },
      ]
    })
  }

  function updateLine(id: string, patch: Partial<CartLine> | null) {
    refocusScan()
    setCart((prev) => prev.flatMap((l) => (l.id !== id ? [l] : patch === null ? [] : [{ ...l, ...patch }])))
  }

  const cartLines = cart.map((c) => {
    const t = tileById.get(c.itemId)
    const pack = c.packId ? t?.packs.find((p) => p.id === c.packId) : null
    return {
      cart: c,
      name: t?.item.name ?? 'Item',
      unit: pack ? pack.name.toLowerCase() : (t?.item.baseUnit ?? 'unit'),
      fractional: !pack && !!t?.item.fractional,
      floorCents: listPrice(view, c.itemId, c.packId)?.floorCents ?? 0,
      vatRateBp: t ? vatRateBp(t.item.taxCategory) : 0,
    }
  })
  const totals = orderTotals(
    cartLines.map((l) => ({
      lineId: l.cart.id,
      itemId: l.cart.itemId,
      qtyMilli: l.cart.qtyMilli,
      unitPriceCents: l.cart.unitPriceCents,
      vatRateBp: l.vatRateBp,
      collectedMilli: 0,
    }) satisfies OrderLine),
  )

  const cartPane = (
    <CartPane
      lines={cartLines}
      totals={totals}
      approvers={approvers(view)}
      blocked={blocked}
      onUpdate={updateLine}
      onCheckout={() => setCheckoutOpen(true)}
      done={done}
      onReceipt={(id) => setOpenOrder({ id, mode: 'receipt' })}
    />
  )

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <StatusStrip view={view} person={person} level={level} sync={sync} onLock={onLock} onSync={() => void engine.syncNow()} />
      <ConnectionBanner level={level} outletInactive={view.settings?.outlet.active === false} />
      {rejected.length > 0 && <RejectedNotice engine={engine} rejected={rejected} />}

      <Tabs.Root value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List
          aria-label="Till"
          className="order-last flex shrink-0 border-t border-rule bg-surface pb-[env(safe-area-inset-bottom)] md:order-none md:gap-1 md:border-t-0 md:border-b md:px-3 md:pb-0"
        >
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <Tabs.Tab
                key={t.value}
                value={t.value}
                className="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[active]:text-primary md:h-11 md:flex-none md:flex-row md:gap-2 md:rounded-none md:border-b-2 md:border-transparent md:px-3 md:text-sm md:data-[active]:border-primary"
              >
                <Icon aria-hidden className="size-5 md:size-4" />
                {t.label}
              </Tabs.Tab>
            )
          })}
        </Tabs.List>

        <Tabs.Panel value="sale" className="flex min-h-0 flex-1 outline-none">
          <div className="grid min-h-0 flex-1 grid-rows-1 md:grid-cols-[minmax(0,1fr)_22rem] lg:grid-cols-[minmax(0,1fr)_26rem]">
            <ItemPicker tiles={tiles} view={view} cart={cart} onAdd={add} inputRef={scanRef} canAdmin={person.role !== 'cashier'} />
            <aside aria-label="Current sale" className="hidden min-h-0 flex-col border-l border-rule bg-surface md:flex">
              {cartPane}
            </aside>
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="orders" className="flex min-h-0 flex-1 flex-col outline-none">
          <OrdersPanel orders={view.orders} onOpen={(id) => setOpenOrder({ id, mode: 'view' })} />
        </Tabs.Panel>
        <Tabs.Panel value="stock" className="flex min-h-0 flex-1 flex-col outline-none">
          <StockPanel tiles={tiles} engine={engine} actor={actor} />
        </Tabs.Panel>
        <Tabs.Panel value="payments" className="flex-1 overflow-y-auto outline-none">
          <PaymentsPanel engine={engine} view={view} actor={actor} />
        </Tabs.Panel>

        {/* Phones: the sale rides above the tab bar, total and Checkout under the thumb. */}
        {tab === 'sale' && (
          <div className="order-[998] flex shrink-0 items-center gap-3 border-t border-rule bg-surface px-4 py-2.5 md:hidden">
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="flex min-w-0 flex-1 flex-col items-start rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-xs text-muted-foreground">
                {cart.length === 0 ? 'No items yet' : `${cart.length} ${cart.length === 1 ? 'line' : 'lines'} · view sale`}
              </span>
              <span className="figures text-lg font-semibold">{formatKes(totals.grossCents)}</span>
            </button>
            <Button
              size="lg"
              className="h-12 px-6 text-base"
              disabled={cart.length === 0 || blocked}
              onClick={() => setCheckoutOpen(true)}
            >
              Checkout
            </Button>
          </div>
        )}
      </Tabs.Root>

      <Modal open={cartOpen} onOpenChange={setCartOpen} title="Current sale">
        <div className="-mx-4 -mt-3 flex min-h-[50dvh] flex-col">{cartPane}</div>
      </Modal>

      {checkoutOpen && (
        <CheckoutDialog
          engine={engine}
          view={view}
          actor={actor}
          cartLines={cartLines}
          total={totals.grossCents}
          onClose={() => setCheckoutOpen(false)}
          onDone={(order, viaMpesa) => {
            if (viaMpesa) setOpenOrder({ id: order.id, mode: 'mpesa' })
            setCart([])
            setCheckoutOpen(false)
            setCartOpen(false)
            const f = orderFigures(order)
            setDone({
              orderId: order.id,
              number: order.number,
              tone: order.status === 'closed' ? 'paid' : f.creditInUseCents > 0 ? 'credit' : 'owed',
              text:
                order.status === 'closed'
                  ? f.balanceCents < 0
                    ? `Paid. Change ${formatKes(-f.balanceCents)}.`
                    : 'Paid and collected.'
                  : `Open. ${f.balanceCents > 0 ? `${formatKes(f.balanceCents)} owed.` : ''}${f.goodsOutstanding ? ' Goods still to collect.' : ''}`,
            })
          }}
        />
      )}

      {openOrder && (
        <OrderDialog
          engine={engine}
          view={view}
          actor={actor}
          order={view.orders.find((o) => o.id === openOrder.id) ?? null}
          initialMode={openOrder.mode}
          onClose={() => setOpenOrder(null)}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ status

function StatusStrip({
  view,
  person,
  level,
  sync,
  onLock,
  onSync,
}: {
  view: TillView
  person: TillStaff
  level: ConnectionLevel
  sync: SyncStatus | null
  onLock: () => void
  onSync: () => void
}) {
  const quiet =
    'inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-sm text-rail-muted hover:bg-rail-raised hover:text-rail-ink focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none'
  const s = view.settings
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 bg-rail px-3 text-rail-ink md:px-4">
      {s && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-sm bg-rail-raised px-1.5 py-0.5 font-mono text-xs font-medium">
            {s.outlet.code}-{s.device.code}
          </span>
          <span className="hidden truncate text-sm font-medium sm:inline">{s.outlet.name}</span>
        </div>
      )}
      <span aria-hidden className="hidden h-4 w-px bg-sidebar-border sm:block" />
      <span className="truncate text-sm text-rail-muted">{person.name}</span>
      <ConnectionStatus className="ml-1 text-rail-muted" />
      <button type="button" onClick={onSync} className={cn(quiet, 'h-8 px-2 text-xs')} title="Sync now">
        <RefreshCw aria-hidden className="size-3.5" />
        <span>
          {view.pendingCount > 0
            ? `${view.pendingCount} to sync`
            : sync?.lastSyncAt
              ? `Synced ${timeFmt.format(new Date(sync.lastSyncAt))}`
              : 'Not synced'}
        </span>
      </button>
      {level === 'remind' && <span className="hidden text-xs text-rail-muted md:inline">Connect to sync</span>}
      <div className="ml-auto flex items-center gap-1">
        {person.role !== 'cashier' && (
          <Link href="/admin" className={quiet}>
            <KeyRound aria-hidden className="size-4" />
            <span className="hidden sm:inline">Admin</span>
          </Link>
        )}
        <button type="button" onClick={onLock} className={quiet} aria-label="Lock the till">
          <Lock aria-hidden className="size-4" />
          <span className="hidden sm:inline">Lock</span>
        </button>
      </div>
    </header>
  )
}

/** Reminders get more insistent; the wording never mentions limits. */
function ConnectionBanner({ level, outletInactive }: { level: ConnectionLevel; outletInactive: boolean }) {
  if (outletInactive) {
    return (
      <p role="alert" className="flex items-center gap-2 border-b border-rule bg-credit/10 px-4 py-2 text-sm font-medium text-credit">
        <AlertTriangle aria-hidden className="size-4 shrink-0" />
        This outlet was closed by the owner. New sales are off; orders and stock can still be looked up.
      </p>
    )
  }
  if (level === 'ok' || level === 'remind') return null
  const text =
    level === 'urge'
      ? 'This till has not synced for a while. Connect to the internet so the shop sees these sales.'
      : level === 'insist'
        ? 'Connect to the internet soon. This till needs to sync to keep selling.'
        : 'Connect to the internet to keep selling. Open orders, payments, collections and stock still work.'
  return (
    <p
      role={level === 'urge' ? 'status' : 'alert'}
      className={cn(
        'flex items-center gap-2 border-b px-4 py-2 text-sm font-medium',
        level === 'urge' ? 'border-rule bg-muted text-owed-ink' : 'border-credit/30 bg-credit/10 text-credit',
      )}
    >
      <CloudOff aria-hidden className="size-4 shrink-0" />
      {text}
    </p>
  )
}

function RejectedNotice({ engine, rejected }: { engine: TillEngine; rejected: RejectedRecord[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 border-b border-rule bg-muted px-4 py-1.5 text-left text-xs font-medium text-credit hover:underline"
      >
        <AlertTriangle aria-hidden className="size-3.5" />
        {rejected.length === 1 ? 'The server did not accept 1 action.' : `The server did not accept ${rejected.length} actions.`} Show
      </button>
      <Modal open={open} onOpenChange={setOpen} title="Not accepted by the server">
        <p className="text-sm text-muted-foreground">
          These were recorded on this till but the server refused them. The owner can see them too. Nothing was
          deleted.
        </p>
        <ul className="mt-3 divide-y divide-rule">
          {rejected.map((r) => (
            <li key={r.id} className="py-2 text-sm">
              <p className="font-medium">{OP_LABELS[r.op.type]}</p>
              <p className="text-muted-foreground">{r.message}</p>
            </li>
          ))}
        </ul>
        <Button
          variant="outline"
          className="mt-3"
          onClick={async () => {
            await engine.db.rejected.clear()
            setOpen(false)
          }}
        >
          Dismiss
        </Button>
      </Modal>
    </>
  )
}

const OP_LABELS: Record<string, string> = {
  'sale.checkout': 'A sale',
  'payment.add': 'A payment',
  'collection.record': 'A collection',
  'stock.adjust': 'A stock adjustment',
  'receipt.send': 'A receipt by SMS or email',
}

// -------------------------------------------------------------------- sale

function availability(t: Tile): { text: string; tone: string } {
  const qty = qtyText(t.availableMilli, t.item.baseUnit)
  if (t.availableMilli <= 0) return { text: 'None free', tone: 'text-credit' }
  if (isLowStock(t.availableMilli, t.item.lowStockMilli)) return { text: `${qty} left`, tone: 'text-owed-ink' }
  return { text: qty, tone: 'text-muted-foreground' }
}

function ItemPicker({
  tiles,
  view,
  cart,
  onAdd,
  inputRef,
  canAdmin,
}: {
  tiles: Tile[]
  view: TillView
  cart: CartLine[]
  onAdd: (itemId: string, packId: string | null) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  canAdmin: boolean
}) {
  const [query, setQuery] = useState('')

  // "/" jumps to search from anywhere, like the scanner's own Enter does after a scan.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (e.key === '/' && t?.tagName !== 'INPUT' && t?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inputRef])

  const q = query.trim().toLowerCase()
  const shown = q
    ? tiles.filter((t) => (t.item.sku ?? '').toLowerCase().startsWith(q) || t.item.name.toLowerCase().includes(q))
    : tiles
  const inCart = new Map<string, Milli>()
  for (const l of cart) if (l.packId === null) inCart.set(l.itemId, (inCart.get(l.itemId) ?? 0) + l.qtyMilli)

  function enter() {
    const code = query.trim()
    const barcode = view.catalog.barcodes.find((b) => b.barcode === code)
    if (barcode) onAdd(barcode.itemId, barcode.packId)
    else if (shown[0]) onAdd(shown[0].item.id, null)
    else return
    setQuery('')
  }

  return (
    <section aria-label="Items" className="flex min-h-0 flex-col">
      <div className="shrink-0 border-b border-rule bg-background px-3 py-2.5 md:px-4">
        <label className="relative flex items-center">
          <span className="sr-only">Scan or search items</span>
          <ScanBarcode aria-hidden className="pointer-events-none absolute left-3 size-5 text-muted-foreground" />
          <input
            ref={inputRef}
            type="search"
            inputMode="search"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                enter()
              }
            }}
            placeholder="Scan, or type a code or name"
            className="h-11 w-full rounded-md border border-input bg-surface pr-12 pl-11 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          <kbd className="pointer-events-none absolute right-3 hidden rounded border border-rule px-1.5 font-mono text-xs text-muted-foreground md:block">
            /
          </kbd>
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
        {tiles.length === 0 ? (
          <PanelEmpty
            title="No items yet"
            body="Items and prices are set up in Admin. Once added, they show here for every till at this outlet after the next sync."
            action={
              canAdmin ? (
                <Link href="/admin/items" className="text-sm font-medium text-primary hover:underline">
                  Go to Admin
                </Link>
              ) : null
            }
          />
        ) : shown.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">
            Nothing matches “{query}”. Check the code, or search by name.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
            {shown.map((t) => {
              const a = availability(t)
              const qty = inCart.get(t.item.id)
              return (
                <li key={t.item.id} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => onAdd(t.item.id, null)}
                    className={cn(
                      'relative flex min-h-[6.75rem] w-full flex-1 flex-col gap-1 rounded-md border bg-surface p-2.5 text-left outline-none transition-[border-color,box-shadow] duration-150 hover:border-foreground/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:translate-y-px',
                      qty ? 'border-foreground/50 shadow-[0_1px_0_0_var(--foreground)]' : 'border-rule',
                      t.packs.length > 0 && 'rounded-b-none',
                    )}
                  >
                    {t.item.sku && <span className="font-mono text-[0.7rem] font-medium text-muted-foreground">{t.item.sku}</span>}
                    <span className="line-clamp-2 text-sm leading-snug font-medium">{t.item.name}</span>
                    <span className="mt-auto flex items-baseline justify-between gap-2">
                      <span className="figures text-sm font-semibold">
                        {formatAmount(t.item.priceCents)}
                        <span className="font-normal text-muted-foreground"> /{t.item.baseUnit}</span>
                      </span>
                      <span className={cn('figures truncate text-[0.7rem]', a.tone)}>{a.text}</span>
                    </span>
                    {qty !== undefined && (
                      <span className="figures absolute top-2 right-2 rounded-sm bg-foreground px-1.5 py-px text-[0.7rem] font-semibold text-background">
                        ×{formatQty(qty)}
                      </span>
                    )}
                  </button>
                  {t.packs.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onAdd(t.item.id, p.id)}
                      className="flex items-baseline justify-between gap-2 border border-t-0 border-rule bg-surface px-2.5 py-2 text-left text-xs last:rounded-b-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <span className="font-medium">
                        + {p.name} of {formatQty(p.baseQtyMilli)}
                      </span>
                      <span className="figures font-semibold">{formatAmount(p.priceCents)}</span>
                    </button>
                  ))}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

type Done = { orderId: string; number: string; text: string; tone: 'paid' | 'owed' | 'credit' | 'neutral' }

type CartView = {
  cart: CartLine
  name: string
  unit: string
  fractional: boolean
  floorCents: number
  vatRateBp: number
}

function CartPane({
  lines,
  totals,
  approvers: approverList,
  blocked,
  onUpdate,
  onCheckout,
  done,
  onReceipt,
}: {
  lines: CartView[]
  totals: { grossCents: number; vatCents: number }
  approvers: TillStaff[]
  blocked: boolean
  onUpdate: (id: string, patch: Partial<CartLine> | null) => void
  onCheckout: () => void
  done: Done | null
  onReceipt: (orderId: string) => void
}) {
  const [pricing, setPricing] = useState<{ id: string; cents: number } | null>(null)
  const needsApproval = lines.some((l) => l.cart.unitPriceCents < l.floorCents && !l.cart.priceApproverId)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-rule px-4 py-3">
        <h2 className="text-base font-semibold">New sale</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Walk-in. A name and phone are needed if anything is left owed.</p>
      </div>

      <div className="min-h-[7.5rem] flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">Scan or tap an item to start a sale.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {lines.map((l) => (
              <CartRow key={l.cart.id} l={l} onUpdate={onUpdate} onPrice={(cents) => setPricing({ id: l.cart.id, cents })} />
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-rule bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {done && (
          <ul className="mb-2 border-b border-rule">
            <ConfirmationLine compact c={{ code: done.number, status: 'Saved', tone: done.tone, balance: done.text, at: new Date() }} />
            <li className="pb-2">
              <button type="button" onClick={() => onReceipt(done.orderId)} className="text-sm font-medium text-primary hover:underline">
                Print or send the receipt
              </button>
            </li>
          </ul>
        )}
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Total</span>
          <span className="figures text-2xl font-semibold tracking-tight">{formatKes(totals.grossCents)}</span>
        </div>
        <p className="figures text-right text-xs text-muted-foreground">Includes VAT {formatKes(totals.vatCents)}</p>
        {needsApproval && (
          <p className="mt-2 text-xs font-medium text-owed-ink">A price is below the lowest price and needs approval.</p>
        )}
        <Button
          size="lg"
          className="mt-3 h-12 w-full text-base"
          disabled={lines.length === 0 || blocked || needsApproval}
          onClick={onCheckout}
        >
          Checkout
        </Button>
      </div>

      {pricing && (
        <ApproverDialog
          open
          onOpenChange={(o) => !o && setPricing(null)}
          title="Approve a lower price"
          reason={`Selling at ${formatKes(pricing.cents)}, below the lowest price set for this item.`}
          approvers={approverList}
          onApproved={(id) => {
            onUpdate(pricing.id, { unitPriceCents: pricing.cents, priceApproverId: id })
            setPricing(null)
          }}
        />
      )}
    </div>
  )
}

function CartRow({
  l,
  onUpdate,
  onPrice,
}: {
  l: CartView
  onUpdate: (id: string, patch: Partial<CartLine> | null) => void
  /** A price below the floor was entered: ask for approval. */
  onPrice: (cents: number) => void
}) {
  const [editing, setEditing] = useState<'qty' | 'price' | null>(null)
  const [text, setText] = useState('')
  const c = l.cart

  function commit() {
    if (editing === 'qty') {
      const q = parseQtyOrNull(text)
      if (q !== null && q > 0 && (l.fractional || q % ONE === 0)) onUpdate(c.id, { qtyMilli: q })
    } else if (editing === 'price') {
      const p = parseMoneyOrNull(text)
      if (p !== null) {
        if (p < l.floorCents) onPrice(p)
        else onUpdate(c.id, { unitPriceCents: p, priceApproverId: null })
      }
    }
    setEditing(null)
  }

  const edit = (what: 'qty' | 'price') => {
    setEditing(what)
    setText(what === 'qty' ? formatQty(c.qtyMilli) : formatAmount(c.unitPriceCents).replace(/,/g, ''))
  }

  return (
    <li className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{l.name}</p>
        {editing === 'price' ? (
          <input
            aria-label={`Price per ${l.unit}`}
            autoFocus
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            className="figures mt-1 h-8 w-28 rounded border border-input px-2 text-sm"
          />
        ) : (
          <button type="button" onClick={() => edit('price')} className="figures text-xs text-muted-foreground hover:underline">
            {formatKes(c.unitPriceCents)} / {l.unit}
            {c.priceApproverId && <span className="text-owed-ink"> · approved</span>}
          </button>
        )}
      </div>
      <p className="figures text-right text-sm font-semibold">{formatKes(lineGross(c.qtyMilli, c.unitPriceCents))}</p>
      <div className="col-span-2 flex items-center gap-1">
        <button
          type="button"
          aria-label={`One less ${l.name}`}
          onClick={() => onUpdate(c.id, c.qtyMilli - ONE >= ONE ? { qtyMilli: c.qtyMilli - ONE } : null)}
          className="inline-flex size-10 items-center justify-center rounded-md border border-rule hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {c.qtyMilli <= ONE ? <Trash2 aria-hidden className="size-4" /> : <Minus aria-hidden className="size-4" />}
        </button>
        {editing === 'qty' ? (
          <input
            aria-label={`Quantity of ${l.name}`}
            autoFocus
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            className="figures h-10 w-20 rounded border border-input px-2 text-center text-sm"
          />
        ) : (
          <button
            type="button"
            onClick={() => edit('qty')}
            className="figures min-w-16 rounded px-1 text-center text-sm font-semibold hover:bg-muted"
            aria-label={`Quantity ${formatQty(c.qtyMilli)} ${units(c.qtyMilli, l.unit)}, change`}
          >
            {formatQty(c.qtyMilli)} <span className="font-normal text-muted-foreground">{units(c.qtyMilli, l.unit)}</span>
          </button>
        )}
        <button
          type="button"
          aria-label={`One more ${l.name}`}
          onClick={() => onUpdate(c.id, { qtyMilli: c.qtyMilli + ONE })}
          className="inline-flex size-10 items-center justify-center rounded-md border border-rule hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Plus aria-hidden className="size-4" />
        </button>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------- checkout

type PayMethod = 'cash' | 'mark_paid' | 'mpesa' | 'later'

function CheckoutDialog({
  engine,
  view,
  actor,
  cartLines,
  total,
  onClose,
  onDone,
}: {
  engine: TillEngine
  view: TillView
  actor: Actor
  cartLines: CartView[]
  total: number
  onClose: () => void
  onDone: (order: OrderState, viaMpesa: boolean) => void
}) {
  const [method, setMethod] = useState<PayMethod>('cash')
  const [tendered, setTendered] = useState<number | null>(total)
  const [reason, setReason] = useState('')
  const [markApprover, setMarkApprover] = useState<string | null>(null)
  const [collect, setCollect] = useState<Record<string, Milli>>(
    Object.fromEntries(cartLines.map((l) => [l.cart.id, l.cart.qtyMilli])),
  )
  const [customer, setCustomer] = useState({ name: '', phone: '' })
  const [creditApprover, setCreditApprover] = useState<string | null>(null)
  const [approving, setApproving] = useState<'mark_paid' | 'credit' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // M-Pesa is sent from the order once it exists: the sale is saved unpaid first.
  const payLater = method === 'later' || method === 'mpesa'
  const amount = payLater ? 0 : Math.min(tendered ?? 0, total)
  const change = method === 'cash' && tendered !== null && tendered > total ? tendered - total : 0
  const draft = {
    cart: cartLines.map((l) => l.cart),
    customer,
    payment: method === 'cash' || method === 'mark_paid' ? { method, amountCents: amount, reason, approverId: markApprover } : null,
    collect,
    creditApproverId: creditApprover,
  } as const
  const preview = previewCheckout(view, actor, draft)
  const needsCredit = !preview.ok && preview.error.message.startsWith('That is more than has been paid')
  const needsMarkApproval = method === 'mark_paid' && !markApprover

  async function confirm() {
    setBusy(true)
    setError(null)
    const r = await checkout(engine, view, actor, draft)
    setBusy(false)
    if (r.ok) onDone(r.order, method === 'mpesa')
    else setError(r.error.message)
  }

  const list = approvers(view)
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Checkout · ${formatKes(total)}`} wide>
      <div className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-3">
          <legend className={cn(labelClass, 'mb-2')}>Payment</legend>
          <div className={cn('grid gap-2', view.settings?.mpesa ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3')} role="radiogroup" aria-label="Payment method">
            {(
              [
                ['cash', 'Cash'],
                ...(view.settings?.mpesa ? ([['mpesa', 'M-Pesa']] as const) : []),
                ['mark_paid', 'Mark paid'],
                ['later', 'Pay later'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={method === v}
                onClick={() => {
                  setMethod(v)
                  // Goods wait for the M-Pesa payment.
                  if (v === 'mpesa') setCollect({})
                }}
                className={cn(
                  'h-11 rounded-md border text-sm font-medium',
                  method === v ? 'border-primary bg-primary/10 text-primary' : 'border-rule hover:bg-muted',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {method === 'mpesa' && (
            <p className="text-sm text-muted-foreground">
              The sale is saved, then the M-Pesa request goes to the customer&apos;s phone. Hand over the goods once it is paid.
            </p>
          )}
          {!payLater && (
            <AmountField
              key={method}
              id="co-amount"
              label={method === 'cash' ? 'Cash received' : 'Amount paid'}
              initial={formatAmount(total).replace(/,/g, '')}
              onValue={setTendered}
              hint={change > 0 ? `Change: ${formatKes(change)}` : amount < total ? `${formatKes(total - amount)} left owed` : undefined}
            />
          )}
          {method === 'mark_paid' && (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="co-reason" className={labelClass}>
                  Why is it paid?
                </label>
                <input
                  id="co-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Bank transfer seen on statement"
                  className={fieldClass}
                />
              </div>
              <Button variant="outline" onClick={() => setApproving('mark_paid')}>
                {markApprover ? 'Approved' : 'Get approval'}
              </Button>
            </>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className={cn(labelClass, 'mb-1 flex w-full items-center justify-between')}>
            Taking now
            <span className="flex gap-3 text-xs font-medium">
              <button type="button" className="text-primary hover:underline" onClick={() => setCollect(Object.fromEntries(cartLines.map((l) => [l.cart.id, l.cart.qtyMilli])))}>
                Everything
              </button>
              <button type="button" className="text-primary hover:underline" onClick={() => setCollect({})}>
                Nothing
              </button>
            </span>
          </legend>
          <ul className="divide-y divide-rule rounded-md border border-rule">
            {cartLines.map((l) => (
              <li key={l.cart.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-sm">
                  {l.name} <span className="text-muted-foreground">({qtyText(l.cart.qtyMilli, l.unit)})</span>
                </span>
                <QtyStepper
                  value={collect[l.cart.id] ?? 0}
                  max={l.cart.qtyMilli}
                  label={`Quantity of ${l.name} taken now`}
                  onChange={(q) => setCollect((c) => ({ ...c, [l.cart.id]: q }))}
                />
              </li>
            ))}
          </ul>
        </fieldset>

        <CustomerFields customer={customer} onChange={setCustomer} />

        {needsCredit && !creditApprover && (
          <div className="flex flex-col gap-2 rounded-md border border-credit/30 bg-credit/5 p-3">
            <p className="text-sm text-credit">{preview.ok ? '' : preview.error.message}</p>
            <Button variant="outline" onClick={() => setApproving('credit')}>
              Give on credit
            </Button>
          </div>
        )}
        {!preview.ok && !needsCredit && <p className="text-sm text-muted-foreground">{preview.error.message}</p>}
        <ErrorText>{error}</ErrorText>
        <Button
          size="lg"
          className="h-12 text-base"
          disabled={busy || !preview.ok || needsMarkApproval}
          onClick={() => void confirm()}
        >
          {busy ? 'Saving…' : 'Confirm sale'}
        </Button>
      </div>

      {approving && (
        <ApproverDialog
          open
          onOpenChange={(o) => !o && setApproving(null)}
          title={approving === 'credit' ? 'Approve credit' : 'Approve marking paid'}
          reason={
            approving === 'credit'
              ? 'The customer takes goods worth more than they have paid. The difference is recorded as money they owe.'
              : 'The order is marked paid without a payment the till can see.'
          }
          approvers={list}
          onApproved={(id) => (approving === 'credit' ? setCreditApprover(id) : setMarkApprover(id))}
        />
      )}
    </Modal>
  )
}

function QtyStepper({ value, max, label, onChange }: { value: Milli; max: Milli; label: string; onChange: (q: Milli) => void }) {
  return (
    <span className="flex items-center gap-1" role="group" aria-label={label}>
      <button
        type="button"
        aria-label="Less"
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, value - ONE))}
        className="inline-flex size-9 items-center justify-center rounded-md border border-rule hover:bg-muted disabled:opacity-40"
      >
        <Minus aria-hidden className="size-4" />
      </button>
      <span className="figures min-w-14 text-center text-sm font-semibold">{formatQty(value)}</span>
      <button
        type="button"
        aria-label="More"
        disabled={value + ONE > max}
        onClick={() => onChange(Math.min(max, value + ONE))}
        className="inline-flex size-9 items-center justify-center rounded-md border border-rule hover:bg-muted disabled:opacity-40"
      >
        <Plus aria-hidden className="size-4" />
      </button>
    </span>
  )
}

function CustomerFields({
  customer,
  onChange,
  locked,
}: {
  customer: { name: string; phone: string }
  onChange: (c: { name: string; phone: string }) => void
  locked?: { name: string; phone: string } | null
}) {
  if (locked) {
    return (
      <p className="text-sm">
        <span className="text-muted-foreground">Customer: </span>
        {locked.name} · {locked.phone}
      </p>
    )
  }
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium">
        Customer <span className="font-normal text-muted-foreground">(needed when anything is left owed)</span>
      </legend>
      <input
        aria-label="Customer name"
        placeholder="Name"
        autoComplete="off"
        value={customer.name}
        onChange={(e) => onChange({ ...customer, name: e.target.value })}
        className={fieldClass}
      />
      <input
        aria-label="Customer phone"
        placeholder="Phone, e.g. 0712 345 678"
        inputMode="tel"
        autoComplete="off"
        value={customer.phone}
        onChange={(e) => onChange({ ...customer, phone: e.target.value })}
        className={fieldClass}
      />
    </fieldset>
  )
}

// ------------------------------------------------------------------ orders

function OrdersPanel({ orders, onOpen }: { orders: OrderState[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const digits = q.replace(/\D/g, '').replace(/^0/, '')
  const shown = orders.filter(
    (o) =>
      !q ||
      o.number.toLowerCase().includes(q) ||
      o.customer?.name.toLowerCase().includes(q) ||
      (digits.length >= 3 && o.customer?.phone.includes(digits)),
  )
  const open = shown.filter((o) => o.status === 'open')
  const closed = shown.filter((o) => o.status === 'closed')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-rule bg-background px-3 py-2.5 md:px-4">
        <input
          type="search"
          aria-label="Find an order"
          placeholder="Order number, customer name or phone"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={fieldClass}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {orders.length === 0 ? (
          <PanelEmpty title="No open orders" body="Orders with money or goods still owed are listed here, with today's closed sales." />
        ) : (
          <>
            <OrderList title="Open" orders={open} onOpen={onOpen} />
            <OrderList title="Closed recently" orders={closed} onOpen={onOpen} />
          </>
        )}
      </div>
    </div>
  )
}

function OrderList({ title, orders, onOpen }: { title: string; orders: OrderState[]; onOpen: (id: string) => void }) {
  if (orders.length === 0) return null
  return (
    <section className="px-3 py-3 md:px-4">
      <h2 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
        {orders.map((o) => {
          const f = orderFigures(o)
          const pending = o.events.some((e) => e.pending)
          return (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => onOpen(o.id)}
                className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-3 py-2.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className="font-mono text-sm font-medium">{o.number}</span>
                <span className="figures text-right text-sm font-semibold">{formatKes(f.totalCents)}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {o.customer ? `${o.customer.name} · ${o.customer.phone}` : 'Walk-in'} · {clock(o.occurredAt)}
                  {pending && ' · not synced'}
                  {o.flagged && ' · flagged'}
                </span>
                <span className="text-right text-xs">
                  {f.balanceCents > 0 && <span className="text-owed-ink">{formatKes(f.balanceCents)} owed</span>}
                  {f.balanceCents <= 0 && f.goodsOutstanding && <span className="text-muted-foreground">To collect</span>}
                  {f.creditInUseCents > 0 && <span className="text-credit"> · credit</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

type OrderMode = 'view' | 'pay' | 'mpesa' | 'collect' | 'receipt'

function OrderDialog({
  engine,
  view,
  actor,
  order,
  initialMode,
  onClose,
}: {
  engine: TillEngine
  view: TillView
  actor: Actor
  order: OrderState | null
  initialMode: OrderMode
  onClose: () => void
}) {
  const [mode, setMode] = useState<OrderMode>(initialMode)
  if (!order) return null
  const f = orderFigures(order)
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={order.number} wide>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {order.customer ? `${order.customer.name} · ${order.customer.phone}` : 'Walk-in'} ·{' '}
          {order.status === 'open' ? 'Open' : 'Closed'}
          {order.flagged && <span className="text-credit"> · Flagged: goods went out beyond what was paid</span>}
        </p>
        <SettlementBar total={f.totalCents} paid={f.paidCents} collected={f.collectedValueCents} />
        <ul className="divide-y divide-rule rounded-md border border-rule">
          {order.lines.map((l) => (
            <li key={l.lineId} className="grid grid-cols-[1fr_auto] gap-x-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate font-medium">{l.name}</span>
              <span className="figures text-right">{formatKes(lineGross(l.qtyMilli - l.cancelledMilli, l.unitPriceCents))}</span>
              <span className="figures text-xs text-muted-foreground">
                {qtyText(l.qtyMilli - l.cancelledMilli, l.unitLabel)} at {formatKes(l.unitPriceCents)}
              </span>
              <span className={cn('figures text-right text-xs', outstandingMilli(l) > 0 ? 'text-owed-ink' : 'text-muted-foreground')}>
                {formatQty(l.collectedMilli)} of {formatQty(l.qtyMilli - l.cancelledMilli)} collected
              </span>
            </li>
          ))}
        </ul>
        {f.balanceCents < 0 && (
          <p className="text-sm">
            Paid {formatKes(-f.balanceCents)} more than the total: held for the customer.
          </p>
        )}

        {mode === 'view' && (
          <>
            {(f.balanceCents > 0 || f.goodsOutstanding) && (
              <div className={cn('grid gap-2', view.settings?.mpesa ? 'grid-cols-3' : 'grid-cols-2')}>
                <Button size="lg" className="h-11" disabled={f.balanceCents <= 0} onClick={() => setMode('pay')}>
                  Take payment
                </Button>
                {view.settings?.mpesa && (
                  <Button size="lg" variant="outline" className="h-11" disabled={f.balanceCents <= 0} onClick={() => setMode('mpesa')}>
                    M-Pesa
                  </Button>
                )}
                <Button size="lg" variant="outline" className="h-11" disabled={!f.goodsOutstanding} onClick={() => setMode('collect')}>
                  Collect
                </Button>
              </div>
            )}
            <Button variant="outline" size="lg" className="h-11" onClick={() => setMode('receipt')}>
              Print or send a receipt
            </Button>
            <section>
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">History</h3>
              <ol className="divide-y divide-rule">
                {order.events.map((e, i) => (
                  <ConfirmationLine key={i} c={eventLine(order.number, e)} className="text-xs" />
                ))}
              </ol>
            </section>
          </>
        )}
        {mode === 'receipt' && <ReceiptPanel engine={engine} view={view} actor={actor} order={order} onDone={() => setMode('view')} />}
        {mode === 'mpesa' && (
          <div className="border-t border-rule pt-3">
            <MpesaPayForm engine={engine} actor={actor} order={order} onDone={() => setMode('view')} />
          </div>
        )}
        {mode === 'pay' && <PayForm engine={engine} view={view} actor={actor} order={order} onDone={() => setMode('view')} />}
        {mode === 'collect' && <CollectForm engine={engine} view={view} actor={actor} order={order} onDone={() => setMode('view')} />}
      </div>
    </Modal>
  )
}

function eventLine(number: string, e: OrderState['events'][number]) {
  const base = { code: number, by: e.by, at: new Date(e.at) }
  const pending = e.pending ? ' Not synced yet.' : ''
  switch (e.kind) {
    case 'created':
      return { ...base, status: 'Created', tone: 'neutral' as const, detail: pending }
    case 'payment':
      return {
        ...base,
        status: e.method === 'mark_paid' ? 'Marked paid' : 'Paid',
        tone: 'paid' as const,
        detail: `${formatKes(e.amountCents ?? 0)}${e.method === 'cash' ? ' cash' : e.method === 'mpesa' ? ' by M-Pesa' : ''}.${e.detail ? ` ${e.detail}.` : ''}${pending}`,
      }
    case 'refund':
      return { ...base, status: 'Refunded', tone: 'owed' as const, detail: `${formatKes(e.amountCents ?? 0)}.${pending}` }
    case 'collection':
      return {
        ...base,
        status: 'Collected',
        tone: (e.creditGrantedCents ?? 0) > 0 ? ('credit' as const) : ('neutral' as const),
        detail: `Goods worth ${formatKes(e.amountCents ?? 0)}.${(e.creditGrantedCents ?? 0) > 0 ? ` ${formatKes(e.creditGrantedCents!)} on credit.` : ''}${pending}`,
      }
    case 'cancelled':
      return { ...base, status: 'Remainder cancelled', tone: 'owed' as const, detail: e.detail ?? '' }
  }
}

function PayForm({ engine, view, actor, order, onDone }: { engine: TillEngine; view: TillView; actor: Actor; order: OrderState; onDone: () => void }) {
  const due = orderFigures(order).balanceCents
  const [method, setMethod] = useState<'cash' | 'mark_paid'>('cash')
  const [tendered, setTendered] = useState<number | null>(due)
  const [reason, setReason] = useState('')
  const [approver, setApprover] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const [customer, setCustomer] = useState({ name: '', phone: '' })
  const [error, setError] = useState<string | null>(null)
  const amount = Math.min(tendered ?? 0, due)
  const change = method === 'cash' && tendered !== null && tendered > due ? tendered - due : 0

  async function submit() {
    const r = await takePayment(engine, view, actor, order, { method, amountCents: amount, reason, approverId: approver }, customer)
    if (r.ok) onDone()
    else setError(r.error.message)
  }

  return (
    <div className="flex flex-col gap-3 border-t border-rule pt-3">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Payment method">
        {(
          [
            ['cash', 'Cash'],
            ['mark_paid', 'Mark paid'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={method === v}
            onClick={() => setMethod(v)}
            className={cn('h-11 rounded-md border text-sm font-medium', method === v ? 'border-primary bg-primary/10 text-primary' : 'border-rule hover:bg-muted')}
          >
            {label}
          </button>
        ))}
      </div>
      <AmountField
        id="pay-amount"
        label={method === 'cash' ? 'Cash received' : 'Amount'}
        initial={formatAmount(due).replace(/,/g, '')}
        onValue={setTendered}
        hint={change > 0 ? `Change: ${formatKes(change)}` : `Balance ${formatKes(due)}`}
        autoFocus
      />
      {method === 'mark_paid' && (
        <>
          <input aria-label="Why is it paid?" placeholder="Why is it paid?" value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} />
          <Button variant="outline" onClick={() => setApproving(true)}>
            {approver ? 'Approved' : 'Get approval'}
          </Button>
        </>
      )}
      <CustomerFields customer={customer} onChange={setCustomer} locked={order.customer} />
      <ErrorText>{error}</ErrorText>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button size="lg" className="h-11" disabled={amount <= 0 || (method === 'mark_paid' && !approver)} onClick={() => void submit()}>
          Record {formatKes(amount)}
        </Button>
        <Button size="lg" variant="ghost" className="h-11" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {approving && (
        <ApproverDialog
          open
          onOpenChange={setApproving}
          title="Approve marking paid"
          reason="The order is marked paid without a payment the till can see."
          approvers={approvers(view)}
          onApproved={setApprover}
        />
      )}
    </div>
  )
}

function CollectForm({ engine, view, actor, order, onDone }: { engine: TillEngine; view: TillView; actor: Actor; order: OrderState; onDone: () => void }) {
  const [collect, setCollect] = useState<Record<string, Milli>>(
    Object.fromEntries(order.lines.filter((l) => outstandingMilli(l) > 0).map((l) => [l.lineId, outstandingMilli(l)])),
  )
  const [approver, setApprover] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const [customer, setCustomer] = useState({ name: '', phone: '' })
  const [error, setError] = useState<string | null>(null)
  const preview = previewCollection(view, actor, order, collect, approver)
  const needsCredit = !preview.ok && preview.error.code === 'forbidden'

  async function submit() {
    const r = await recordCollection(engine, view, actor, order, collect, approver, customer)
    if (r.ok) onDone()
    else setError(r.error.message)
  }

  return (
    <div className="flex flex-col gap-3 border-t border-rule pt-3">
      <ul className="divide-y divide-rule rounded-md border border-rule">
        {order.lines
          .filter((l) => outstandingMilli(l) > 0)
          .map((l) => (
            <li key={l.lineId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 truncate text-sm">
                {l.name} <span className="text-muted-foreground">({qtyText(outstandingMilli(l), l.unitLabel)} left)</span>
              </span>
              <QtyStepper
                value={collect[l.lineId] ?? 0}
                max={outstandingMilli(l)}
                label={`Quantity of ${l.name} taken now`}
                onChange={(q) => setCollect((c) => ({ ...c, [l.lineId]: q }))}
              />
            </li>
          ))}
      </ul>
      <CustomerFields customer={customer} onChange={setCustomer} locked={order.customer} />
      {preview.ok ? (
        <p className="text-sm text-muted-foreground">Goods worth {formatKes(preview.valueCents)}.</p>
      ) : needsCredit ? (
        <div className="flex flex-col gap-2 rounded-md border border-credit/30 bg-credit/5 p-3">
          <p className="text-sm text-credit">{preview.error.message}</p>
          <Button variant="outline" onClick={() => setApproving(true)}>
            Give on credit
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{preview.error.message}</p>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button size="lg" className="h-11" disabled={!preview.ok} onClick={() => void submit()}>
          Record collection
        </Button>
        <Button size="lg" variant="ghost" className="h-11" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {approving && (
        <ApproverDialog
          open
          onOpenChange={setApproving}
          title="Approve credit"
          reason="The customer takes goods worth more than they have paid. The difference is recorded as money they owe."
          approvers={approvers(view)}
          onApproved={setApprover}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------- stock

function StockPanel({ tiles, engine, actor }: { tiles: Tile[]; engine: TillEngine; actor: Actor }) {
  const [query, setQuery] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [adjusting, setAdjusting] = useState<Tile | null>(null)
  const canAdjust = actor.role !== 'cashier'
  const q = query.trim().toLowerCase()
  const shown = tiles.filter(
    (t) =>
      (!q || t.item.name.toLowerCase().includes(q) || (t.item.sku ?? '').toLowerCase().startsWith(q)) &&
      (!lowOnly || isLowStock(t.availableMilli, t.item.lowStockMilli) || t.onHandMilli < 0),
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-rule bg-background px-3 py-2.5 md:px-4">
        <input
          type="search"
          aria-label="Find an item"
          placeholder="Item name or code"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={fieldClass}
        />
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low only
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-medium">Item</th>
              <th className="py-1 text-right font-medium">On hand</th>
              <th className="hidden py-1 text-right font-medium sm:table-cell">Owed</th>
              <th className="py-1 text-right font-medium">Free</th>
              {canAdjust && <th className="py-1" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {shown.map((t) => {
              const low = isLowStock(t.availableMilli, t.item.lowStockMilli)
              return (
                <tr key={t.item.id}>
                  <td className="py-2 pr-2">
                    <span className="font-medium">{t.item.name}</span>
                    <span className="block text-xs text-muted-foreground">{t.item.baseUnit}</span>
                  </td>
                  <td className={cn('figures py-2 text-right', t.onHandMilli < 0 && 'text-credit')}>{formatQty(t.onHandMilli)}</td>
                  <td className="figures hidden py-2 text-right text-muted-foreground sm:table-cell">{formatQty(t.owedMilli)}</td>
                  <td className={cn('figures py-2 text-right font-semibold', low && 'text-owed-ink')}>{formatQty(t.availableMilli)}</td>
                  {canAdjust && (
                    <td className="py-2 pl-2 text-right">
                      <Button variant="outline" size="sm" onClick={() => setAdjusting(t)}>
                        Adjust
                      </Button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {adjusting && <AdjustDialog tile={adjusting} engine={engine} actor={actor} onClose={() => setAdjusting(null)} />}
    </div>
  )
}

function AdjustDialog({ tile, engine, actor, onClose }: { tile: Tile; engine: TillEngine; actor: Actor; onClose: () => void }) {
  const [text, setText] = useState('')
  const [reason, setReason] = useState<AdjustReason>('damaged')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const negative = text.trim().startsWith('-')
  const magnitude = parseQtyOrNull(text.trim().replace(/^[-+]/, ''))
  const delta = magnitude === null ? null : negative ? -magnitude : magnitude

  async function submit() {
    if (delta === null || delta === 0) return setError('Enter the change, for example -2 or 5.')
    if (!tile.item.fractional && delta % ONE !== 0) return setError('This item is only counted in whole units.')
    const r = await adjustStock(engine, actor, { itemId: tile.item.id, deltaMilli: delta, reason, note })
    if (r.ok) onClose()
    else setError(r.error.message)
  }

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Adjust ${tile.item.name}`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">On hand now: {qtyText(tile.onHandMilli, tile.item.baseUnit)}.</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="adj-delta" className={labelClass}>
            Change ({tile.item.baseUnit})
          </label>
          <input id="adj-delta" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="-2" className={cn(fieldClass, 'figures')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="adj-reason" className={labelClass}>
            Reason
          </label>
          <select id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value as AdjustReason)} className={fieldClass}>
            {ADJUST_REASONS.map((r) => (
              <option key={r} value={r}>
                {ADJUST_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <input aria-label="Note" placeholder="Note (needed for Other)" value={note} onChange={(e) => setNote(e.target.value)} className={fieldClass} />
        <ErrorText>{error}</ErrorText>
        <Button size="lg" className="h-11" onClick={() => void submit()}>
          Save adjustment
        </Button>
      </div>
    </Modal>
  )
}
