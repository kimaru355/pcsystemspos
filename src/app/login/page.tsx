import { LoginForm } from './login-form'

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Log in</h1>
      <LoginForm />
    </main>
  )
}
