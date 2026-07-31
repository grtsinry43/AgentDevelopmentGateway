/**
 * Capability — describes WHERE a capability runs (host placement), e.g. an MCP
 * server, a proxy, a terminal, a forwarded port (requirements §7.4).
 *
 * NOTE: this is distinct from `RuntimeCapability` in `domain/descriptor.ts`, which
 * describes which FEATURES an Agent runtime supports (session.fork, mode.plan, …).
 * `Capability` = host placement; `RuntimeCapability` = adapter feature negotiation.
 */
export type CapabilityPlacement = 'local' | 'remote' | 'hosted'

export interface Capability {
  id: string
  name: string
  type: 'mcp' | 'credential' | 'proxy' | 'terminal' | 'port' | 'ide'
  placement: CapabilityPlacement
  hostId?: string
  status: 'online' | 'offline' | 'connecting' | 'error'
}
