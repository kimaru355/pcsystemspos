import { cn } from 'cn'

export type ConfirmationTone = 'paid' | 'owed' | 'credit' | 'neutral'

const TONE_TEXT: Record<ConfirmationTone, string> = {
  paid: 'text-paid',
  owed: 'text-owed-ink',
  credit: 'text-credit',
  neutral: 'text-foreground',
}

export type Confirmation = {
  /** Leads the line, like a transaction code: order number, outlet code, staff initials. */
  code: string
  /** Past-tense status word: "Paid", "Collected", "Outlet created". */
  status: string
  tone?: ConfirmationTone
  /** The rest of the sentence. */
  detail?: React.ReactNode
  /** Who did it. */
  by?: string
  /** A Date, or an already formatted time from the till. */
  at: Date | string
  /** The new balance, always last: what is still owed after this event. */
  balance?: React.ReactNode
}

const timeFmt = new Intl.DateTimeFormat('en-KE', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Nairobi',
})
const dayFmt = new Intl.DateTimeFormat('en-KE', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Africa/Nairobi',
})

function stamp(at: Date | string, now: Date): string {
  if (typeof at === 'string') return at
  const sameDay = dayFmt.format(at) === dayFmt.format(now)
  return sameDay ? timeFmt.format(at) : `${dayFmt.format(at)} ${timeFmt.format(at)}`
}

/**
 * The signature line: every money, goods or setup event confirmed in one row,
 * code first and the new balance last.
 */
export function ConfirmationLine({
  c,
  now = new Date(),
  compact = false,
  className,
}: {
  c: Confirmation
  now?: Date
  /** Two tight rows: status and who, then the new balance (never cut) with the detail truncating after it. */
  compact?: boolean
  className?: string
}) {
  return (
    <li className={cn(
      'grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 gap-y-0.5 py-2.5 text-sm',
      className,
    )}>
      <span className="font-mono text-[0.8rem] font-medium text-foreground">{c.code}</span>
      {compact ? (
        <p className="min-w-0 truncate text-foreground">
          <span className={cn('font-semibold', TONE_TEXT[c.tone ?? 'neutral'])}>{c.status}.</span>
          {c.by && <span className="text-muted-foreground"> By {c.by}.</span>}
        </p>
      ) : (
        <p className="min-w-0 text-foreground">
          <span className={cn('font-semibold', TONE_TEXT[c.tone ?? 'neutral'])}>{c.status}.</span>{' '}
          {c.detail}
          {c.by && <span className="text-muted-foreground"> By {c.by}.</span>}
          {c.balance && <span className="font-medium"> {c.balance}</span>}
        </p>
      )}
      <time
        dateTime={typeof c.at === 'string' ? undefined : c.at.toISOString()}
        className="figures text-xs whitespace-nowrap text-muted-foreground"
      >
        {stamp(c.at, now)}
      </time>
      {compact && (c.balance || c.detail) && (
        <p className="col-start-2 col-end-4 flex min-w-0 items-baseline gap-1.5">
          {c.balance && <span className="shrink-0 font-medium">{c.balance}</span>}
          {c.detail && (
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={typeof c.detail === 'string' ? c.detail : undefined}
            >
              {c.detail}
            </span>
          )}
        </p>
      )}
    </li>
  )
}

export function ConfirmationThread({
  items,
  label,
  className,
}: {
  items: Confirmation[]
  label: string
  className?: string
}) {
  const now = new Date()
  return (
    <ol aria-label={label} className={cn('divide-y divide-rule', className)}>
      {items.map((c, i) => (
        <ConfirmationLine key={i} c={c} now={now} />
      ))}
    </ol>
  )
}
