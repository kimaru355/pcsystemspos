import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/server/auth/current-user'
import { ChangePasswordForm } from './change-password-form'

export default function ChangePasswordPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Change password</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <ChangePasswordContent />
      </Suspense>
    </main>
  )
}

async function ChangePasswordContent() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return <ChangePasswordForm />
}
