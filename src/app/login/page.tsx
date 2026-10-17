import { Suspense } from 'react'
import { AuthFrame } from '@/components/shell/auth-frame'
import { LoginForm } from './login-form'

export default function LoginPage({ searchParams }: PageProps<'/login'>) {
  return (
    <AuthFrame title="Log in" description="Use the phone number or email your business gave you.">
      <Suspense>
        <NoAccessNotice searchParams={searchParams} />
      </Suspense>
      <LoginForm />
    </AuthFrame>
  )
}

async function NoAccessNotice({ searchParams }: { searchParams: PageProps<'/login'>['searchParams'] }) {
  const { error } = await searchParams
  if (error !== 'no-access') return null
  return (
    <p role="alert" className="rounded-md border border-credit/30 bg-credit-soft px-3 py-2.5 text-sm text-credit">
      Your account doesn&apos;t have access. Contact your administrator.
    </p>
  )
}
