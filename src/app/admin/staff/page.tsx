import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/page-header'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { listOutlets } from '@/server/services/outlets'
import { listStaff } from '@/server/services/staff'
import { requireTenant } from '@/server/tenant'
import { CreateStaffForm, StaffRow } from './staff-forms'

export default function StaffPage() {
  return (
    <>
      <PageHeader title="Staff" />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <StaffContent />
      </Suspense>
    </>
  )
}

async function StaffContent() {
  const ctx = await requireTenant()
  const [staff, outlets] = await Promise.all([listStaff(db, ctx), listOutlets(db, ctx)])
  const canManage = can(ctx.role, 'staff.manage')
  const outletOptions = outlets.filter((o) => o.active).map((o) => ({ id: o.id, label: `${o.code} · ${o.name}` }))
  const outletCodes = Object.fromEntries(outlets.map((o) => [o.id, o.code]))

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="list-heading" className="flex flex-col gap-3">
        <h2 id="list-heading" className="text-lg font-medium">
          {canManage ? 'Your team' : 'Your outlet team'}
        </h2>
        {staff.length === 0 && <p className="text-sm text-muted-foreground">No staff yet.</p>}
        {staff.map((member) => (
          <StaffRow
            key={member.membershipId}
            member={member}
            outletOptions={outletOptions}
            outletCodes={outletCodes}
            isSelf={member.membershipId === ctx.membershipId}
            canManage={canManage}
          />
        ))}
      </section>

      {canManage && (
        <section aria-labelledby="create-heading" className="flex flex-col gap-3">
          <h2 id="create-heading" className="text-lg font-medium">
            Add a staff member
          </h2>
          <CreateStaffForm outletOptions={outletOptions} />
        </section>
      )}
    </div>
  )
}
