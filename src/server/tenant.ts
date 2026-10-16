import { cache } from 'react'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { db, type Db } from '@/db/client'
import { businesses, membershipOutlets, memberships } from '@/db/schema'
import { can, type Action, type Role } from '@/domain/permissions'
import { getCurrentUser } from '@/server/auth/current-user'
import { DomainError } from '@/server/errors'

export type { Action, Role }

export type TenantCtx = {
  userId: string
  businessId: string
  membershipId: string
  role: Role
  /** Owners see every outlet; everyone else only the outlets they are assigned to. */
  outletScope: 'all' | string[]
}

/**
 * Resolves the tenant a user acts in. `null` when the user has no membership, the
 * membership is inactive, or the business is suspended (platform admins have no membership).
 */
export async function getTenantCtx(db: Db, userId: string): Promise<TenantCtx | null> {
  const [row] = await db
    .select({
      membershipId: memberships.id,
      businessId: memberships.businessId,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(businesses, eq(businesses.id, memberships.businessId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.active, true),
        eq(businesses.status, 'active'),
      ),
    )
  if (!row) return null

  let outletScope: TenantCtx['outletScope'] = 'all'
  if (row.role !== 'owner') {
    const assigned = await db
      .select({ outletId: membershipOutlets.outletId })
      .from(membershipOutlets)
      .where(eq(membershipOutlets.membershipId, row.membershipId))
    outletScope = assigned.map((a) => a.outletId)
  }
  return {
    userId,
    businessId: row.businessId,
    membershipId: row.membershipId,
    role: row.role,
    outletScope,
  }
}

/**
 * Next-only guard for tenant pages (request-time: call inside <Suspense>).
 * No session -> /login. Password change pending -> /change-password. A signed-in user
 * with no usable tenant (inactive membership / suspended business) is signed out by
 * /logout/no-access (cookies can only be cleared in a route handler, not during render)
 * and lands on /login?error=no-access; platform admins go to /platform instead.
 */
export const requireTenant = cache(async (): Promise<TenantCtx> => {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')
  const ctx = await getTenantCtx(db, user.id)
  if (!ctx) redirect(user.isPlatformAdmin ? '/platform' : '/logout/no-access')
  return ctx
})

export function assertCan(ctx: TenantCtx, action: Action): void {
  if (!can(ctx.role, action)) throw new DomainError('forbidden')
}
