import type { RuntimeAdapter } from '@agent-gateway/core'
import { AdapterRegistry, RuntimeSessionManager } from '@agent-gateway/runtime'
import type { FastifyPluginAsync } from 'fastify'
import { workspaceFileRoutes } from '../features/files/routes.js'
import { WorkspaceFileService } from '../features/files/service.js'
import { WorkspaceFileWatchHub } from '../features/files/watch-hub.js'
import { gitRoutes } from '../features/git/routes.js'
import { GitCommandRunner } from '../features/git/runner.js'
import { GitService } from '../features/git/service.js'
import { GitWatchHub } from '../features/git/watch-hub.js'
import { ProjectRepository } from '../features/projects/repository.js'
import { projectRoutes } from '../features/projects/routes.js'
import { ProjectService } from '../features/projects/service.js'
import { ServerIdentityRepository } from '../features/server/repository.js'
import { serverRoutes } from '../features/server/routes.js'
import { SessionRepository } from '../features/sessions/repository.js'
import { SessionEventRepository } from '../features/sessions/event-repository.js'
import { sessionRoutes } from '../features/sessions/routes.js'
import { SessionService } from '../features/sessions/service.js'
import type { TerminalPtyFactory } from '../features/terminals/pty.js'
import { terminalRoutes } from '../features/terminals/routes.js'
import { TerminalService } from '../features/terminals/service.js'
import { openGatewayDatabase } from '../infrastructure/database.js'

export interface ApplicationPluginOptions {
  adapters: RuntimeAdapter[]
  databasePath: string
  environment: Record<string, string>
  terminalPtyFactory?: TerminalPtyFactory
  terminalRetentionMs?: number
  terminalOutputBufferBytes?: number
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
  const files = new WorkspaceFileService(projects)
  const fileWatches = new WorkspaceFileWatchHub(files, (error, projectId) =>
    server.log.error({ err: error, projectId }, 'Workspace file watcher failed')
  )
  const gitRunner = new GitCommandRunner(options.environment)
  const gitWatches = new GitWatchHub(projects, gitRunner, (error, projectId) =>
    server.log.error({ err: error, projectId }, 'Git watcher failed')
  )
  const git = new GitService(projects, gitRunner, (projectId) => gitWatches.notify(projectId))
  const terminals = new TerminalService({
    projects,
    environment: options.environment,
    ...(options.terminalPtyFactory ? { ptyFactory: options.terminalPtyFactory } : {}),
    ...(options.terminalRetentionMs === undefined
      ? {}
      : { retentionMs: options.terminalRetentionMs }),
    ...(options.terminalOutputBufferBytes === undefined
      ? {}
      : { outputBufferBytes: options.terminalOutputBufferBytes })
  })

  server.addHook('onClose', async () => {
    terminals.shutdown()
    await fileWatches.close()
    await gitWatches.close()
    await sessions.shutdown()
    database.close()
  })

  await server.register(serverRoutes, { identity, prefix: '/api/v1' })
  await server.register(projectRoutes, { projects, prefix: '/api/v1' })
  await server.register(workspaceFileRoutes, {
    files,
    watches: fileWatches,
    prefix: '/api/v1'
  })
  await server.register(gitRoutes, { git, watches: gitWatches, prefix: '/api/v1' })
  await server.register(terminalRoutes, { terminals, prefix: '/api/v1' })
  await server.register(sessionRoutes, { sessions, prefix: '/api/v1' })
}
