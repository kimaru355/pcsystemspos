import { cn } from 'cn'
import { formatKes, type Cents } from '@/domain/money'

function Track({
  label,
  fill,
  over,
  left,
  right,
}: {
  label: string
  fill: { pct: number; className: string }
  over?: { from: number; pct: number }
  left: React.ReactNode
  right: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[3.75rem_1fr] items-center gap-x-3 gap-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div aria-hidden className="relative h-2.5 overflow-hidden rounded-sm bg-muted">
        <div className={cn('absolute inset-y-0 left-0', fill.className)} style={{ width: `${fill.pct}%` }} />
        {over && (
          <div className="absolute inset-y-0 bg-credit" style={{ left: `${over.from}%`, width: `${over.pct}%` }} />
        )}
      </div>
      <span />
      <div className="figures flex items-baseline justify-between gap-3 text-xs">
        {left}
        {right}
      </div>
    </div>
  )
}

/**
 * Money and goods on one measure: each track's length is exact value against the order
 * total. Goods handed over beyond what was paid are credit, in the credit colour.
 * Renders nothing for an empty order; callers say so in words.
 */
export function SettlementBar({
  total,
  paid,
  collected,
  className,
}: {
  total: Cents
  paid: Cents
  collected: Cents
  className?: string
}) {
  if (total <= 0) return null
  const pct = (v: Cents) => Math.min(100, Math.max(0, (v / total) * 100))
  const credit = Math.max(0, collected - paid)
  const owedMoney = Math.max(0, total - paid)
  const toCollect = Math.max(0, total - collected)
  const summary = `Paid ${formatKes(paid)} of ${formatKes(total)}, ${formatKes(owedMoney)} owed. Goods worth ${formatKes(
    collected,
  )} collected, ${formatKes(toCollect)} still to collect.${credit > 0 ? ` ${formatKes(credit)} on credit.` : ''}`

  return (
    <div role="img" aria-label={summary} className={cn('flex flex-col gap-2.5', className)}>
      <Track
        label="Money"
        fill={{ pct: pct(paid), className: 'bg-paid' }}
        left={
          <span>
            <span className="text-muted-foreground">Paid </span>
            <span className="font-semibold text-paid">{formatKes(paid)}</span>
          </span>
        }
        right={
          <span>
            <span className="text-muted-foreground">Owed </span>
            <span className={cn('font-semibold', owedMoney > 0 ? 'text-owed-ink' : 'text-foreground')}>
              {formatKes(owedMoney)}
            </span>
          </span>
        }
      />
      <Track
        label="Goods"
        fill={{ pct: pct(Math.min(collected, paid)), className: 'bg-foreground' }}
        over={credit > 0 ? { from: pct(paid), pct: pct(collected) - pct(paid) } : undefined}
        left={
          <span>
            <span className="text-muted-foreground">Collected </span>
            <span className="font-semibold">{formatKes(collected)}</span>
          </span>
        }
        right={
          credit > 0 ? (
            <span>
              <span className="text-muted-foreground">On credit </span>
              <span className="font-semibold text-credit">{formatKes(credit)}</span>
            </span>
          ) : (
            <span>
              <span className="text-muted-foreground">To collect </span>
              <span className="font-semibold">{formatKes(toCollect)}</span>
            </span>
          )
        }
      />
    </div>
  )
}
