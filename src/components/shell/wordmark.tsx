import { cn } from 'cn'

/** Product mark: the platform name, set like a sender ID. */
export function Wordmark({ className, tone = 'rail' }: { className?: string; tone?: 'rail' | 'ink' }) {
  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-1.5 font-semibold tracking-tight',
        tone === 'rail' ? 'text-rail-ink' : 'text-foreground',
        className,
      )}
    >
      PC Systems
      <span
        className={cn(
          'rounded-sm px-1 py-px font-mono text-[0.7em] font-medium tracking-normal',
          tone === 'rail' ? 'bg-rail-raised text-rail-ink' : 'bg-foreground text-background',
        )}
      >
        POS
      </span>
    </span>
  )
}
