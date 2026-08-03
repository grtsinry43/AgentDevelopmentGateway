import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename, isAbsolute, normalize, parse } from 'node:path'
import type { AdapterId, ModelCatalog } from '@agent-gateway/core'
import type { RuntimeSlashCommands } from '@agent-gateway/runtime'
import type { RuntimeAdapterAvailability, RuntimeSessionManager } from '@agent-gateway/runtime'
import { GatewayHttpError } from '../../http/errors.js'
import type { SessionRepository } from '../sessions/repository.js'
import type { CreateProjectBody, ProjectResponse } from './schemas.js'
import { ProjectRepository, type StoredProject } from './repository.js'

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly runtime: RuntimeSessionManager,
    private readonly hostId: string,
    private readonly hostEnvironment: Record<string, string>
  ) {}

  async create(input: CreateProjectBody): Promise<ProjectResponse> {
    const normalizedPath = normalizeProjectPath(input.path)
    const now = Date.now()
    const existing = this.repository.findByIdentity(this.hostId, normalizedPath)
    if (existing) {
      if (existing.archivedAt === undefined) {
        throw new GatewayHttpError(409, 'PROJECT_CONFLICT', 'Project is already registered')
      }
      const name = input.name ?? basename(normalizedPath)
      this.repository.reactivate(existing.id, normalizedPath, name, now)
      return this.toResponse({
        ...existing,
        path: normalizedPath,
        name,
        updatedAt: now,
        archivedAt: undefined
      })
    }
    const project: StoredProject = {
      id: randomUUID(),
      hostId: this.hostId,
      path: normalizedPath,
      normalizedPath,
      name: input.name ?? basename(normalizedPath),
      createdAt: now,
      updatedAt: now
    }
    try {
      this.repository.create(project)
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new GatewayHttpError(409, 'PROJECT_CONFLICT', 'Project is already registered')
      }
      throw error
    }
    return this.toResponse(project)
  }

  async list(): Promise<ProjectResponse[]> {
    return Promise.all(this.repository.list().map((project) => this.toResponse(project)))
  }

  async get(id: string): Promise<ProjectResponse> {
    return this.toResponse(this.require(id))
  }

  require(id: string): StoredProject {
    const project = this.repository.findById(id)
    if (!project) throw new GatewayHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found')
    return project
  }

  inspectAdapters(id: string): Promise<RuntimeAdapterAvailability[]> {
    const project = this.require(id)
    return this.runtime.inspectAdapters({
      hostId: project.hostId,
      platform: process.platform,
      env: this.hostEnvironment
    })
  }

  listModels(id: string, adapterId: AdapterId, installationPath?: string): Promise<ModelCatalog> {
    const project = this.require(id)
    return this.runtime.listModels({
      host: {
        hostId: project.hostId,
        platform: process.platform,
        env: this.hostEnvironment
      },
      projectPath: project.path,
      adapterId,
      installationPath
    })
  }

  listCommands(
    id: string,
    adapterId: AdapterId,
    installationPath?: string
  ): Promise<RuntimeSlashCommands> {
    const project = this.require(id)
    return this.runtime.listCommands({
      host: {
        hostId: project.hostId,
        platform: process.platform,
        env: this.hostEnvironment
      },
      projectPath: project.path,
      adapterId,
      installationPath
    })
  }

  remove(id: string): void {
    this.require(id)
    if (this.sessions.hasActiveForProject(id)) {
      throw new GatewayHttpError(
        409,
        'PROJECT_HAS_ACTIVE_SESSIONS',
        'Project has active sessions'
      )
    }
    this.repository.archive(id, Date.now())
  }

  private async toResponse(project: StoredProject): Promise<ProjectResponse> {
    return {
      id: project.id,
      name: project.name,
      hostId: project.hostId,
      path: project.path,
      availability: await projectAvailability(project.path),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    }
  }
}

function normalizeProjectPath(input: string): string {
  if (!isAbsolute(input)) {
    throw new GatewayHttpError(400, 'VALIDATION_ERROR', 'Project path must be absolute')
  }
  const normalized = normalize(input)
  const root = parse(normalized).root
  return normalized === root ? normalized : normalized.replace(/[\\/]+$/, '')
}

async function projectAvailability(path: string): Promise<ProjectResponse['availability']> {
  try {
    await access(path, constants.R_OK)
    return (await stat(path)).isDirectory() ? 'available' : 'missing'
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return 'missing'
    return 'unreachable'
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
}
