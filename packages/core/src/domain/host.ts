/** Host — a machine an Agent Runtime can run on (requirements §7.1). */
export interface Host {
  id: string
  name: string
  type: 'local' | 'ssh'
  status: 'offline' | 'connecting' | 'online' | 'error'
  platform?: string
  arch?: string
  serverVersion?: string
  protocolVersion?: number
}
