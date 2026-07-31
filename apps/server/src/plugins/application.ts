import type { RuntimeAdapter } from '@agent-gateway/core'
import { AdapterRegistry, RuntimeSessionManager } from '@agent-gateway/runtime'
import type { FastifyPluginAsync } from 'fastify'
import { ProjectRepository } from '../features/projects/repository.js'
import { projectRoutes } from '../features/projects/routes.js'
import { ProjectService } from '../features/projects/service.js'
import { ServerIdentityRepository } from '../features/server/repository.js'
import { serverRoutes } from '../features/server/routes.js'
import { SessionRepository } from '../features/sessions/repository.js'
import { SessionEventRepository } from '../features/sessions/event-repository.js'
import { sessionRoutes } from '../features/sessions/routes.js'
import { SessionService } from '../features/sessions/service.js'
import { openGatewayDatabase } from '../infrastructure/database.js'

export interface ApplicationPluginOptions {
  adapters: RuntimeAdapter[]
  databasePath: string
  environment: Record<string, string>
}

export const applicationPlugin: FastifyPluginAsync<ApplicationPluginOptions> = async (
  server,
  options
) => {
  const database = openGatewayDatabase(options.databasePath)
  const identity = new ServerIdentityRepository(database).getOrCreate()
  const projectsRepository = new ProjectRepository(database)
  const sessionsRepository = new SessionRepository(database)
  const sessionEventsRepository = new SessionEventRepository(database)
  sessionEventsRepository.discardOrphans()
  const runtime = new RuntimeSessionManager(
    new AdapterRegistry(options.adapters),
    sessionEventsRepository
  )
  const sessions = new SessionService(
    sessionsRepository,
    sessionEventsRepository,
    projectsRepository,
    runtime,
    options.environment,
    (error, sessionId) =>
      server.log.error(
        { err: error, ...(sessionId ? { sessionId } : {}) },
        'Session event observer failed'
      )
  )
  sessions.recoverInterruptedSessions()
  const projects = new ProjectService(
    projectsRepository,
    sessionsRepository,
    runtime,
    identity.id,
    options.environment
  )

  server.addHook('onClose', async () => {
    await sessions.shutdown()
    database.close()
  })

  await server.register(serverRoutes, { identity, prefix: '/api/v1' })
  await server.register(projectRoutes, { projects, prefix: '/api/v1' })
  await server.register(sessionRoutes, { sessions, prefix: '/api/v1' })
}
