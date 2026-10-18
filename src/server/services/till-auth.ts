import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import { membershipOutlets, memberships, users } from '@/db/schema'
import { createPinVerifier, isValidPin } from '@/domain/pin'
import type { Role } from '@/domain/permissions'
import type { TillStaff } from '@/domain/till-data'
import { checkCredentials } from '@/server/auth/login'
import { completeAttempt, reserveAttempt } from '@/server/auth/lockout'
import { hashSecret, verifySecret } from '@/server/auth/secret'
import { DomainError } from '@/server/errors'
import { recordAudit } from './audit'
import type { DeviceAuth } from './devices'

/*
 * People on a till. The first sign-in on a device is online with password and PIN (a person
 * without a PIN chooses one here). After that the till unlocks offline with the PIN, checked
 * against the PBKDF2 verifier this module keeps in step with the argon2 PIN hash.
 */

/** "Allowed at the outlet": owners everywhere, others when assigned to it. */
function allowedAtOutlet(outletId: string) {
  return or(
    eq(memberships.role, 'owner'),
    // Spelled out: Drizzle leaves column names unqualified in single-table selects.
    sql`exists (select 1 from "membership_outlets" mo
      where mo.membership_id = "memberships"."id" and mo.outlet_id = ${outletId})`,
  )!
}

/** Active members of the device's business allowed at its outlet, with their offline PIN verifier. */
export async function staffForDevice(db: Db | Tx, device: DeviceAuth): Promise<TillStaff[]> {
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      role: memberships.role,
      pinSalt: memberships.pinSalt,
      pinVerifier: memberships.pinVerifier,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.businessId, device.businessId),
        eq(memberships.active, true),
        allowedAtOutlet(device.outletId),
      ),
    )
    .orderBy(asc(memberships.id))
  return rows.map((r) => ({
    membershipId: r.membershipId,
    userId: r.userId,
    name: r.name,
    role: r.role,
    pin: r.pinSalt && r.pinVerifier ? { salt: r.pinSalt, verifier: r.pinVerifier } : null,
  }))
}

const SIGN_IN_FAILED = 'Wrong phone/email, password or PIN.'

/**
 * First sign-in of a person on a till (online). Returns the person as the till keeps them.
 * Sets the PIN when they have none; otherwise the PIN must match.
 */
export async function tillSignIn(
  db: Db,
  device: DeviceAuth,
  input: { identifier: string; password: string; pin: string },
): Promise<TillStaff> {
  if (!isValidPin(input.pin)) throw new DomainError('invalid_input', 'The PIN must be 4 to 6 digits.')
  const cred = await checkCredentials(db, { identifier: input.identifier, password: input.password })
  if (!cred.ok) {
    throw new DomainError(
      'forbidden',
      cred.reason === 'locked' ? 'Too many attempts. Try again in 15 minutes.' : SIGN_IN_FAILED,
    )
  }
  if (cred.mustChangePassword) {
    throw new DomainError('forbidden', 'Change your temporary password first: sign in on the web, then come back.')
  }
  const [m] = await db
    .select({ id: memberships.id, pinHash: memberships.pinHash })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, cred.userId),
        eq(memberships.businessId, device.businessId),
        eq(memberships.active, true),
        allowedAtOutlet(device.outletId),
      ),
    )
  if (!m) throw new DomainError('forbidden', `You are not assigned to ${device.outletName}.`)

  if (m.pinHash) {
    const reservation = await reserveAttempt(db, `pin:${m.id}`)
    if (reservation.locked) throw new DomainError('forbidden', 'Too many attempts. Try again in 15 minutes.')
    if (!(await verifySecret(m.pinHash, input.pin))) throw new DomainError('forbidden', SIGN_IN_FAILED)
    await completeAttempt(db, reservation.attemptId)
  }
  const verifier = await createPinVerifier(input.pin)
  await db.transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({
        ...(m.pinHash ? {} : { pinHash: await hashSecret(input.pin) }),
        pinSalt: verifier.salt,
        pinVerifier: verifier.verifier,
      })
      .where(eq(memberships.id, m.id))
    if (!m.pinHash) {
      // Never record the PIN or its hash.
      await recordAudit(tx, {
        businessId: device.businessId,
        actorUserId: cred.userId,
        action: 'staff.set_own_pin',
        entityType: 'membership',
        entityId: m.id,
        deviceId: device.deviceId,
      })
    }
  })
  const staff = await staffForDevice(db, device)
  const me = staff.find((s) => s.membershipId === m.id)
  if (!me) throw new DomainError('forbidden', SIGN_IN_FAILED)
  return me
}

export type OpActor = { membershipId: string; userId: string; name: string; role: Role; active: boolean }

/**
 * Members of the device's business by membership id (active or not: an op recorded offline by
 * someone deactivated since is still applied). Ids from elsewhere are simply missing.
 */
export async function membersById(db: Db | Tx, businessId: string, ids: string[]): Promise<Map<string, OpActor>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      role: memberships.role,
      active: memberships.active,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.businessId, businessId), inArray(memberships.id, unique)))
  return new Map(rows.map((r) => [r.membershipId, r]))
}

/** Whether a member may act at the outlet now: owners everywhere, others when assigned. */
export async function isAllowedAtOutlet(db: Db | Tx, membershipId: string, role: Role, outletId: string): Promise<boolean> {
  if (role === 'owner') return true
  const [row] = await db
    .select({ one: sql`1` })
    .from(membershipOutlets)
    .where(and(eq(membershipOutlets.membershipId, membershipId), eq(membershipOutlets.outletId, outletId)))
  return !!row
}
