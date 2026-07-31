import type { Project } from '@agent-gateway/core'
import { z } from 'zod'
import type { GatewayDatabase } from '../../infrastructure/database.js'

const projectRowSchema = z.strictObject({
  id: z.string().uuid(),
  host_id: z.string().uuid(),
  path: z.string().min(1),
  normalized_path: z.string().min(1),
  name: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  archived_at: z.number().int().nonnegative().nullable()
})

export interface StoredProject extends Project {
  normalizedPath: string
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export class ProjectRepository {
  constructor(private readonly database: GatewayDatabase) {}

  create(project: StoredProject): void {
    this.database
      .prepare(
        `INSERT INTO projects (
          id, host_id, path, normalized_path, name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.id,
        project.hostId,
        project.path,
        project.normalizedPath,
        project.name,
        project.createdAt,
        project.updatedAt
      )
  }

  findById(id: string): StoredProject | undefined {
    const row = this.database
      .prepare(
        `SELECT id, host_id, path, normalized_path, name, created_at, updated_at, archived_at
         FROM projects WHERE id = ? AND archived_at IS NULL`
      )
      .get(id)
    return row === undefined ? undefined : mapProject(row)
  }

  findByIdentity(hostId: string, normalizedPath: string): StoredProject | undefined {
    const row = this.database
      .prepare(
        `SELECT id, host_id, path, normalized_path, name, created_at, updated_at, archived_at
         FROM projects WHERE host_id = ? AND normalized_path = ?`
      )
      .get(hostId, normalizedPath)
    return row === undefined ? undefined : mapProject(row)
  }

  list(): StoredProject[] {
    return this.database
      .prepare(
        `SELECT id, host_id, path, normalized_path, name, created_at, updated_at, archived_at
         FROM projects WHERE archived_at IS NULL ORDER BY updated_at DESC, id ASC`
      )
      .all()
      .map(mapProject)
  }

  reactivate(id: string, path: string, name: string, updatedAt: number): void {
    this.database
      .prepare(
        `UPDATE projects SET path = ?, name = ?, updated_at = ?, archived_at = NULL WHERE id = ?`
      )
      .run(path, name, updatedAt, id)
  }

  archive(id: string, archivedAt: number): boolean {
    return this.database
      .prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archivedAt, archivedAt, id).changes > 0
  }
}

function mapProject(row: unknown): StoredProject {
  const parsed = projectRowSchema.parse(row)
  return {
    id: parsed.id,
    name: parsed.name,
    hostId: parsed.host_id,
    path: parsed.path,
    normalizedPath: parsed.normalized_path,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    ...(parsed.archived_at === null ? {} : { archivedAt: parsed.archived_at })
  }
}
