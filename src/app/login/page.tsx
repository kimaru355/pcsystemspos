import { Suspense } from 'react'
import { LoginForm } from './login-form'

export default function LoginPage({ searchParams }: PageProps<'/login'>) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Log in</h1>
      <Suspense>
        <NoAccessNotice searchParams={searchParams} />
      </Suspense>
      <LoginForm />
    </main>
  )
}

async function NoAccessNotice({ searchParams }: { searchParams: PageProps<'/login'>['searchParams'] }) {
  const { error } = await searchParams
  if (error !== 'no-access') return null
  return (
    <p role="alert" className="max-w-sm text-center text-sm text-destructive">
      Your account doesn&apos;t have access. Contact your administrator.
    </p>
  )
}
