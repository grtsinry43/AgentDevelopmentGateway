/** Long-term memory item with explicit scope, source and lifecycle (§7.5, §13). */
export type MemoryScope =
  | 'personal'
  | 'organization'
  | 'project'
  | 'host'
  | 'session'

export interface MemoryItem {
  id: string
  scope: MemoryScope
  scopeId?: string
  content: string
  source: string
  confidence?: number
  status: 'active' | 'archived' | 'needs-review'
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}
