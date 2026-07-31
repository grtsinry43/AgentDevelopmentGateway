import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { GatewayDatabase } from '../../infrastructure/database.js'

const identityRowSchema = z.strictObject({
  id: z.string().uuid(),
  created_at: z.number().int().nonnegative()
})

export interface ServerIdentity {
  id: string
  createdAt: number
}

export class ServerIdentityRepository {
  constructor(private readonly database: GatewayDatabase) {}

  getOrCreate(): ServerIdentity {
    const existing = this.database
      .prepare('SELECT id, created_at FROM server_identity WHERE singleton_key = 1')
      .get()
    if (existing) return mapIdentity(existing)

    const identity = { id: randomUUID(), createdAt: Date.now() }
    this.database
      .prepare(
        'INSERT INTO server_identity (singleton_key, id, created_at) VALUES (1, ?, ?)'
      )
      .run(identity.id, identity.createdAt)
    return identity
  }
}

function mapIdentity(row: unknown): ServerIdentity {
  const parsed = identityRowSchema.parse(row)
  return { id: parsed.id, createdAt: parsed.created_at }
}
