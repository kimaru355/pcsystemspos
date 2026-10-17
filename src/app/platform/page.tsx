import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cn } from "cn";
import { db } from "@/db/client";
import { PageHeader } from "@/components/shell/page-header";
import { getCurrentUser } from "@/server/auth/current-user";
import { listBusinesses } from "@/server/services/platform";

const dateFmt = new Intl.DateTimeFormat("en-KE", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Africa/Nairobi",
});

export default function PlatformPage() {
  return (
    <>
      <PageHeader
        title="Businesses"
        description="Every business on PC Systems POS. Create and suspend businesses with the platform command line."
      />
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <BusinessList />
      </Suspense>
    </>
  );
}

async function BusinessList() {
  // The layout guards too; pages render in parallel with it, so check here as well.
  const user = await getCurrentUser();
  if (!user?.isPlatformAdmin) redirect("/");
  const rows = await listBusinesses(db);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-input bg-surface px-6 py-10 text-center">
        <p className="font-medium">No businesses yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Run{" "}
          <code className="font-mono text-[0.85em]">
            npm run platform -- create-business
          </code>{" "}
          to add the first one.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Phones: one block per business, nothing clipped off the side. */}
      <ul className="divide-y divide-rule border-y border-rule sm:hidden">
        {rows.map((b) => (
          <li key={b.id} className="flex flex-col gap-1 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{b.name}</span>
              <Status status={b.status} />
            </div>
            <p className="figures text-xs text-muted-foreground">
              {b.outlets} {b.outlets === 1 ? "outlet" : "outlets"} · {b.staff}{" "}
              staff · since {dateFmt.format(b.createdAt)}
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border border-rule bg-surface sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs text-muted-foreground">
              <th scope="col" className="px-5 py-3 font-medium">
                Business
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-5 py-3 text-right font-medium">
                Outlets
              </th>
              <th scope="col" className="px-5 py-3 text-right font-medium">
                Staff
              </th>
              <th scope="col" className="px-5 py-3 text-right font-medium">
                Since
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((b) => (
              <tr key={b.id}>
                <td className="px-5 py-3 font-medium">{b.name}</td>
                <td className="px-5 py-3">
                  <Status status={b.status} />
                </td>
                <td className="px-5 py-3 text-right">{b.outlets}</td>
                <td className="px-5 py-3 text-right">{b.staff}</td>
                <td className="px-5 py-3 text-right text-muted-foreground">
                  {dateFmt.format(b.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Status({ status }: { status: "active" | "suspended" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-px text-xs font-medium",
        status === "active"
          ? "bg-muted text-foreground"
          : "bg-foreground text-background",
      )}
    >
      {status === "active" ? "Active" : "Suspended"}
    </span>
  );
}
