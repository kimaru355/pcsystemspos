/** Unboxed admin region: a one-pixel rule above, the heading, then the content. */
export function Region({
  id,
  title,
  aside,
  size = 'lg',
  children,
}: {
  id: string
  title: string
  aside?: React.ReactNode
  size?: 'lg' | 'sm'
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="border-t border-foreground/80 pt-3">
      <div className="flex items-baseline justify-between gap-4 pb-2">
        <h2 id={id} className={size === 'lg' ? 'text-lg font-semibold' : 'text-sm font-semibold'}>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}
