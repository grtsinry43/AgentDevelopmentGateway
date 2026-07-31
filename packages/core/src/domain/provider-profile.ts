/**
 * ProviderProfile — model / auth / endpoint config (requirements §7.6).
 * Orthogonal to RuntimeAdapter: e.g. the claude-code adapter can run against the
 * official Anthropic config OR a CC-Switch profile.
 */
export interface ProviderProfile {
  id: string
  name: string
  source: 'native' | 'cc-switch' | 'environment' | 'custom'
  model?: string
  endpoint?: string
}
