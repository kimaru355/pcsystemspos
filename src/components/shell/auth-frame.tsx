import { Wordmark } from './wordmark'

/** Sign-in and password screens: the rail colour on one side, the form on the other. */
export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid min-h-dvh flex-1 grid-rows-[auto_1fr] md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:grid-rows-none">
      <div className="flex flex-col justify-between gap-10 bg-rail px-6 py-6 text-rail-ink md:px-10 md:py-10">
        <Wordmark className="text-lg" />
        <p className="hidden max-w-sm text-2xl leading-snug font-medium tracking-tight text-rail-ink md:block">
          Sell, take payment and hand over goods at every outlet, and always know what is still owed.
        </p>
        <p className="hidden text-xs text-rail-muted md:block">Point of sale and stock for hardware shops.</p>
      </div>
      <main className="flex items-start justify-center px-6 py-10 md:items-center md:py-16">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}
