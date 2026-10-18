import type { Metadata } from 'next'
import { TillApp } from './till-app'

export const metadata: Metadata = { title: 'Till · PC Systems POS' }

/** Static shell: everything the till shows comes from the device's own database. */
export default function TillPage() {
  return <TillApp />
}
