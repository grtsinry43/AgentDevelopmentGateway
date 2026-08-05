import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { ZipArchive } from 'archiver'
import type { WorkspaceFileEvent } from '@agent-gateway/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { WorkspaceFileService } from './service.js'
import {
  workspaceDirectoryQuerySchema,
  workspaceDirectoryResponseSchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentResponseSchema,
  workspaceFileCreateRequestSchema,
  workspaceFileErrorResponses,
  workspaceFileMoveRequestSchema,
  workspaceFileWriteRequestSchema,
  workspaceFilesParamsSchema,
  workspaceFileSubscriptionParamsSchema,
  workspaceFileSubscriptionSchema
} from './schemas.js'
import type { WorkspaceFileWatchHub } from './watch-hub.js'

interface WorkspaceFileRoutesOptions {
  files: WorkspaceFileService
  watches: WorkspaceFileWatchHub
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000

export const workspaceFileRoutes: FastifyPluginAsyncZod<WorkspaceFileRoutesOptions> = async (
  server,
  options
) => {
  server.get(
    '/projects/:projectId/files',
    {
      schema: {
        params: workspaceFilesParamsSchema,
        querystring: workspaceDirectoryQuerySchema,
        response: { 200: workspaceDirectoryResponseSchema, ...workspaceFileErrorResponses }
      }
    },
    async (request) => options.files.list(request.params.projectId, request.query.path)
  )

  server.get(
    '/projects/:projectId/files/content',
    {
      schema: {
        params: workspaceFilesParamsSchema,
        querystring: workspaceFileContentQuerySchema,
        response: { 200: workspaceFileContentResponseSchema, ...workspaceFileErrorResponses }
      }
    },
    async (request) => options.files.read(request.params.projectId, request.query.path)
  )

  server.post(
    '/projects/:projectId/files',
    {
      schema: {
        params: workspaceFilesParamsSchema,
        body: workspaceFileCreateRequestSchema,
        response: { ...workspaceFileErrorResponses }
      }
    },
    async (request, reply) => {
      await options.files.create(request.params.projectId, request.body)
      reply.code(204)
    }
  )

  server.put(
    '/projects/:projectId/files/content',
    {
      schema: {
        params: workspaceFilesParamsSchema,
        body: workspaceFileWriteRequestSchema,
        response: { ...workspaceFileErrorResponses }
      }
    },
    async (request, reply) => {
      await options.files.write(request.params.projectId, request.body)
      reply.code(204)
    }
  )

  server.post(
    '/projects/:projectId/files/copy',
    {
      schema: {
        params: workspaceFilesParamsSchema,
        body: workspaceFileMoveRequestSchema,
        response: { ...workspaceFileErrorResponses }
      }
    },
    async (request, reply) => {
      await options.files.copy(request.params.projectId, request.body)
      reply.code(204)
    }
  )

  server.patch(
    '/projects/:projectId/files',
    {
      schema: {
        params: workspaceFilesParamsSchema,
        body: workspaceFileMoveRequestSchema,
        response: { ...workspaceFileErrorResponses }
      }
    },
    async (request, reply) => {
      await options.files.move(request.params.projectId, request.body)
      reply.code(204)
    }
  )

  server.delete(
    '/projects/:projectId/files',
    {
      schema: {
        params: workspaceFilesParamsSchema,
        querystring: workspaceFileContentQuerySchema,
        response: { ...workspaceFileErrorResponses }
      }
    },
    async (request, reply) => {
      await options.files.remove(request.params.projectId, request.query.path)
      reply.code(204)
    }
  )

  server.get(
    '/projects/:projectId/files/download',
    {
      schema: {
        params: workspaceFilesParamsSchema,
        querystring: workspaceDirectoryQuerySchema
      }
    },
    async (request, reply) => {
      const location = await options.files.downloadLocation(
        request.params.projectId,
        request.query.path
      )
      if (location.kind === 'directory') {
        const archive = new ZipArchive({ zlib: { level: 6 } })
        const stream = new PassThrough()
        archive.on('error', (error) => stream.destroy(error))
        archive.pipe(stream)
        void archive.directory(location.absolutePath, false).finalize()
        return reply.type('application/zip').send(stream)
      }
      return reply
        .header('content-disposition', `attachment; filename="${basename(location.relativePath)}"`)
        .type('application/octet-stream')
        .send(createReadStream(location.absolutePath))
    }
  )

  server.put(
    '/projects/:projectId/files/subscriptions/:subscriptionId',
    {
      schema: {
        params: workspaceFileSubscriptionParamsSchema,
        body: workspaceFileSubscriptionSchema,
        response: { ...workspaceFileErrorResponses }
      }
    },
    async (request, reply) => {
      await options.watches.update(
        request.params.projectId,
        request.params.subscriptionId,
        request.body.directories
      )
      reply.code(204)
    }
  )

  server.get(
    '/projects/:projectId/files/subscriptions/:subscriptionId/events',
    {
      schema: {
        params: workspaceFileSubscriptionParamsSchema
      }
    },
    async (request, reply) => {
      const events = await options.watches.open(
        request.params.projectId,
        request.params.subscriptionId
      )
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('connection', 'keep-alive')
        .send(Readable.from(encodeWorkspaceFileSse(events, SSE_HEARTBEAT_INTERVAL_MS)))
    }
  )
}

export async function* encodeWorkspaceFileSse(
  events: AsyncIterable<WorkspaceFileEvent>,
  heartbeatIntervalMs: number
): AsyncGenerator<string> {
  const iterator = events[Symbol.asyncIterator]()
  let pendingEvent = iterator.next()
  try {
    while (true) {
      const heartbeat = createHeartbeatTimer(heartbeatIntervalMs)
      const next = await Promise.race([
        pendingEvent.then((result) => ({ kind: 'event' as const, result })),
        heartbeat.promise
      ])
      heartbeat.cancel()
      if (next.kind === 'heartbeat') {
        yield ': heartbeat\n\n'
        continue
      }
      if (next.result.done) return
      yield `event: ${next.result.value.type}\ndata: ${JSON.stringify(next.result.value)}\n\n`
      pendingEvent = iterator.next()
    }
  } finally {
    void iterator.return?.().catch(() => undefined)
  }
}

function createHeartbeatTimer(delayMs: number): {
  promise: Promise<{ kind: 'heartbeat' }>
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'heartbeat' }), delayMs)
    }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
