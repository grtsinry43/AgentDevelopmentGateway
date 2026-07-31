import { Readable } from 'node:stream'
import type { RuntimeEvent } from '@agent-gateway/core'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { SessionService } from './service.js'
import {
  createSessionBodySchema,
  createSessionResponseSchema,
  inputAdmissionReceiptSchema,
  projectSessionsParamsSchema,
  sendSessionInputRequestSchema,
  sessionErrorResponses,
  sessionEventsQuerySchema,
  sessionListResponseSchema,
  sessionParamsSchema,
  sessionSchema
} from './schemas.js'

interface SessionRoutesOptions {
  sessions: SessionService
}

export const sessionRoutes: FastifyPluginAsyncZod<SessionRoutesOptions> = async (
  server,
  options
) => {
  server.get(
    '/projects/:projectId/sessions',
    {
      schema: {
        params: projectSessionsParamsSchema,
        response: { 200: sessionListResponseSchema, ...sessionErrorResponses }
      }
    },
    async (request) => ({ sessions: options.sessions.list(request.params.projectId) })
  )

  server.post(
    '/projects/:projectId/sessions',
    {
      schema: {
        params: projectSessionsParamsSchema,
        body: createSessionBodySchema,
        response: { 201: createSessionResponseSchema, ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      const result = await options.sessions.create(request.params.projectId, request.body)
      return reply.code(201).send(result)
    }
  )

  server.get(
    '/sessions/:sessionId',
    {
      schema: {
        params: sessionParamsSchema,
        response: { 200: sessionSchema, ...sessionErrorResponses }
      }
    },
    async (request) => options.sessions.get(request.params.sessionId)
  )

  server.post(
    '/sessions/:sessionId/inputs',
    {
      schema: {
        params: sessionParamsSchema,
        body: sendSessionInputRequestSchema,
        response: { 202: inputAdmissionReceiptSchema, ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      const receipt = await options.sessions.send(request.params.sessionId, request.body)
      return reply.code(202).send(receipt)
    }
  )

  server.get(
    '/sessions/:sessionId/events',
    {
      schema: {
        params: sessionParamsSchema,
        querystring: sessionEventsQuerySchema
      }
    },
    (request, reply) => {
      const headerCursor = parseEventCursor(request.headers['last-event-id'])
      const afterSequence = Math.max(request.query.after, headerCursor)
      const stream = Readable.from(encodeSse(options.sessions.events(request.params.sessionId, afterSequence)))
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('connection', 'keep-alive')
        .send(stream)
    }
  )
}

async function* encodeSse(events: AsyncIterable<RuntimeEvent>): AsyncGenerator<string> {
  for await (const event of events) {
    yield `id: ${event.sequence}\nevent: runtime.event\ndata: ${JSON.stringify(event)}\n\n`
  }
}

function parseEventCursor(value: string | string[] | undefined): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0
  return Number(value)
}
