'use server'

import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { changePassword } from '@/server/auth/login'
import { getCurrentUser } from '@/server/auth/current-user'
import { DomainError } from '@/server/errors'

export interface ChangePasswordState {
  message: string
}

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const current = String(formData.get('current') ?? '')
  const next = String(formData.get('next') ?? '')
  const confirm = String(formData.get('confirm') ?? '')
  if (next !== confirm) return { message: 'New passwords do not match.' }

  try {
    await changePassword(db, user.id, current, next)
  } catch (e) {
    if (e instanceof DomainError) {
      if (e.code === 'forbidden') return { message: 'Current password is incorrect.' }
      if (e.code === 'invalid_input') return { message: e.message }
    }
    throw e
  }
  redirect('/')
}
