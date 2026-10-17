/** Neutral only: active is ink on the pale wash, inactive is inverted. */
export function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block rounded-sm px-1.5 py-0.5 text-xs font-medium ${
        active ? 'bg-muted text-foreground' : 'bg-foreground text-background'
      }`}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  )
}
