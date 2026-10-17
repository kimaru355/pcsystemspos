'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import {
  Banknote,
  Boxes,
  ClipboardList,
  KeyRound,
  LogOut,
  Minus,
  Plus,
  ScanBarcode,
  ShoppingCart,
  X,
} from 'lucide-react'
import { cn } from 'cn'
import { formatKes, formatQty, lineGross } from '@/domain/money'
import { collectedValueCents, orderTotals, type OrderLine } from '@/domain/orders'
import { Button } from '@/components/ui/button'
import { ConnectionStatus } from '@/components/shell/connection-status'
import { ConfirmationLine } from '@/components/shell/confirmation-line'
import { SettlementBar } from '@/components/shell/settlement-bar'
import { logout } from '../logout/actions'
import type { TillItem, TillOrder } from './types'

type OutletOption = { id: string; code: string; name: string }
type Tab = 'sale' | 'orders' | 'stock' | 'payments'

const TABS: { value: Tab; label: string; icon: typeof ShoppingCart }[] = [
  { value: 'sale', label: 'Sale', icon: ShoppingCart },
  { value: 'orders', label: 'Orders', icon: ClipboardList },
  { value: 'stock', label: 'Stock', icon: Boxes },
  { value: 'payments', label: 'Payments', icon: Banknote },
]

const ONE = 1000 // one unit, in thousandths

// Abbreviated units read the same in the plural: 2 kg, 960 ft.
const INVARIANT_UNITS = new Set(['kg', 'g', 'ft', 'm', 'mm', 'l', 'ml'])

function units(qtyMilli: number, unit: string): string {
  return qtyMilli === ONE || INVARIANT_UNITS.has(unit.toLowerCase()) ? unit : `${unit}s`
}

export function TillWorkspace({
  business,
  cashier,
  canOpenAdmin,
  outlets,
  items,
  order,
  preview,
}: {
  business: string
  cashier: string
  canOpenAdmin: boolean
  outlets: OutletOption[]
  items: TillItem[]
  order: TillOrder | null
  preview: boolean
}) {
  const [tab, setTab] = useState<Tab>('sale')
  const [lines, setLines] = useState<OrderLine[]>(order?.lines ?? [])
  const [sheetOpen, setSheetOpen] = useState(false)
  const outlet = outlets[0] ?? null
  const scanRef = useRef<HTMLInputElement>(null)

  // With a scanner and keyboard, the scan field always holds focus, so a scan's Enter
  // never re-presses the last tile. Touch screens skip this: it would pop the keyboard.
  function refocusScan() {
    if (window.matchMedia('(pointer: fine)').matches) scanRef.current?.focus()
  }
  useEffect(refocusScan, [])

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const { grossCents } = orderTotals(lines)

  function add(item: TillItem) {
    refocusScan()
    setLines((prev) => {
      const existing = prev.find((l) => l.itemId === item.id)
      if (existing) {
        return prev.map((l) => (l === existing ? { ...l, qtyMilli: l.qtyMilli + ONE } : l))
      }
      return [
        ...prev,
        {
          lineId: `new-${item.id}`,
          itemId: item.id,
          qtyMilli: ONE,
          unitPriceCents: item.priceCents,
          vatRateBp: item.vatRateBp,
          collectedMilli: 0,
        },
      ]
    })
  }

  function step(lineId: string, delta: number) {
    refocusScan()
    setLines((prev) =>
      prev.flatMap((l) => {
        if (l.lineId !== lineId) return [l]
        const next = l.qtyMilli + delta
        // Never below what the customer already took away.
        if (next < Math.max(l.collectedMilli, ONE)) return l.collectedMilli > 0 ? [l] : []
        return [{ ...l, qtyMilli: next }]
      }),
    )
  }

  const orderPane = (
    <OrderPane
      lines={lines}
      byId={byId}
      order={order}
      onStep={step}
      onToggleHistory={refocusScan}
    />
  )

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <StatusStrip
        business={business}
        cashier={cashier}
        outlet={outlet}
        extraOutlets={Math.max(outlets.length - 1, 0)}
        canOpenAdmin={canOpenAdmin}
      />
      {preview && (
        <p className="border-b border-rule bg-muted px-4 py-1.5 text-center text-xs font-medium text-foreground">
          Sample data for design preview. Nothing here is a real sale.
        </p>
      )}

      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
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

        {!outlet ? (
          <NoOutlet />
        ) : (
          <>
            <Tabs.Panel value="sale" className="flex min-h-0 flex-1 outline-none">
              <div className="grid min-h-0 flex-1 grid-rows-1 md:grid-cols-[minmax(0,1fr)_22rem] lg:grid-cols-[minmax(0,1fr)_26rem]">
                <ItemPicker items={items} lines={lines} onAdd={add} canOpenAdmin={canOpenAdmin} inputRef={scanRef} />
                <aside
                  aria-label="Current order"
                  className="hidden min-h-0 flex-col border-l border-rule bg-surface md:flex"
                >
                  {orderPane}
                </aside>
              </div>
            </Tabs.Panel>
            <Tabs.Panel value="orders" className="flex-1 overflow-y-auto outline-none">
              <PanelEmpty
                title="Open orders"
                body="Orders with money or goods still owed will be listed here. Find one by its number or the customer's phone."
              />
            </Tabs.Panel>
            <Tabs.Panel value="stock" className="flex-1 overflow-y-auto outline-none">
              <PanelEmpty
                title="Stock at this outlet"
                body="Look up what is on the shelf, what is owed to customers and what is free to sell."
              />
            </Tabs.Panel>
            <Tabs.Panel value="payments" className="flex-1 overflow-y-auto outline-none">
              <PanelEmpty
                title="Payments to match"
                body="M-Pesa payments that arrived without a matching order number wait here for you to attach them."
              />
            </Tabs.Panel>
          </>
        )}

        {/* Phones: the order rides above the tab bar, total and Pay under the thumb. */}
        {outlet && tab === 'sale' && (
          <Dialog.Root open={sheetOpen} onOpenChange={setSheetOpen}>
            <div className="order-[998] flex shrink-0 items-center gap-3 border-t border-rule bg-surface px-4 py-2.5 md:hidden">
              <Dialog.Trigger className="flex min-w-0 flex-1 flex-col items-start rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="text-xs text-muted-foreground">
                  {lines.length === 0 ? 'No items yet' : `${lines.length} ${lines.length === 1 ? 'item' : 'items'} · view order`}
                </span>
                <span className="figures text-lg font-semibold">{formatKes(grossCents)}</span>
              </Dialog.Trigger>
              <Button size="lg" className="h-12 px-6 text-base" disabled>
                Pay
              </Button>
            </div>
            <Dialog.Portal>
              <Dialog.Backdrop className="fixed inset-0 z-40 bg-rail/50 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
              <Dialog.Popup className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-xl bg-surface shadow-[0_-12px_40px_-12px_rgb(0_0_0/0.35)] transition-transform duration-200 ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full">
                <div className="flex items-center justify-between border-b border-rule px-4 py-2">
                  <Dialog.Title className="text-sm font-semibold">Current order</Dialog.Title>
                  <Dialog.Close
                    aria-label="Close order"
                    className="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <X aria-hidden className="size-5" />
                  </Dialog.Close>
                </div>
                {orderPane}
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </Tabs.Root>
    </div>
  )
}

function StatusStrip({
  business,
  cashier,
  outlet,
  extraOutlets,
  canOpenAdmin,
}: {
  business: string
  cashier: string
  outlet: OutletOption | null
  extraOutlets: number
  canOpenAdmin: boolean
}) {
  const quiet =
    'inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-sm text-rail-muted hover:bg-rail-raised hover:text-rail-ink focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none'
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 bg-rail px-3 text-rail-ink md:px-4">
      {outlet ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-sm bg-rail-raised px-1.5 py-0.5 font-mono text-xs font-medium">{outlet.code}</span>
          <span className="truncate text-sm font-medium">
            {outlet.name}
            {extraOutlets > 0 && <span className="text-rail-muted"> +{extraOutlets}</span>}
          </span>
        </div>
      ) : (
        <span className="truncate text-sm font-medium">{business}</span>
      )}
      <span aria-hidden className="hidden h-4 w-px bg-sidebar-border sm:block" />
      <span className="hidden truncate text-sm text-rail-muted sm:inline">{cashier}</span>
      <ConnectionStatus className="ml-1 text-rail-muted" />
      <div className="ml-auto flex items-center gap-1">
        {canOpenAdmin && (
          <Link href="/admin" className={quiet}>
            <KeyRound aria-hidden className="size-4" />
            Admin
          </Link>
        )}
        <form action={logout}>
          <button type="submit" className={quiet} aria-label="Log out">
            <LogOut aria-hidden className="size-4" />
            <span className="hidden sm:inline">Log out</span>
          </button>
        </form>
      </div>
    </header>
  )
}

function availability(item: TillItem): { text: string; tone: string } {
  const qty = `${formatQty(item.availableMilli)} ${units(item.availableMilli, item.unit)}`
  if (item.availableMilli <= 0) return { text: 'None free', tone: 'text-credit' }
  if (item.availableMilli <= item.lowStockMilli) return { text: `${qty} left`, tone: 'text-owed-ink' }
  return { text: qty, tone: 'text-muted-foreground' }
}

function ItemPicker({
  items,
  lines,
  onAdd,
  canOpenAdmin,
  inputRef,
}: {
  items: TillItem[]
  lines: OrderLine[]
  onAdd: (item: TillItem) => void
  canOpenAdmin: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
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
    ? items.filter((i) => i.code.toLowerCase().startsWith(q) || i.name.toLowerCase().includes(q))
    : items
  const inOrder = new Map(lines.map((l) => [l.itemId, l.qtyMilli]))

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
              if (e.key === 'Enter' && shown[0]) {
                e.preventDefault()
                onAdd(shown[0])
                setQuery('')
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
        {items.length === 0 ? (
          <PanelEmpty
            title="No items yet"
            body="Items and prices are set up in Admin. Once added, they show here for every till at this outlet, each with a short code for quick entry."
            action={
              canOpenAdmin ? (
                <Link href="/admin" className="text-sm font-medium text-primary hover:underline">
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
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]">
            {shown.map((item) => {
              const a = availability(item)
              const qty = inOrder.get(item.id)
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onAdd(item)}
                    className={cn(
                      'relative flex h-full min-h-[6.75rem] w-full flex-col gap-1 rounded-md border bg-surface p-2.5 text-left outline-none transition-[border-color,box-shadow] duration-150 hover:border-foreground/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:translate-y-px',
                      qty ? 'border-foreground/50 shadow-[0_1px_0_0_var(--foreground)]' : 'border-rule',
                    )}
                  >
                    <span className="font-mono text-[0.7rem] font-medium text-muted-foreground">{item.code}</span>
                    <span className="line-clamp-2 text-sm leading-snug font-medium">{item.name}</span>
                    <span className="mt-auto flex items-baseline justify-between gap-2">
                      <span className="figures text-sm font-semibold">{formatKes(item.priceCents).replace('KES ', '')}</span>
                      <span className={cn('figures truncate text-[0.7rem]', a.tone)}>{a.text}</span>
                    </span>
                    {qty !== undefined && (
                      <span className="figures absolute top-2 right-2 rounded-sm bg-foreground px-1.5 py-px text-[0.7rem] font-semibold text-background">
                        ×{formatQty(qty)}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

function OrderPane({
  lines,
  byId,
  order,
  onStep,
  onToggleHistory,
}: {
  lines: OrderLine[]
  byId: Map<string, TillItem>
  order: TillOrder | null
  onStep: (lineId: string, delta: number) => void
  /** Hands focus back to the scan field so a scan's Enter never toggles the history. */
  onToggleHistory: () => void
}) {
  const { grossCents, vatCents } = orderTotals(lines)
  const paid = order?.paidCents ?? 0
  const collected = collectedValueCents(lines)
  const latest = order?.events[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-rule px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className={cn('text-base font-semibold', order?.number && 'font-mono')}>{order?.number ?? 'New order'}</h2>
          {order?.number && <span className="text-xs text-muted-foreground">Open</span>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {order?.customer
            ? `${order.customer.name} · ${order.customer.phone}`
            : 'Walk-in. A name and phone are needed if anything is left owed.'}
        </p>
      </div>

      <div className="min-h-[7.5rem] flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            Scan or tap an item to start the order.
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {lines.map((l) => {
              const item = byId.get(l.itemId)
              const unit = item?.unit ?? 'unit'
              return (
                <li key={l.lineId} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item?.name ?? 'Item'}</p>
                    <p className="figures text-xs text-muted-foreground">
                      {formatKes(l.unitPriceCents)} / {unit}
                      {l.collectedMilli > 0 && (
                        <>
                          {' · '}
                          <span className={l.collectedMilli < l.qtyMilli ? 'text-owed-ink' : undefined}>
                            {formatQty(l.collectedMilli)} of {formatQty(l.qtyMilli)} collected
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  <p className="figures text-right text-sm font-semibold">
                    {formatKes(lineGross(l.qtyMilli, l.unitPriceCents))}
                  </p>
                  <div className="col-span-2 flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`One less ${item?.name ?? 'item'}`}
                      onClick={() => onStep(l.lineId, -ONE)}
                      disabled={l.collectedMilli > 0 && l.qtyMilli <= l.collectedMilli}
                      className="inline-flex size-10 items-center justify-center rounded-md border border-rule text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40"
                    >
                      <Minus aria-hidden className="size-4" />
                    </button>
                    <span className="figures min-w-16 text-center text-sm font-semibold" aria-live="polite">
                      {formatQty(l.qtyMilli)} <span className="font-normal text-muted-foreground">{units(l.qtyMilli, unit)}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`One more ${item?.name ?? 'item'}`}
                      onClick={() => onStep(l.lineId, ONE)}
                      className="inline-flex size-10 items-center justify-center rounded-md border border-rule text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <Plus aria-hidden className="size-4" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-rule bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Total</span>
          <span className="figures text-2xl font-semibold tracking-tight">{formatKes(grossCents)}</span>
        </div>
        <p className="figures text-right text-xs text-muted-foreground">Includes VAT {formatKes(vatCents)}</p>

        {(paid > 0 || collected > 0) && (
          <SettlementBar total={grossCents} paid={paid} collected={collected} className="mt-3" />
        )}

        {latest && order?.number && (
          <div className="mt-3 border-t border-rule">
            <ul>
              <ConfirmationLine
                compact
                c={{ code: order.number, status: latest.status, tone: latest.tone, detail: latest.detail, by: latest.by, balance: latest.balance, at: latest.at }}
                className="pb-1"
              />
            </ul>
            {order.events.length > 1 && (
              <details className="group text-xs" onToggle={onToggleHistory}>
                <summary className="cursor-pointer list-none py-1 font-medium text-primary hover:underline [&::-webkit-details-marker]:hidden">
                  <span className="group-open:hidden">
                    Show {order.events.length - 1} earlier {order.events.length === 2 ? 'event' : 'events'}
                  </span>
                  <span className="hidden group-open:inline">Hide history</span>
                </summary>
                <ol aria-label="Earlier events" className="max-h-28 divide-y divide-rule overflow-y-auto overscroll-contain">
                  {order.events.slice(1).map((e, i) => (
                    <ConfirmationLine
                      key={i}
                      c={{ code: order.number!, status: e.status, tone: e.tone, detail: e.detail, by: e.by, balance: e.balance, at: e.at }}
                      className="text-xs"
                    />
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}

        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
          <Button size="lg" className="h-12 text-base" disabled>
            Pay
          </Button>
          <Button size="lg" variant="outline" className="h-12 px-5 text-base" disabled>
            Collect
          </Button>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Taking payments and recording collections arrive with orders.
        </p>
      </div>
    </div>
  )
}

function PanelEmpty({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-14 text-center">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{body}</p>
      {action}
    </div>
  )
}

function NoOutlet() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <PanelEmpty
        title="You are not assigned to an outlet"
        body="A till always belongs to one outlet. Ask your manager or the owner to add you to one, then sign in again."
      />
    </div>
  )
}
