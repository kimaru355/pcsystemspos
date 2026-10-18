'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Message, useKeptForm } from '../_forms/form-kit'
import { revokeDeviceAction } from './actions'

/** Revoke asks once more before it acts: a revoked till must be set up again to sell. */
export function RevokeDevice({ deviceId, label }: { deviceId: string; label: string }) {
  const f = useKeptForm(revokeDeviceAction)
  const [confirming, setConfirming] = useState(false)
  if (!confirming && !f.state.message) {
    return (
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Revoke
      </Button>
    )
  }
  return (
    <form key={f.nonce} action={f.action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="deviceId" value={deviceId} />
      {!f.state.ok && (
        <>
          <span className="text-sm">Revoke {label}?</span>
          <Button type="submit" variant="destructive" size="sm" disabled={f.pending}>
            {f.pending ? 'Revoking…' : 'Yes, revoke'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </>
      )}
      <Message state={f.state} />
    </form>
  )
}
