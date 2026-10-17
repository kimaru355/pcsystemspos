import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { AuthFrame } from '@/components/shell/auth-frame'
import { getCurrentUser } from '@/server/auth/current-user'
import { ChangePasswordForm } from './change-password-form'

export default function ChangePasswordPage() {
  return (
    <AuthFrame
      title="Change password"
      description="Choose your own password before you continue. You will use it to sign in on new devices."
    >
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <ChangePasswordContent />
      </Suspense>
    </AuthFrame>
  )
}

async function ChangePasswordContent() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return <ChangePasswordForm />
}
