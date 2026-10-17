'use client'

import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Menu, X } from 'lucide-react'
import { RailNav } from './nav-link'
import type { NavKey } from './nav-config'
import { Wordmark } from './wordmark'

/** Below md the rail folds into a sheet opened from the top bar. */
export function MobileNav({ nav, footer }: { nav: NavKey; footer?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label="Open menu"
        className="-ml-2 inline-flex size-10 items-center justify-center rounded-md text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:hidden"
      >
        <Menu aria-hidden className="size-5" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-rail/50 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-6 overflow-y-auto bg-rail p-4 text-rail-ink shadow-[8px_0_32px_-8px_rgb(0_0_0/0.35)] transition-transform duration-200 ease-out data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full">
          <div className="flex items-center justify-between">
            <Dialog.Title render={<span />}>
              <Wordmark />
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close menu"
              className="inline-flex size-10 items-center justify-center rounded-md text-rail-muted hover:bg-rail-raised hover:text-rail-ink focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
            >
              <X aria-hidden className="size-5" />
            </Dialog.Close>
          </div>
          <RailNav nav={nav} onNavigate={() => setOpen(false)} />
          {footer && <div className="mt-auto">{footer}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
