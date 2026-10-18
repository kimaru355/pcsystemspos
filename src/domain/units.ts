// Abbreviated units read the same in the plural: 2 kg, 960 ft.
const INVARIANT_UNITS = new Set(['kg', 'g', 'ft', 'm', 'mm', 'l', 'ml'])

/** "bag" or "bags" for a quantity in thousandths. */
export function unitLabel(qtyMilli: number, unit: string): string {
  return qtyMilli === 1000 || INVARIANT_UNITS.has(unit.toLowerCase()) ? unit : `${unit}s`
}
