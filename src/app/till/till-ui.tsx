'use client'

import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { cn } from 'cn'
import { formatQty, parseMoney, parseQty, type Cents, type Milli } from '@/domain/money'

/* Small building blocks shared by the till screens. */

export const ONE = 1000 // one unit, in thousandths

// Abbreviated units read the same in the plural: 2 kg, 960 ft.
const INVARIANT_UNITS = new Set(['kg', 'g', 'ft', 'm', 'mm', 'l', 'ml'])

export function units(qtyMilli: number, unit: string): string {
  return qtyMilli === ONE || INVARIANT_UNITS.has(unit.toLowerCase()) ? unit : `${unit}s`
}

export function qtyText(qtyMilli: Milli, unit: string): string {
  return `${formatQty(qtyMilli)} ${units(qtyMilli, unit)}`
}

export const fieldClass =
  'h-11 w-full rounded-md border border-input bg-surface px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive'

export const labelClass = 'text-sm font-medium'

export function parseMoneyOrNull(s: string): Cents | null {
  try {
    return parseMoney(s)
  } catch {
    return null
  }
}

export function parseQtyOrNull(s: string): Milli | null {
  try {
    return parseQty(s)
  } catch {
    return null
  }
}

export function ErrorText({ children, id }: { children: React.ReactNode; id?: string }) {
  if (!children) return null
  return (
    <p id={id} role="alert" className="text-sm font-medium text-destructive">
      {children}
    </p>
  )
}

/** Bottom sheet on phones, centred dialog from `md` up. */
export function Modal({
  open,
  onOpenChange,
  title,
  children,
  wide = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-rail/50 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-xl bg-surface shadow-[0_-12px_40px_-12px_rgb(0_0_0/0.35)] outline-none transition-transform duration-200 ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full',
            'md:inset-x-auto md:top-1/2 md:bottom-auto md:left-1/2 md:w-full md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:data-[ending-style]:translate-y-[-45%] md:data-[ending-style]:opacity-0 md:data-[starting-style]:translate-y-[-45%] md:data-[starting-style]:opacity-0',
            wide ? 'md:max-w-2xl' : 'md:max-w-md',
          )}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-rule px-4 py-2">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X aria-hidden className="size-5" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** A number field holding its own text, reporting a parsed value (null while invalid). */
export function AmountField({
  id,
  label,
  initial,
  onValue,
  hint,
  kind = 'money',
  autoFocus,
}: {
  id: string
  label: string
  initial: string
  onValue: (v: number | null) => void
  hint?: string
  kind?: 'money' | 'qty'
  autoFocus?: boolean
}) {
  const [text, setText] = useState(initial)
  const parse = kind === 'money' ? parseMoneyOrNull : parseQtyOrNull
  const invalid = text.trim() !== '' && parse(text) === null
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        autoFocus={autoFocus}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value)
          onValue(e.target.value.trim() === '' ? null : parse(e.target.value))
        }}
        className={cn(fieldClass, 'figures')}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function PanelEmpty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-14 text-center">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{body}</p>
      {action}
    </div>
  )
}

/** Full-screen centred card used before the till is unlocked. */
export function TillCard({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <div className="h-12 shrink-0 bg-rail" />
      <main className="flex flex-1 items-start justify-center px-4 py-8 md:items-center">
        <div className="w-full max-w-md rounded-xl border border-rule bg-surface p-5 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          <div className="mt-4 flex flex-col gap-4">{children}</div>
        </div>
      </main>
      {footer && <div className="px-4 pb-6 text-center text-xs text-muted-foreground">{footer}</div>}
    </div>
  )
}
