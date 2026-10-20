'use client'

import { Button } from '@/components/ui/button'
import { Field, Message, useKeptForm } from '../_forms/form-kit'
import { registerC2BAction, saveMpesaAction } from './actions'

export type MpesaFormValues = {
  outletId: string | null
  environment: 'sandbox' | 'production'
  shortcodeType: 'paybill' | 'till'
  shortcode: string
  partyB: string
  active: boolean
} | null

export function MpesaConfigForm({ id, outletId, saved }: { id: string; outletId: string | null; saved: MpesaFormValues }) {
  const f = useKeptForm(saveMpesaAction)
  const err = f.state.errors ?? {}
  const keep = saved ? 'Leave blank to keep the saved value.' : undefined
  return (
    <form key={f.nonce} action={f.action} noValidate className="flex flex-col gap-3">
      <input type="hidden" name="outletId" value={outletId ?? ''} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-env`} label="Environment" error={err.environment}>
          {(p) => (
            <select {...p} name="environment" defaultValue={f.text('environment', saved?.environment ?? 'sandbox')}>
              <option value="sandbox">Sandbox (testing)</option>
              <option value="production">Production (real money)</option>
            </select>
          )}
        </Field>
        <Field id={`${id}-type`} label="Type" error={err.shortcodeType}>
          {(p) => (
            <select {...p} name="shortcodeType" defaultValue={f.text('shortcodeType', saved?.shortcodeType ?? 'paybill')}>
              <option value="paybill">Paybill</option>
              <option value="till">Till (buy goods)</option>
            </select>
          )}
        </Field>
        <Field id={`${id}-code`} label="Business shortcode" hint="The store or paybill number from the Daraja portal." error={err.shortcode}>
          {(p) => <input {...p} name="shortcode" inputMode="numeric" defaultValue={f.text('shortcode', saved?.shortcode ?? '')} className={`${p.className} figures`} />}
        </Field>
        <Field id={`${id}-partyb`} label="Paybill or till number" hint="Where the money goes. Blank means the same as the shortcode." error={err.partyB}>
          {(p) => <input {...p} name="partyB" inputMode="numeric" defaultValue={f.text('partyB', saved?.partyB ?? '')} className={`${p.className} figures`} />}
        </Field>
        <Field id={`${id}-ck`} label="Consumer key" hint={keep} error={err.consumerKey}>
          {(p) => <input {...p} name="consumerKey" type="password" autoComplete="off" />}
        </Field>
        <Field id={`${id}-cs`} label="Consumer secret" hint={keep} error={err.consumerSecret}>
          {(p) => <input {...p} name="consumerSecret" type="password" autoComplete="off" />}
        </Field>
        <Field id={`${id}-pk`} label="Passkey" hint={keep} error={err.passkey}>
          {(p) => <input {...p} name="passkey" type="password" autoComplete="off" />}
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={f.checked('active', saved?.active ?? true)} />
          Use these settings
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={f.pending}>
          {f.pending ? 'Saving…' : 'Save M-Pesa settings'}
        </Button>
        <Message state={f.state} />
      </div>
    </form>
  )
}

export function RegisterC2BForm({ configId }: { configId: string }) {
  const f = useKeptForm(registerC2BAction)
  return (
    <form key={f.nonce} action={f.action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="configId" value={configId} />
      <Button type="submit" variant="outline" disabled={f.pending}>
        {f.pending ? 'Registering…' : 'Register with Safaricom'}
      </Button>
      <Message state={f.state} />
    </form>
  )
}
