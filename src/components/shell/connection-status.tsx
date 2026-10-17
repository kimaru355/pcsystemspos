'use client'

import { useSyncExternalStore } from 'react'
import { Wifi, WifiOff } from 'lucide-react'
import { cn } from 'cn'

function subscribe(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

/** Offline is a normal state at the counter, never an error: it says what still works. */
export function ConnectionStatus({ className }: { className?: string }) {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  )
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-xs', className)}>
      {online ? (
        <Wifi aria-hidden className="size-3.5" />
      ) : (
        <WifiOff aria-hidden className="size-3.5" />
      )}
      {online ? 'Online' : 'Offline'}
    </span>
  )
}
