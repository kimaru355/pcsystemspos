export const CONNECTION_MODES = ['full_offline', 'default', 'always_online'] as const
export type ConnectionMode = (typeof CONNECTION_MODES)[number]

export const MODE_LABELS: Record<ConnectionMode, string> = {
  full_offline: 'Full offline',
  default: 'Default',
  always_online: 'Always online',
}
