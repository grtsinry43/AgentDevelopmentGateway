import { Readable } from 'node:stream'
import type { GitEvent } from '@agent-gateway/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitDiffQuerySchema,
  gitDiffResponseSchema,
  gitErrorResponses,
  gitPathsRequestSchema,
  gitRepositoryStateSchema,
  projectGitParamsSchema
} from './schemas.js'
import type { GitService } from './service.js'
import type { GitWatchHub } from './watch-hub.js'

interface GitRoutesOptions {
  git: GitService
  watches: GitWatchHub
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000

export const gitRoutes: FastifyPluginAsyncZod<GitRoutesOptions> = async (server, options) => {
  server.get(
    '/projects/:projectId/git',
    {
      schema: {
        params: projectGitParamsSchema,
        response: { 200: gitRepositoryStateSchema, ...gitErrorResponses }
      }
    },
    async (request) => options.git.status(request.params.projectId)
  )

  server.get(
    '/projects/:projectId/git/diff',
    {
      schema: {
        params: projectGitParamsSchema,
        querystring: gitDiffQuerySchema,
        response: { 200: gitDiffResponseSchema, ...gitErrorResponses }
      }
    },
    async (request) =>
      options.git.diff(request.params.projectId, request.query.path, request.query.area)
  )

  server.post(
    '/projects/:projectId/git/stage',
    {
      schema: {
        params: projectGitParamsSchema,
        body: gitPathsRequestSchema,
        response: { ...gitErrorResponses }
      }
    },
    async (request, reply) => {
      await options.git.stage(request.params.projectId, request.body.paths)
      reply.code(204)
    }
  )

  server.post(
    '/projects/:projectId/git/unstage',
    {
      schema: {
        params: projectGitParamsSchema,
        body: gitPathsRequestSchema,
        response: { ...gitErrorResponses }
      }
    },
    async (request, reply) => {
      await options.git.unstage(request.params.projectId, request.body.paths)
      reply.code(204)
    }
  )

  server.post(
    '/projects/:projectId/git/commit',
    {
      schema: {
        params: projectGitParamsSchema,
        body: gitCommitRequestSchema,
        response: { 201: gitCommitResponseSchema, ...gitErrorResponses }
      }
    },
    async (request, reply) => {
      const committed = await options.git.commit(request.params.projectId, request.body.message)
      return reply.code(201).send(committed)
    }
  )

  server.get(
    '/projects/:projectId/git/events',
    { schema: { params: projectGitParamsSchema } },
    async (request, reply) => {
      const events = await options.watches.open(request.params.projectId)
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('connection', 'keep-alive')
        .send(Readable.from(encodeGitSse(events, SSE_HEARTBEAT_INTERVAL_MS)))
    }
  )
}

export async function* encodeGitSse(
  events: AsyncIterable<GitEvent>,
  heartbeatIntervalMs: number
): AsyncGenerator<string> {
  const iterator = events[Symbol.asyncIterator]()
  let pendingEvent = iterator.next()
  try {
    yield ': connected\n\n'
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
